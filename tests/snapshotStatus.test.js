const {manifestStatus} = require('../scripts/snapshot-status');
const {RESOURCES} = require('../constants/govResources');

test('public report keeps only safe metadata and validates the snapshot', () => {
  const resource = RESOURCES.PRIVATE;
  const manifest = {version: '123e4567-e89b-12d3-a456-426614174000',
    shardCount: 128, count: 4_000_000, downloadedAt: '2026-10-02T10:00:00Z',
    sourceLastModified: '2026-10-02T03:00:00Z', sourceCheckedAt: '2026-10-02T11:00:00Z',
    secret: 'not-for-the-report'};
  const report = manifestStatus('PRIVATE', resource, manifest);
  expect(report).toMatchObject({name: 'PRIVATE', count: 4_000_000, state: 'available'});
  expect(report).not.toHaveProperty('secret');
  expect(report).not.toHaveProperty('version');
  expect(() => manifestStatus('PRIVATE', resource, {...manifest, count: 1})).toThrow();
  expect(() => manifestStatus('PRIVATE', resource, {...manifest, shardCount: 64})).toThrow();
});
