const {readFile, writeFile, appendFile} = require('node:fs/promises');
const {S3Client, GetObjectCommand} = require('@aws-sdk/client-s3');
const {RESOURCES} = require('../constants/govResources');
const {manifestKey} = require('../utils/govSnapshotLayout');
const {MANIFEST_KEY} = require('../utils/privateSnapshotLayout');

function storageClient() {
  const accountId = process.env.PRIVATE_SNAPSHOT_R2_ACCOUNT_ID;
  const accessKeyId = process.env.PRIVATE_SNAPSHOT_R2_WRITE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PRIVATE_SNAPSHOT_R2_WRITE_SECRET_ACCESS_KEY;
  const bucket = process.env.PRIVATE_SNAPSHOT_R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('R2 credentials are missing');
  }
  return {bucket, client: new S3Client({region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {accessKeyId, secretAccessKey}})};
}

function manifestStatus(name, resource, manifest) {
  if (!/^[a-f0-9-]{36}$/.test(manifest.version) ||
      manifest.shardCount !== resource.shardCount ||
      !Number.isSafeInteger(manifest.count) || manifest.count < resource.minRows ||
      !Number.isFinite(Date.parse(manifest.downloadedAt))) {
    throw new Error('Invalid snapshot manifest');
  }
  const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value : null;
  return {name, resourceId: resource.id, state: 'available', count: manifest.count,
    sourceLastModified: date(manifest.sourceLastModified),
    downloadedAt: manifest.downloadedAt, sourceCheckedAt: date(manifest.sourceCheckedAt)};
}

async function sourceStatus(name, resource, storage) {
  try {
    const result = await storage.client.send(new GetObjectCommand({
      Bucket: storage.bucket, Key: resource.legacyPrivate ? MANIFEST_KEY : manifestKey(resource),
    }), {abortSignal: AbortSignal.timeout(30_000)});
    const body = await result.Body.transformToString();
    return manifestStatus(name, resource, JSON.parse(body));
  } catch (error) {
    return {name, resourceId: resource.id, state: 'unavailable', error: error.name};
  }
}

async function writeDailyReport(report) {
  try {
    const previous = JSON.parse(await readFile('status.json', 'utf8'));
    if (previous.checkedAt?.slice(0, 10) === report.checkedAt.slice(0, 10)) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile('status.json', `${JSON.stringify(report, null, 2)}\n`);
}

async function reportStatus() {
  const storage = storageClient();
  const resources = [];
  for (const [name, resource] of Object.entries(RESOURCES)) {
    resources.push(await sourceStatus(name, resource, storage));
  }
  const report = {checkedAt: new Date().toISOString(),
    refreshOutcome: process.env.REFRESH_OUTCOME || 'unknown',
    runUrl: process.env.SNAPSHOT_RUN_URL || null, resources};
  if (process.argv.includes('--write-daily')) await writeDailyReport(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = resources.map((r) =>
      `| ${r.name} | ${r.state} | ${r.count ?? '-'} | ${r.sourceLastModified ?? '-'} | ${r.downloadedAt ?? '-'} | ${r.sourceCheckedAt ?? '-'} |`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Government snapshots\n\nRefresh: ${report.refreshOutcome}\n\n` +
      '| Dataset | Copy | Rows | Source updated | Downloaded | Verified |\n' +
      '| --- | --- | ---: | --- | --- | --- |\n' + rows.join('\n') + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  if (resources.some((r) => r.state !== 'available')) process.exitCode = 1;
}

if (require.main === module) reportStatus().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = {manifestStatus};
