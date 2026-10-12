const {randomUUID, createHash} = require('node:crypto');
const {appendFile} = require('node:fs/promises');
const {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const {RESOURCES} = require('../constants/govResources');
const layout = require('../utils/govSnapshotLayout');
const privateLayout = require('../utils/privateSnapshotLayout');
const {manifestStatus} = require('./snapshot-status');
const {bucketBytes} = require('./sync-gov-resources');

const SOURCE_BUCKET = 'autoil-private-vehicle-snapshots';
const TARGET_BUCKET = 'autoil-nonprod-vehicle-snapshots';
const MAX_COMBINED_BYTES = 8_000_000_000;

function storageClient(bucket, accessKeyId, secretAccessKey) {
  const accountId = process.env.PRIVATE_SNAPSHOT_R2_ACCOUNT_ID;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error('R2 credentials are missing');
  return {bucket, client: new S3Client({
    region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {accessKeyId, secretAccessKey},
  })};
}

function manifestKey(resource) {
  return resource.legacyPrivate ? privateLayout.MANIFEST_KEY : layout.manifestKey(resource);
}

function shardKey(resource, version, number) {
  return resource.legacyPrivate
    ? privateLayout.shardKey(version, number) : layout.shardKey(resource, version, number);
}

async function readManifest(storage, name, resource, {optional = false} = {}) {
  try {
    const object = await storage.client.send(new GetObjectCommand({
      Bucket: storage.bucket, Key: manifestKey(resource),
    }), {abortSignal: AbortSignal.timeout(30_000)});
    const manifest = JSON.parse(await object.Body.transformToString());
    manifestStatus(name, resource, manifest);
    if ((!resource.legacyPrivate && manifest.resourceId !== resource.id) ||
        !Number.isSafeInteger(manifest.storedBytes) || manifest.storedBytes < 1 ||
        (manifest.previousVersion && !/^[a-f0-9-]{36}$/.test(manifest.previousVersion))) {
      throw new Error('Invalid copy manifest');
    }
    return manifest;
  } catch (error) {
    if (optional && ['NoSuchKey', 'NotFound'].includes(error.name)) return null;
    throw error;
  }
}

function checkBudget(sourceBytes, targetBytes, incomingBytes) {
  const sizes = [sourceBytes, targetBytes, incomingBytes];
  if (sizes.some((size) => !Number.isSafeInteger(size) || size < 0)) {
    throw new Error('Invalid snapshot storage inventory');
  }
  if (sizes.reduce((total, size) => total + size, 0) > MAX_COMBINED_BYTES) {
    throw new Error('Copy would exceed the combined 8 GB snapshot budget');
  }
}

async function readShard(storage, key) {
  const object = await storage.client.send(new GetObjectCommand({Bucket: storage.bucket, Key: key}),
    {abortSignal: AbortSignal.timeout(60_000)});
  if (!Number.isSafeInteger(object.ContentLength) || object.ContentLength < 1 ||
      object.ContentLength > 128_000_000) throw new Error('Invalid snapshot shard size');
  const bytes = Buffer.from(await object.Body.transformToByteArray());
  if (bytes.length !== object.ContentLength) throw new Error('Incomplete snapshot shard');
  return bytes;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function copyShard(source, target, sourceKey, targetKey) {
  const bytes = await readShard(source, sourceKey);
  await target.client.send(new PutObjectCommand({
    Bucket: target.bucket, Key: targetKey, Body: bytes,
    ContentLength: bytes.length, ContentType: 'application/x-ndjson',
  }), {abortSignal: AbortSignal.timeout(60_000)});
  const copied = await readShard(target, targetKey);
  if (digest(bytes) !== digest(copied)) throw new Error('Copied shard checksum mismatch');
  return bytes.length;
}

async function retireVersion(target, resource, version) {
  if (!version) return;
  const objects = Array.from({length: resource.shardCount}, (_, number) => ({
    Key: shardKey(resource, version, number),
  }));
  const result = await target.client.send(new DeleteObjectsCommand({
    Bucket: target.bucket, Delete: {Objects: objects},
  }));
  if (result.Errors?.length) throw new Error('Old non-production snapshot cleanup failed');
}

async function copyShards(source, target, resource, manifest, version) {
  let storedBytes = 0;
  try {
    for (let number = 0; number < resource.shardCount; number++) {
      storedBytes += await copyShard(source, target,
        shardKey(resource, manifest.version, number), shardKey(resource, version, number));
    }
    if (storedBytes !== manifest.storedBytes) throw new Error('Copied snapshot size mismatch');
    return storedBytes;
  } catch (error) {
    try { await retireVersion(target, resource, version); }
    catch { console.warn('Partial non-production copy cleanup failed'); }
    throw error;
  }
}

async function publishManifest(target, resource, manifest) {
  // Publish only after every immutable shard has been read back and verified.
  await target.client.send(new PutObjectCommand({
    Bucket: target.bucket, Key: manifestKey(resource),
    Body: JSON.stringify(manifest), ContentType: 'application/json',
  }), {abortSignal: AbortSignal.timeout(30_000)});
}

async function copyResource(source, target, name, resource, manifest) {
  const previous = await readManifest(target, name, resource, {optional: true});
  const version = randomUUID();
  const storedBytes = await copyShards(source, target, resource, manifest, version);
  const copied = {...manifest, version, previousVersion: previous?.version || null,
    previousStoredBytes: previous?.storedBytes || 0, copiedAt: new Date().toISOString()};
  await publishManifest(target, resource, copied);
  await retireVersion(target, resource, previous?.previousVersion);
  console.log(`Copied ${name}: ${copied.count} rows, ${storedBytes} bytes`);
  return copied;
}

async function copySnapshots(source, target) {
  if (source.bucket !== SOURCE_BUCKET || target.bucket !== TARGET_BUCKET) {
    throw new Error('Copy is restricted to Production → non-production');
  }
  const manifests = [];
  for (const [name, resource] of Object.entries(RESOURCES)) {
    manifests.push({name, resource, manifest: await readManifest(source, name, resource)});
  }
  const incomingBytes = manifests.reduce((sum, entry) => sum + entry.manifest.storedBytes, 0);
  checkBudget(await bucketBytes(source), await bucketBytes(target), incomingBytes);
  const rows = [];
  for (const {name, resource, manifest} of manifests) {
    const copied = await copyResource(source, target, name, resource, manifest);
    rows.push(`| ${name} | ${copied.count} | ${copied.downloadedAt} | ${copied.copiedAt} |`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      '## Dev / Stage snapshots\n\nAll shards were copied and verified. Production was read only.\n\n' +
      '| Dataset | Rows | Source downloaded | Copied |\n| --- | ---: | --- | --- |\n' + rows.join('\n') + '\n');
  }
}

if (require.main === module) {
  const source = storageClient(SOURCE_BUCKET,
    process.env.SNAPSHOT_SOURCE_READ_ACCESS_KEY_ID, process.env.SNAPSHOT_SOURCE_READ_SECRET_ACCESS_KEY);
  const target = storageClient(TARGET_BUCKET,
    process.env.NONPROD_R2_WRITE_ACCESS_KEY_ID, process.env.NONPROD_R2_WRITE_SECRET_ACCESS_KEY);
  copySnapshots(source, target).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {checkBudget, copyResource, copySnapshots, SOURCE_BUCKET, TARGET_BUCKET};
