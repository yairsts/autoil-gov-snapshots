const {readFileSync} = require('node:fs');
const {join} = require('node:path');

const workflow = (name) => readFileSync(join(__dirname, '../.github/workflows', name), 'utf8');

test('refresh stays on main, actions stay pinned, and tests receive no R2 secrets', () => {
  const refresh = workflow('refresh.yml');
  const tests = workflow('test.yml');
  expect(refresh).toContain("if: github.ref == 'refs/heads/main' &&");
  expect(refresh).toContain('ref: main');
  expect(refresh).not.toContain('pull_request');
  expect(tests).not.toContain('secrets.');
  expect(tests).toContain('persist-credentials: false');
  expect(refresh.split('    steps:')[0]).not.toContain('secrets.');
  expect(refresh.slice(refresh.indexOf('- name: Install'), refresh.indexOf('- name: Refresh')))
    .not.toContain('secrets.');
  for (const text of [refresh, tests]) {
    const actions = [...text.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
    expect(actions).toHaveLength(2);
    for (const action of actions) expect(action).toMatch(/^actions\/[\w-]+@[a-f0-9]{40}$/);
  }
  expect(refresh).toContain('-f branch=snapshot-status');
  expect(refresh).toContain('persist-credentials: false');
  expect(refresh).not.toContain('git push');
  expect(refresh).toContain('contents/status.json');
});

test('weekly Dev/Stage refresh uses the shared updater with isolated write credentials', () => {
  const refresh = workflow('refresh-nonprod.yml');
  expect(refresh).toContain("cron: '43 4 * * 0'");
  expect(refresh).toContain("if: github.ref == 'refs/heads/main' &&");
  expect(refresh).toContain("vars.NONPROD_REFRESH_ENABLED == 'true'");
  expect(refresh).toContain('ref: main');
  expect(refresh).toContain('group: gov-snapshot-nonprod-writer');
  expect(refresh).toContain('contents: read');
  expect(refresh).toContain('persist-credentials: false');
  expect(refresh).toContain('run: npm run gov:resources:sync');
  expect(refresh).toContain('run: node scripts/snapshot-status.js');
  expect(refresh).not.toContain('pull_request');
  expect(refresh).not.toContain('--scheduled');
  expect(refresh).not.toContain('--write-daily');
  expect(refresh).not.toContain('contents: write');
  expect(refresh).not.toContain('autoil-private-vehicle-snapshots');
  expect(refresh).not.toContain('secrets.PRIVATE_SNAPSHOT_R2_WRITE_');
  expect(refresh).not.toContain('SNAPSHOT_SOURCE_READ_');
  expect(refresh.slice(0, refresh.indexOf('- name: Refresh changed datasets')))
    .not.toContain('secrets.');
  expect(refresh.match(/PRIVATE_SNAPSHOT_R2_BUCKET: autoil-nonprod-vehicle-snapshots/g))
    .toHaveLength(2);
  expect(refresh.match(/secrets.NONPROD_R2_WRITE_ACCESS_KEY_ID/g)).toHaveLength(2);
  expect(refresh.match(/secrets.NONPROD_R2_WRITE_SECRET_ACCESS_KEY/g)).toHaveLength(2);
  const actions = [...refresh.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  expect(actions).toHaveLength(2);
  for (const action of actions) expect(action).toMatch(/^actions\/[\w-]+@[a-f0-9]{40}$/);
});
