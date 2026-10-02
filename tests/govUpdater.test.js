const {gunzipSync} = require('node:zlib');
const {Readable} = require('node:stream');
const {mkdtemp, readFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {RESOURCES, lookupKey} = require('../constants/govResources');
const {SHARD_COUNT, shardNumber, manifestKey} = require('../utils/govSnapshotLayout');
const {
  buildSnapshot, normalizeRow, downloadUrl, publishSnapshot,
  selectedResources, reserveSpace, syncResource,
} = require('../scripts/sync-gov-resources');
const VERSION = '123e4567-e89b-12d3-a456-426614174000';
const UPDATED_AT = '2026-09-25T00:00:00Z';

test('rejects an upload before exceeding the free-storage safety budget', () => {
  const storage = {usedBytes: 7_900_000_000};
  expect(() => reserveSpace(storage, 200_000_000)).toThrow('8 GB');
  expect(storage.usedBytes).toBe(7_900_000_000);
  reserveSpace(storage, 10_000_000);
  expect(storage.usedBytes).toBe(7_910_000_000);
});

test('refreshes current status daily and large/reference datasets on Sunday', () => {
  const monday = selectedResources({scheduled: true, date: new Date('2026-09-28T03:17:00Z')});
  expect(monday.map(([name]) => name)).toContain('MISSING_RECALL');
  expect(monday.map(([name]) => name)).not.toContain('HISTORY_2');
  expect(selectedResources({scheduled: true, date: new Date('2026-09-27T03:17:00Z')})).toHaveLength(17);
  expect(selectedResources({resourceName: 'BUS'})).toEqual([['BUS', RESOURCES.BUS]]);
  expect(() => selectedResources({resourceName: 'typo'})).toThrow('Unknown resource');
});

test('uses exact padded plate keys and handles codes with leading zeroes', () => {
  expect(lookupKey(RESOURCES.DISABLED_CARD, {'MISPAR RECHEV': '00050096'}))
    .toBe(lookupKey(RESOURCES.DISABLED_CARD, {'MISPAR RECHEV': 50096}));
  expect(lookupKey(RESOURCES.MODEL_INFO, {
    degem_nm: 'MODEL', degem_cd: '00179', shnat_yitzur: '2021', sug_degem: 'P',
  })).toBe(lookupKey(RESOURCES.MODEL_INFO, {
    degem_nm: 'MODEL', degem_cd: 179, shnat_yitzur: 2021, sug_degem: 'P',
  }));
  expect(lookupKey(RESOURCES.MOTORCYCLE, {mispar_rechev: 'not-a-plate'})).toBeNull();
});

test('decodes legacy Hebrew and comma-delimited bus files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gov-formats-test-'));
  try {
    const bytes = Buffer.concat([
      Buffer.from('mispar_tzama|sug_tzama_nm\n1003|'), Buffer.from([0xee, 0xec, 0xe2, 0xe6, 0xe4]), Buffer.from('\n'),
    ]);
    const built = await buildSnapshot(RESOURCES.EQUIPMENT, Readable.from([bytes]), directory, {minRows: 1});
    const number = shardNumber(lookupKey(RESOURCES.EQUIPMENT, {mispar_tzama: 1003}));
    expect(gunzipSync(await readFile(built.paths[number])).toString('utf8')).toContain('מלגזה');
    const csv = Buffer.from('bus_license_id,operator_nm,SeatsNum\n03177039,"אגד, תחבורה",59\n');
    const buses = await buildSnapshot(RESOURCES.BUS, Readable.from([csv]), directory, {minRows: 1});
    const busShard = shardNumber(lookupKey(RESOURCES.BUS, {bus_license_id: 3177039}));
    expect(JSON.parse(gunzipSync(await readFile(buses.paths[busShard])).toString('utf8')))
      .toMatchObject({bus_license_id: 3177039, operator_nm: 'אגד, תחבורה', SeatsNum: 59});
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('keeps heavy-vehicle tire inches with malformed source quotes without losing columns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gov-heavy-quotes-test-'));
  try {
    const csv = Buffer.from('mispar_rechev|zmig_ahori|mispar_manoa|sranim\n' +
      '"04808315"|"155+13""|""|"243"\n');
    const resource = {...RESOURCES.HEAVY, encoding: 'utf-8'};
    const built = await buildSnapshot(resource, Readable.from([csv]), directory, {minRows: 1});
    const number = shardNumber(lookupKey(resource, {mispar_rechev: 4808315}));
    expect(JSON.parse(gunzipSync(await readFile(built.paths[number])).toString('utf8')))
      .toMatchObject({mispar_rechev: 4808315, zmig_ahori: '155+13"', mispar_manoa: '', sranim: '243'});
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('still rejects genuinely missing columns and settles failed shard streams', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gov-invalid-stream-test-'));
  try {
    const resource = {...RESOURCES.HEAVY, encoding: 'utf-8'};
    const invalid = Buffer.from('mispar_rechev|zmig_ahori|sranim\n"4808315"|"R13"|"243"\n"4808316"|"R13"\n');
    await expect(buildSnapshot(resource, Readable.from([invalid]), directory, {minRows: 1}))
      .rejects.toThrow('Invalid Record Length');
    const valid = Buffer.from('mispar_rechev|zmig_ahori|sranim\n"4808315"|"R13|SPECIAL"|"243"\n');
    const built = await buildSnapshot(resource, Readable.from([valid]), directory, {minRows: 1});
    const number = shardNumber(lookupKey(resource, {mispar_rechev: 4808315}));
    expect(JSON.parse(gunzipSync(await readFile(built.paths[number])).toString('utf8')))
      .toMatchObject({zmig_ahori: 'R13|SPECIAL', sranim: '243'});
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('repairs an unclosed escaped quote even when the value contains a pipe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gov-pipe-quote-test-'));
  try {
    const resource = {...RESOURCES.INACTIVE_CARS, encoding: 'utf-8'};
    const csv = Buffer.from('mispar_rechev|degem_manoa|hanaa_cd\n"00968214"|"|""|"1"\n');
    const built = await buildSnapshot(resource, Readable.from([csv]), directory, {minRows: 1});
    const number = shardNumber(lookupKey(resource, {mispar_rechev: 968214}), resource.shardCount);
    expect(JSON.parse(gunzipSync(await readFile(built.paths[number])).toString('utf8')))
      .toMatchObject({mispar_rechev: 968214, degem_manoa: '|"', hanaa_cd: '1'});
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('normalizes numeric fields without changing text or prices', () => {
  const row = {
    tozeret_cd: '928', degem_cd: '1000', degem_nm: 'TWINGO',
    shnat_yitzur: '1996', sug_degem: 'P', mehir: '54950',
    shem_yevuan: 'קרסו מוטורס בע"מ',
  };
  expect(normalizeRow(RESOURCES.PRICE_LIST, row, 7)).toEqual({
    _id: 7,
    tozeret_cd: 928,
    degem_cd: 1000,
    degem_nm: 'TWINGO',
    shnat_yitzur: 1996,
    sug_degem: 'P',
    mehir: 54950,
    shem_yevuan: 'קרסו מוטורס בע"מ',
  });
  expect(() => normalizeRow(RESOURCES.PRICE_LIST, {...row, mehir: 'oops'}, 8))
    .toThrow('Invalid numeric mehir');
});

test('builds UTF-8 shards with the exact lookup keys used by the reader', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gov-pilot-test-'));
  try {
    const csv = Buffer.from(
      '"tozeret_cd"|"degem_nm"|"degem_cd"|"shnat_yitzur"|"sug_degem"|"mehir"\n' +
      '"928"|"רנו"|"1000"|"1996"|"P"|"54950"\n' +
      '"928"|"רנו"|"1000"|"1996"|"P"|"55950"\n',
    );
    const built = await buildSnapshot(
      RESOURCES.PRICE_LIST,
      Readable.from([csv.subarray(0, 85), csv.subarray(85)]),
      directory,
      {minRows: 2},
    );
    expect(built).toMatchObject({count: 2, bytes: csv.length});
    const key = lookupKey(RESOURCES.PRICE_LIST, {
      tozeret_cd: '928', degem_nm: 'רנו', degem_cd: '1000',
      shnat_yitzur: '1996', sug_degem: 'P',
    });
    const lines = gunzipSync(await readFile(built.paths[shardNumber(key)]))
      .toString('utf8').trim().split('\n').map(JSON.parse);
    expect(lines).toEqual([
      expect.objectContaining({_id: 1, mehir: 54950}),
      expect.objectContaining({_id: 2, mehir: 55950}),
    ]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('unchanged source refreshes only verification metadata without downloading or replacing shards', async () => {
  const resource = RESOURCES.PRICE_LIST;
  const sourceHash = 'a'.repeat(32);
  const previous = {resourceId: resource.id, version: VERSION, shardCount: resource.shardCount,
    layoutVersion: resource.layoutVersion, count: resource.minRows, sourceHash,
    downloadedAt: UPDATED_AT, sourceLastModified: UPDATED_AT};
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ok: true,
    json: async () => ({success: true, result: {id: resource.id, hash: sourceHash,
      size: resource.minSourceBytes, last_modified: UPDATED_AT}})});
  const client = {send: jest.fn(async (command) => command.input.Body ? {} : {Body: {
    transformToByteArray: async () => Buffer.from(JSON.stringify(previous)),
  }})};
  try {
    await syncResource(resource, {client, bucket: 'bucket'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.send).toHaveBeenCalledTimes(2);
    const written = JSON.parse(client.send.mock.calls[1][0].input.Body);
    expect(written).toMatchObject({version: VERSION, downloadedAt: UPDATED_AT,
      sourceLastModified: '2026-09-25T00:00:00.000Z'});
    expect(Number.isFinite(Date.parse(written.sourceCheckedAt))).toBe(true);
  } finally { fetchMock.mockRestore(); }
});

test('only official resource download URLs are accepted', () => {
  const resource = RESOURCES.PRICE_LIST;
  const official = `https://e.data.gov.il/dataset/x/resource/${resource.id}/download/a.csv`;
  expect(downloadUrl(resource, {url: official})).toContain('https://data.gov.il/');
  expect(() => downloadUrl(resource, {url: 'https://example.com/a.csv'})).toThrow();
});

test('publishes the manifest last and cleans an interrupted upload', async () => {
  const resource = RESOURCES.PRICE_LIST;
  const directory = await mkdtemp(join(tmpdir(), 'gov-pilot-publish-test-'));
  try {
    const csv = Buffer.from(
      'tozeret_cd|degem_nm|degem_cd|shnat_yitzur|sug_degem|mehir\n' +
      '928|TWINGO|1000|1996|P|54950\n',
    );
    const built = await buildSnapshot(
      resource, Readable.from([csv]), directory, {minRows: 1},
    );
    const keys = [];
    const client = {send: jest.fn(async (command) => {
      keys.push(command.input.Key);
      if (command.input.Body?.pipe) {
        for await (const _chunk of command.input.Body) { /* consume upload */ }
      }
      return {};
    })};
    const published = await publishSnapshot(client, 'bucket', resource, built, {
      hash: 'a'.repeat(32), last_modified: UPDATED_AT.slice(0, -1),
    }, null);
    expect(published.sourceLastModified).toBe('2026-09-25T00:00:00.000Z');
    expect(keys).toHaveLength(SHARD_COUNT + 1);
    expect(keys.at(-1)).toBe(manifestKey(resource));

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
    await expect(publishSnapshot(failingClient, 'bucket', resource, built, {
      hash: 'a'.repeat(32), last_modified: UPDATED_AT,
    }, null)).rejects.toThrow('upload failed');
    expect(cleanup).toHaveLength(2);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
