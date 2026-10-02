const {gunzipSync} = require('node:zlib');
const {Readable} = require('node:stream');
const {mkdtemp, readFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {MANIFEST_KEY, SHARD_COUNT, shardNumber} = require('../utils/privateSnapshotLayout');
const {buildSnapshot, downloadUrl, publishSnapshot} = require('../scripts/sync-private-vehicles');

test('builds readable shards from the government Windows-1255 pipe CSV', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-snapshot-test-'));
  try {
    const source = Buffer.concat([
      Buffer.from('mispar_rechev|tozeret_nm|shnat_yitzur\r\n"16269501"|"'),
      Buffer.from([0xee, 0xe9, 0xf6, 0xe5, 0xe1, 0xe9, 0xf9, 0xe9]),
      Buffer.from('"|"2017"\r\n"1821052"|"TEST"|"2020"\r\n'),
    ]);
    const built = await buildSnapshot(Readable.from([source]), directory, {minRows: 2});
    expect(built).toMatchObject({count: 2, bytes: source.length});
    const number = shardNumber('16269501');
    const lines = gunzipSync(await readFile(built.paths[number]))
      .toString('utf8').trim().split('\n').map(JSON.parse);
    expect(lines).toContainEqual(expect.objectContaining({
      _id: 16269501,
      mispar_rechev: '16269501',
      tozeret_nm: 'מיצובישי',
      shnat_yitzur: 2017,
    }));
    const keys = [];
    const client = {send: jest.fn(async (command) => {
      keys.push(command.input.Key);
      if (command.input.Body?.pipe) {
        for await (const _chunk of command.input.Body) { /* consume upload */ }
      }
      return {};
    })};
    await publishSnapshot(client, 'bucket', built, {
      hash: 'a'.repeat(32),
      last_modified: '2026-09-25T00:00:00Z',
    }, null);
    expect(keys).toHaveLength(SHARD_COUNT + 1);
    expect(keys.at(-1)).toBe(MANIFEST_KEY);

    let uploads = 0;
    let cleanup;
    const failingClient = {send: jest.fn(async (command) => {
      if (command.constructor.name === 'DeleteObjectsCommand') {
        cleanup = command.input.Delete.Objects;
        return {};
      }
      uploads += 1;
      if (uploads === 3) {
        command.input.Body.destroy();
        throw new Error('upload failed');
      }
      for await (const _chunk of command.input.Body) { /* consume upload */ }
      return {};
    })};
    await expect(publishSnapshot(failingClient, 'bucket', built, {
      hash: 'a'.repeat(32),
      last_modified: '2026-09-25T00:00:00Z',
    }, null)).rejects.toThrow('upload failed');
    expect(cleanup).toHaveLength(2);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('rewrites only the official download host', () => {
  const official = 'https://e.data.gov.il/dataset/a/resource/' +
    '053cea08-09bc-40ec-8f7a-156f0677aff3/download/file.csv';
  expect(downloadUrl({url: official})).toContain('https://data.gov.il/');
  expect(() => downloadUrl({url: 'https://example.com/file.csv'})).toThrow();
});
