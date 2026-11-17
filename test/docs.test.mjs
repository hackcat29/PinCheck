import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseManifest } from '../src/manifest.mjs';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const blocks = md => [...md.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map(m => ({ lang: m[1], body: m[2] }));

test('install docs match the example repository layout', async () => {
  const docs = blocks(await read('docs/install.md'));
  const workflow = docs.find(b => b.lang === 'yaml');
  assert.equal(workflow.body.trim(), (await read('examples/consumer/.github/workflows/pincheck.yml')).replace(/\n\s*# rpc-url:.*$/m, '').trim());
  // The example manifest is the fixture that demo pull requests change, so compare its shape, not its circuit.
  const documented = parseManifest(docs.find(b => b.lang === 'json').body);
  const example = parseManifest(await read('examples/consumer/pincheck.json'));
  assert.deepEqual([...example.dependencies.keys()], [...documented.dependencies.keys()]);
  const owners = docs.find(b => b.body.startsWith('/pincheck.json'));
  const exampleOwners = (await read('examples/consumer/.github/CODEOWNERS')).split('\n').filter(line => line.startsWith('/')).join('\n');
  assert.equal(owners.body.trim(), exampleOwners.trim());
});

test('every manifest snippet in the docs and README parses', async () => {
  const docs = blocks(await read('docs/install.md')).filter(b => b.lang === 'json');
  for (const block of docs) {
    const text = block.body.trim().startsWith('"') ? '{"pincheck":1,"dependencies":{' + block.body + '}}' : block.body;
    assert.doesNotThrow(() => parseManifest(text), block.body.slice(0, 60));
  }
  for (const block of blocks(await read('README.md')).filter(b => b.lang === 'json')) assert.doesNotThrow(() => parseManifest(block.body));
});

test('the README workflow matches the documented one', async () => {
  const readme = blocks(await read('README.md')).find(b => b.lang === 'yaml');
  const docs = blocks(await read('docs/install.md')).find(b => b.lang === 'yaml');
  assert.equal(readme.body.replace(/^#.*\n/, '').trim(), docs.body.trim());
});

test('the ruleset example requires the check name the workflow produces, from GitHub Actions', async () => {
  const ruleset = JSON.parse(await read('examples/consumer/ruleset.json'));
  const workflow = await read('examples/consumer/.github/workflows/pincheck.yml');
  const check = ruleset.rules.find(r => r.type === 'required_status_checks').parameters.required_status_checks[0];
  assert.match(workflow, new RegExp('name: ' + check.context));
  assert.equal(check.integration_id, 15368);
  assert.equal(ruleset.rules.find(r => r.type === 'pull_request').parameters.require_code_owner_review, true);
});
