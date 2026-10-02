const {randomUUID} = require('node:crypto');
const {createReadStream} = require('node:fs');
const {mkdtemp, rm, stat} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {Readable} = require('node:stream');
const {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const {buildSnapshot, normalizeRow} = require('../utils/govSnapshotBuilder');
const {sync: syncPrivate} = require('./sync-private-vehicles');
const {RESOURCES} = require('../constants/govResources');
const {manifestKey, shardKey} = require('../utils/govSnapshotLayout');

const USER_AGENT = 'datagov-external-client';
const MAX_BUCKET_BYTES = 8_000_000_000;

async function bucketBytes(storage) {
  let total = 0;
  let continuation;
  do {
    const page = await storage.client.send(new ListObjectsV2Command({
      Bucket: storage.bucket, ...(continuation && {ContinuationToken: continuation}),
    }));
    for (const object of page.Contents || []) total += object.Size;
    continuation = page.IsTruncated ? page.NextContinuationToken : null;
    if (page.IsTruncated && !continuation) throw new Error('Incomplete R2 storage inventory');
  } while (continuation);
  return total;
}

function reserveSpace(storage, newBytes) {
  if (!Number.isSafeInteger(storage.usedBytes) || storage.usedBytes < 0 ||
      !Number.isSafeInteger(newBytes) || newBytes < 0) {
    throw new Error('Invalid snapshot storage size');
  }
  if (storage.usedBytes + newBytes > MAX_BUCKET_BYTES) {
    throw new Error('Update would exceed the 8 GB snapshot bucket budget');
  }
  // Conservatively include reserved bytes even if a failed upload is cleaned.
  // The next run inventories actual objects, including any orphaned versions.
  storage.usedBytes += newBytes;
}

function downloadUrl(resource, metadata) {
  const url = new URL(metadata.url);
  if (url.protocol !== 'https:' ||
      !['e.data.gov.il', 'data.gov.il'].includes(url.hostname) ||
      !url.pathname.includes(resource.id)) {
    throw new Error('Unexpected government download URL');
  }
  url.hostname = 'data.gov.il';
  return url.toString();
}

function sourceUpdatedAt(metadata) {
  const value = metadata.last_modified;
  const timestamp = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid government update time');
  return new Date(timestamp).toISOString();
}

async function sourceMetadata(resource) {
  const url = `https://data.gov.il/api/3/action/resource_show?id=${resource.id}`;
  const response = await fetch(url, {
    headers: {'User-Agent': USER_AGENT},
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Metadata HTTP ${response.status}`);
  const body = await response.json();
  const metadata = body.result;
  if (!body.success || metadata?.id !== resource.id ||
      !/^[a-f0-9]{32}$/.test(metadata.hash) ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < resource.minSourceBytes) {
    throw new Error('Invalid government resource metadata');
  }
  return metadata;
}

function storageClient() {
  const accountId = process.env.PRIVATE_SNAPSHOT_R2_ACCOUNT_ID;
  const accessKeyId = process.env.PRIVATE_SNAPSHOT_R2_WRITE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PRIVATE_SNAPSHOT_R2_WRITE_SECRET_ACCESS_KEY;
  const bucket = process.env.PRIVATE_SNAPSHOT_R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('R2 write credentials are missing');
  }
  return {
    bucket,
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {accessKeyId, secretAccessKey},
    }),
  };
}

async function currentManifest(client, bucket, resource) {
  try {
    const object = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: manifestKey(resource),
    }));
    const manifest = JSON.parse(Buffer.from(await object.Body.transformToByteArray()).toString());
    if (manifest.resourceId !== resource.id ||
        !/^[a-f0-9-]{36}$/.test(manifest.version) ||
        (manifest.previousVersion &&
          !/^[a-f0-9-]{36}$/.test(manifest.previousVersion)) ||
        manifest.shardCount !== resource.shardCount ||
        !Number.isInteger(manifest.count) || manifest.count < resource.minRows) {
      throw new Error('Invalid current government snapshot manifest');
    }
    return manifest;
  } catch (error) {
    if (['NoSuchKey', 'NotFound'].includes(error.name)) return null;
    throw error;
  }
}

function snapshotManifest(resource, snapshot, metadata, previous) {
  return {
    resourceId: resource.id,
    layoutVersion: resource.layoutVersion,
    version: randomUUID(),
    previousVersion: previous?.version || null,
    previousStoredBytes: previous?.storedBytes || 0,
    sourceHash: metadata.hash,
    sourceLastModified: sourceUpdatedAt(metadata),
    downloadedAt: new Date().toISOString(),
    sourceCheckedAt: new Date().toISOString(),
    count: snapshot.count,
    sourceBytes: snapshot.bytes,
    storedBytes: snapshot.storedBytes,
    sha256: snapshot.sha256,
    shardCount: resource.shardCount,
  };
}

async function uploadShards(client, bucket, resource, snapshot, version, uploaded) {
  for (let number = 0; number < resource.shardCount; number++) {
    const path = snapshot.paths[number];
    const key = shardKey(resource, version, number);
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: createReadStream(path),
      ContentLength: (await stat(path)).size, ContentType: 'application/x-ndjson',
    }));
    uploaded.push({Key: key});
  }
}

async function cleanPartialUpload(client, bucket, uploaded) {
  if (!uploaded.length) return;
  try {
    await client.send(new DeleteObjectsCommand({Bucket: bucket, Delete: {Objects: uploaded}}));
  } catch (error) { console.warn('Partial snapshot cleanup failed:', error.message); }
}

async function publishSnapshot(client, bucket, resource, snapshot, metadata, previous) {
  const manifest = snapshotManifest(resource, snapshot, metadata, previous);
  const uploaded = [];
  let manifestAttempted = false;
  try {
    await uploadShards(client, bucket, resource, snapshot, manifest.version, uploaded);
    manifestAttempted = true;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: manifestKey(resource),
      Body: JSON.stringify(manifest),
      ContentType: 'application/json',
    }));
    return manifest;
  } catch (error) {
    if (!manifestAttempted) await cleanPartialUpload(client, bucket, uploaded);
    throw error;
  }
}

async function deleteOldSnapshot(client, bucket, resource, version) {
  if (!version) return;
  const objects = Array.from({length: resource.shardCount}, (_, number) => ({
    Key: shardKey(resource, version, number),
  }));
  await client.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: {Objects: objects},
  }));
}

async function downloadSource(resource, metadata) {
  const response = await fetch(downloadUrl(resource, metadata), {
    headers: {'User-Agent': USER_AGENT},
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/csv') ||
      new URL(response.url).hostname !== 'data.gov.il') {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  return Readable.fromWeb(response.body);
}

function validateSnapshot(snapshot, metadata, previous) {
  if (snapshot.bytes !== metadata.size) {
    throw new Error(`Download size mismatch: ${snapshot.bytes} != ${metadata.size}`);
  }
  if (previous && snapshot.count < previous.count * 0.95) {
    throw new Error(`Row count dropped from ${previous.count} to ${snapshot.count}`);
  }
}

async function retireOldVersion(storage, resource, previous) {
  try {
    await deleteOldSnapshot(
      storage.client, storage.bucket, resource, previous?.previousVersion,
    );
  } catch (error) {
    console.warn('Old snapshot cleanup failed:', error.message);
  }
}

async function syncResource(resource, storage, {dryRun = false} = {}) {
  const metadata = await sourceMetadata(resource);
  const previous = dryRun
    ? null
    : await currentManifest(storage.client, storage.bucket, resource);
  // The original price pilot used untrimmed model names in its hash keys.
  // Rebuild that one layout once; unchanged compatible datasets stay put.
  if (previous?.sourceHash === metadata.hash &&
      (previous.layoutVersion || 1) === resource.layoutVersion) {
    await storage.client.send(new PutObjectCommand({
      Bucket: storage.bucket, Key: manifestKey(resource),
      Body: JSON.stringify({...previous, sourceLastModified: sourceUpdatedAt(metadata),
        sourceCheckedAt: new Date().toISOString()}), ContentType: 'application/json',
    }));
    console.log(`${resource.id}: source is unchanged; verification time updated`);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'autoil-gov-resource-'));
  try {
    const source = await downloadSource(resource, metadata);
    const snapshot = await buildSnapshot(resource, source, directory);
    validateSnapshot(snapshot, metadata, previous);
    if (dryRun) {
      console.log(JSON.stringify({resourceId: resource.id, ...snapshot, paths: undefined}));
      return;
    }
    reserveSpace(storage, snapshot.storedBytes);
    const manifest = await publishSnapshot(
      storage.client, storage.bucket, resource, snapshot, metadata, previous,
    );
    console.log(`Published ${resource.id}: ${manifest.count} rows, ${manifest.storedBytes} bytes`);
    await retireOldVersion(storage, resource, previous);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function scheduledResource(resource, date) {
  return resource.refresh === 'daily' || date.getUTCDay() === 0;
}

function selectedResources({scheduled = false, resourceName, date = new Date()} = {}) {
  if (resourceName && !RESOURCES[resourceName]) throw new Error(`Unknown resource: ${resourceName}`);
  return Object.entries(RESOURCES).filter(([name, resource]) => (
    (!resourceName || name === resourceName) && (!scheduled || scheduledResource(resource, date))
  ));
}

async function sync({dryRun = false, ...selection} = {}) {
  const storage = dryRun ? null : storageClient();
  if (storage) {
    storage.usedBytes = await bucketBytes(storage);
    console.log(`R2 bucket: ${storage.usedBytes} bytes; update budget: ${MAX_BUCKET_BYTES} bytes`);
  }
  const failures = [];
  for (const [name, resource] of selectedResources(selection)) {
    try {
      console.log(`Syncing ${name} (${resource.refresh})`);
      if (resource.legacyPrivate) await syncPrivate({dryRun, recordVerification: true,
        beforePublish: (snapshot) => reserveSpace(storage, snapshot.storedBytes)});
      else await syncResource(resource, storage, {dryRun});
    } catch (error) {
      failures.push(name);
      console.error(`${name}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Failed resources: ${failures.join(', ')}`);
}

if (require.main === module) {
  const resourceArg = process.argv.find((arg) => arg.startsWith('--resource='));
  sync({dryRun: process.argv.includes('--dry-run'), scheduled: process.argv.includes('--scheduled'),
    resourceName: resourceArg?.slice('--resource='.length)}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildSnapshot,
  normalizeRow,
  downloadUrl,
  publishSnapshot,
  syncResource,
  selectedResources,
  sync,
  reserveSpace,
};
