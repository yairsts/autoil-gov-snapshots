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
