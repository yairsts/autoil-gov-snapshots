const {createHash, randomUUID} = require('node:crypto');
const {once} = require('node:events');
const {createReadStream, createWriteStream} = require('node:fs');
const {mkdtemp, rm, stat} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {Readable, Transform} = require('node:stream');
const {finished, pipeline} = require('node:stream/promises');
const {createGzip} = require('node:zlib');
const {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const {parse} = require('csv-parse');
const {
  MANIFEST_KEY,
  SHARD_COUNT,
  shardKey,
  shardNumber,
} = require('../utils/privateSnapshotLayout');

const RESOURCE_ID = '053cea08-09bc-40ec-8f7a-156f0677aff3';
const METADATA_URL = `https://data.gov.il/api/3/action/resource_show?id=${RESOURCE_ID}`;
const USER_AGENT = 'datagov-external-client';
const MIN_ROWS = 3_000_000;
const MAX_SNAPSHOT_BYTES = 4_000_000_000;
const NUMBER_FIELDS = new Set([
  'tozeret_cd', 'degem_cd', 'ramat_eivzur_betihuty', 'kvutzat_zihum',
  'shnat_yitzur', 'tzeva_cd', 'horaat_rishum',
]);

function privateVehicleRow(row) {
  const plate = String(row.mispar_rechev || '');
  if (!/^\d{7,8}$/.test(plate)) throw new Error('Invalid vehicle plate in CSV');
  // The app requires a numeric top-level vehicle id; the CSV has no CKAN _id.
  const record = {_id: Number(plate)};
  for (const [key, value] of Object.entries(row)) {
    if (NUMBER_FIELDS.has(key) && value !== '') {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`Invalid ${key} in CSV`);
      record[key] = number;
    } else {
      record[key] = value === '' ? null : value;
    }
  }
  return record;
}

async function buildSnapshot(source, directory, {minRows = MIN_ROWS} = {}) {
  const decoder = new TextDecoder('windows-1255');
  const digest = createHash('sha256');
  let bytes = 0;
  let count = 0;
  const paths = Array.from({length: SHARD_COUNT}, (_, number) => (
    join(directory, `${String(number).padStart(3, '0')}.jsonl.gz`)
  ));
  const outputs = paths.map((path) => {
    const gzip = createGzip();
    const file = createWriteStream(path);
    gzip.pipe(file);
    return {gzip, file};
  });
  const decode = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      digest.update(chunk);
      callback(null, decoder.decode(chunk, {stream: true}));
    },
    flush(callback) {
      callback(null, decoder.decode());
    },
  });
  const csv = parse({
    columns: true,
    delimiter: '|',
    skip_empty_lines: true,
    // The source contains values such as גפ"מ with an unescaped quote.
    relax_quotes: true,
  });

  try {
    await pipeline(source, decode, csv, async (records) => {
      for await (const row of records) {
        const record = privateVehicleRow(row);
        const output = outputs[shardNumber(record.mispar_rechev)].gzip;
        if (!output.write(`${JSON.stringify(record)}\n`)) {
          await once(output, 'drain');
        }
        count += 1;
      }
    });
    if (count < minRows) throw new Error(`Snapshot has only ${count} rows`);
    for (const {gzip} of outputs) gzip.end();
    await Promise.all(outputs.map(({file}) => finished(file)));
    const sizes = await Promise.all(paths.map(async (path) => (await stat(path)).size));
    const storedBytes = sizes.reduce((sum, size) => sum + size, 0);
    if (storedBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(`Snapshot exceeds size limit: ${storedBytes} bytes`);
    }
    return {paths, count, bytes, storedBytes, sha256: digest.digest('hex')};
  } catch (error) {
    for (const {gzip, file} of outputs) {
      gzip.destroy();
      file.destroy();
    }
    throw error;
  }
}

function downloadUrl(metadata) {
  const url = new URL(metadata.url);
  if (url.protocol !== 'https:' ||
      !['e.data.gov.il', 'data.gov.il'].includes(url.hostname) ||
      !url.pathname.includes(RESOURCE_ID)) {
    throw new Error('Unexpected private vehicle download URL');
  }
  // The metadata points at e.data.gov.il, which currently redirects to login.
  url.hostname = 'data.gov.il';
  return url.toString();
}

async function sourceMetadata() {
  const response = await fetch(METADATA_URL, {
    headers: {'User-Agent': USER_AGENT},
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Metadata HTTP ${response.status}`);
  const body = await response.json();
  const metadata = body.result;
  if (!body.success || metadata?.id !== RESOURCE_ID ||
      !/^[a-f0-9]{32}$/.test(metadata.hash) ||
      !Number.isSafeInteger(metadata.size) || metadata.size < 100_000_000) {
    throw new Error('Invalid private vehicle resource metadata');
  }
  return metadata;
}

function storageClient() {
  const accountId = process.env.PRIVATE_SNAPSHOT_R2_ACCOUNT_ID;
  const accessKeyId = process.env.PRIVATE_SNAPSHOT_R2_WRITE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PRIVATE_SNAPSHOT_R2_WRITE_SECRET_ACCESS_KEY;
  const bucket = process.env.PRIVATE_SNAPSHOT_R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('Private vehicle R2 write credentials are missing');
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

async function currentManifest(client, bucket) {
  try {
    const object = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: MANIFEST_KEY,
    }));
    return JSON.parse(Buffer.from(await object.Body.transformToByteArray()).toString());
  } catch (error) {
    if (['NoSuchKey', 'NotFound'].includes(error.name)) return null;
    throw error;
  }
}

async function publishSnapshot(client, bucket, snapshot, metadata, previous) {
  const version = randomUUID();
  const uploaded = [];
  let manifestAttempted = false;
  const manifest = {
    version,
    previousVersion: previous?.version || null,
    sourceHash: metadata.hash,
    sourceLastModified: metadata.last_modified,
    downloadedAt: new Date().toISOString(),
    count: snapshot.count,
    sourceBytes: snapshot.bytes,
    storedBytes: snapshot.storedBytes,
    sha256: snapshot.sha256,
    shardCount: SHARD_COUNT,
  };
  try {
    for (let number = 0; number < SHARD_COUNT; number++) {
      const path = snapshot.paths[number];
      const key = shardKey(version, number);
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: (await stat(path)).size,
        ContentType: 'application/x-ndjson',
      }));
      uploaded.push({Key: key});
    }
    manifestAttempted = true;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: MANIFEST_KEY,
      Body: JSON.stringify(manifest),
      ContentType: 'application/json',
    }));
    return manifest;
  } catch (error) {
    // A failed response to the manifest PUT may still mean it was committed.
    // Never delete shards that the current manifest could already reference.
    if (!manifestAttempted && uploaded.length) {
      try {
        await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {Objects: uploaded},
        }));
      } catch (cleanupError) {
        console.warn('Partial snapshot cleanup failed:', cleanupError.message);
      }
    }
    throw error;
  }
}

async function deleteOldSnapshot(client, bucket, version) {
  if (!version) return;
  await client.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: {Objects: Array.from({length: SHARD_COUNT}, (_, number) => ({
      Key: shardKey(version, number),
    }))},
  }));
}

async function sync({dryRun = false, beforePublish = () => {}, recordVerification = false} = {}) {
  const storage = dryRun ? null : storageClient();
  const metadata = await sourceMetadata();
  const previous = dryRun
    ? null
    : await currentManifest(storage.client, storage.bucket);
  if (previous?.sourceHash === metadata.hash) {
    if (recordVerification) {
      await storage.client.send(new PutObjectCommand({Bucket: storage.bucket, Key: MANIFEST_KEY,
        Body: JSON.stringify({...previous, sourceLastModified: metadata.last_modified,
          sourceCheckedAt: new Date().toISOString()}), ContentType: 'application/json'}));
    }
    console.log('Private vehicle source is unchanged');
    return;
  }
  const response = await fetch(downloadUrl(metadata), {
    headers: {'User-Agent': USER_AGENT},
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/csv') ||
      new URL(response.url).hostname !== 'data.gov.il') {
    throw new Error(`Private vehicle download failed: HTTP ${response.status}`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'autoil-private-vehicles-'));
  try {
    const snapshot = await buildSnapshot(Readable.fromWeb(response.body), directory);
    if (snapshot.bytes !== metadata.size) {
      throw new Error(`Download size mismatch: ${snapshot.bytes} != ${metadata.size}`);
    }
    if (previous && snapshot.count < previous.count * 0.95) {
      throw new Error(`Row count dropped from ${previous.count} to ${snapshot.count}`);
    }
    if (dryRun) {
      console.log(JSON.stringify({
        count: snapshot.count,
        sourceBytes: snapshot.bytes,
        storedBytes: snapshot.storedBytes,
        sha256: snapshot.sha256,
      }));
      return;
    }
    beforePublish(snapshot);
    const manifest = await publishSnapshot(
      storage.client, storage.bucket, snapshot, metadata, previous,
    );
    console.log(`Published ${manifest.count} vehicles from ${manifest.sourceBytes} bytes`);
    try {
      await deleteOldSnapshot(
        storage.client, storage.bucket, previous?.previousVersion,
      );
    } catch (error) {
      console.warn('Old snapshot cleanup failed:', error.message);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

if (require.main === module) {
  sync({dryRun: process.argv.includes('--dry-run')}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  sync,
  buildSnapshot,
  downloadUrl,
  privateVehicleRow,
  publishSnapshot,
};
