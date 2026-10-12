const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {RESOURCES} = require('../constants/govResources');
const {manifestKey, shardKey} = require('../utils/govSnapshotLayout');
const privateLayout = require('../utils/privateSnapshotLayout');
const {checkBudget, copyResource, copySnapshots, SOURCE_BUCKET, TARGET_BUCKET} =
  require('../scripts/copy-nonprod-snapshots');

const VERSION = '123e4567-e89b-12d3-a456-426614174000';
const PREVIOUS = '223e4567-e89b-12d3-a456-426614174000';
const OLDER = '323e4567-e89b-12d3-a456-426614174000';
const resource = {...RESOURCES.BUS, shardCount: 2, minRows: 1};
const manifest = {resourceId: resource.id, version: VERSION, shardCount: 2, count: 1,
  storedBytes: 4, sourceHash: 'a'.repeat(32), downloadedAt: '2026-10-12T00:00:00Z'};

function storage(bucket, objects = {}) {
  const calls = [];
  const client = {send: jest.fn(async (command) => {
    const {Key, Body, Delete} = command.input;
    const operation = command.constructor.name;
    calls.push({operation, ...command.input});
    if (operation === 'GetObjectCommand') {
      if (!(Key in objects)) throw Object.assign(new Error('missing'), {name: 'NoSuchKey'});
      const bytes = Buffer.from(objects[Key]);
      return {ContentLength: bytes.length, Body: {
        transformToString: async () => bytes.toString(), transformToByteArray: async () => bytes,
      }};
    }
    if (operation === 'PutObjectCommand') objects[Key] = Buffer.from(Body);
    if (operation === 'DeleteObjectsCommand') {
      for (const {Key: key} of Delete.Objects) delete objects[key];
    }
    return {};
  })};
  return {bucket, client, calls, objects};
}

function sourceStorage() {
  return storage(SOURCE_BUCKET, {
    [shardKey(resource, VERSION, 0)]: 'ab', [shardKey(resource, VERSION, 1)]: 'cd',
  });
}

test('copies verified shards before publishing, preserving source dates and keeping one old version', async () => {
  const source = sourceStorage();
  const target = storage(TARGET_BUCKET, {
    [manifestKey(resource)]: JSON.stringify({...manifest, version: PREVIOUS, previousVersion: OLDER}),
  });
  const copied = await copyResource(source, target, 'BUS', resource, manifest);
  expect(copied).toMatchObject({downloadedAt: manifest.downloadedAt, previousVersion: PREVIOUS});
  expect(copied.version).not.toBe(VERSION);
  expect(source.calls.every((call) => call.operation === 'GetObjectCommand')).toBe(true);
  const publication = target.calls.findIndex((call) => call.Key === manifestKey(resource) &&
    call.operation === 'PutObjectCommand');
  const verified = target.calls.slice(0, publication).filter((call) =>
    call.operation === 'GetObjectCommand' && call.Key !== manifestKey(resource));
  expect(verified).toHaveLength(2);
  expect(target.calls[publication + 1]).toMatchObject({operation: 'DeleteObjectsCommand',
    Delete: {Objects: [0, 1].map((number) => ({Key: shardKey(resource, OLDER, number)}))}});
});

test('a missing source shard leaves the old manifest available', async () => {
  const source = sourceStorage();
  delete source.objects[shardKey(resource, VERSION, 1)];
  const old = JSON.stringify({...manifest, version: PREVIOUS});
  const target = storage(TARGET_BUCKET, {[manifestKey(resource)]: old});
  await expect(copyResource(source, target, 'BUS', resource, manifest)).rejects.toThrow('missing');
  expect(String(target.objects[manifestKey(resource)])).toBe(old);
  const cleanup = target.calls.at(-1);
  expect(cleanup.operation).toBe('DeleteObjectsCommand');
  expect(cleanup.Delete.Objects.every(({Key}) => !(Key in target.objects))).toBe(true);
});

test('copies at most four shards at once', async () => {
  const many = {...resource, shardCount: 9};
  const objects = Object.fromEntries(Array.from({length: 9}, (_, number) =>
    [shardKey(many, VERSION, number), 'ab']));
  const source = storage(SOURCE_BUCKET, objects);
  const send = source.client.send;
  let active = 0;
  let maximum = 0;
  source.client.send = async (command) => {
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await send(command);
    } finally { active -= 1; }
  };
  await copyResource(source, storage(TARGET_BUCKET), 'BUS', many,
    {...manifest, shardCount: 9, storedBytes: 18});
  expect(maximum).toBe(4);
  expect(active).toBe(0);
});

test('read-back corruption stops publication', async () => {
  const source = sourceStorage();
  const target = storage(TARGET_BUCKET);
  const send = target.client.send;
  target.client.send = async (command) => {
    const result = await send(command);
    if (command.constructor.name === 'PutObjectCommand') target.objects[command.input.Key] = 'xx';
    return result;
  };
  await expect(copyResource(source, target, 'BUS', resource, manifest))
    .rejects.toThrow('checksum mismatch');
  expect(target.objects[manifestKey(resource)]).toBeUndefined();
});

test('rejects total size mismatch before publication', async () => {
  await expect(copyResource(sourceStorage(), storage(TARGET_BUCKET), 'BUS', resource,
    {...manifest, storedBytes: 5})).rejects.toThrow('size mismatch');
});

test('uses the legacy private-vehicle paths too', async () => {
  const legacy = {...RESOURCES.PRIVATE, shardCount: 1, minRows: 1};
  const source = storage(SOURCE_BUCKET, {[privateLayout.shardKey(VERSION, 0)]: 'ab'});
  const target = storage(TARGET_BUCKET);
  await copyResource(source, target, 'PRIVATE', legacy, {...manifest, shardCount: 1, storedBytes: 2});
  expect(target.objects[privateLayout.MANIFEST_KEY]).toBeDefined();
});

test('bounds combined storage, including temporary copies, and cannot copy into Production', async () => {
  expect(() => checkBudget(4_000_000_000, 3_000_000_000, 2_000_000_000)).toThrow('8 GB');
  expect(() => checkBudget(1, NaN, 1)).toThrow('inventory');
  expect(() => checkBudget(1_300_000_000, 1_300_000_000, 650_000_000)).not.toThrow();
  await expect(copySnapshots(storage(TARGET_BUCKET), storage(SOURCE_BUCKET)))
    .rejects.toThrow('restricted');
});

test('weekly copy only runs trusted main and never receives the Production writer key', () => {
  const workflow = readFileSync(join(__dirname, '../.github/workflows/copy-nonprod.yml'), 'utf8');
  expect(workflow).toContain("cron: '43 4 * * 0'");
  expect(workflow).toContain("if: github.ref == 'refs/heads/main' &&");
  expect(workflow).toContain('ref: main');
  expect(workflow).toContain('group: gov-snapshot-writer');
  expect(workflow).toContain('contents: read');
  expect(workflow).toContain('persist-credentials: false');
  expect(workflow).not.toContain('pull_request');
  expect(workflow).not.toContain('PRIVATE_SNAPSHOT_R2_WRITE_');
  expect(workflow.slice(0, workflow.indexOf('- name: Copy and verify'))).not.toContain('secrets.');
  const actions = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  expect(actions).toHaveLength(2);
  for (const action of actions) expect(action).toMatch(/^actions\/[\w-]+@[a-f0-9]{40}$/);
});
