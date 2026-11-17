import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest } from '../src/manifest.mjs';
import { runGate } from '../src/gate.mjs';
import { renderSummary } from '../src/summary.mjs';
import { normalize } from '../src/report.mjs';

const P = '0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355';
const p = P.toLowerCase();
const manifest = (deps, extra = {}) => JSON.stringify({ pincheck: 1, dependencies: deps, ...extra });
const recorded = JSON.parse(await readFile(new URL('../demo/incompatible.json', import.meta.url), 'utf8'));

// Fake comparisons keyed by candidate id.
const fakeCompare = results => async (baseline, candidate) => ({
  schema: 2, tool: { version: 'test' }, baseline, candidate,
  block: { number: '0x48a1ee0', hash: '0x' + '50'.repeat(32) },
  interface: { baseline: { nIn: 2, nOut: 1, nState: 0 }, candidate: { nIn: 2, nOut: 1, nState: 0 } },
  dependencies: {},
  ...results[candidate.id],
});
const changed = {
  status: 'behavior-changed',
  comparison: { status: 'different', method: 'exhaustive', checked: 4, space: '4', mismatches: 3, firstMismatch: { input: 1, packedInput: '0x01', baselineOutput: '0x01', candidateOutput: '0x00', changedBits: [0] } },
  replay: { status: 'confirmed', kind: 'counterexample' },
};
const compatible = { status: 'compatible', comparison: { status: 'equivalent', method: 'exhaustive', checked: 4, space: '4', mismatches: 0 }, replay: { status: 'confirmed', kind: 'spot-check' } };
const rpcDown = { status: 'inconclusive', code: 'rpc-unavailable', reason: 'X Layer RPC could not be reached', replay: { status: 'not-run' } };
const tooWide = { status: 'inconclusive', code: 'too-wide', reason: 'too wide', replay: { status: 'not-applicable' } };
const compare = fakeCompare({ 2: compatible, 11: changed, 12: rpcDown, 16: tooWide });

test('legacy single-circuit manifests still parse', () => {
  const m = parseManifest(JSON.stringify({ circuit: P + ':1' }));
  assert.equal(m.legacy, true);
  assert.deepEqual(m.dependencies.get('circuit').circuit, { address: p, id: '1' });
});

test('manifest validation names the problem', () => {
  const bad = [
    ['{', /Not valid JSON/],
    [manifest({ a: { circuit: P + ':1' } }, { pincheck: 2 }), /"pincheck": 1/],
    [manifest({ a: { circuit: 'nope' } }), /dependencies\.a\.circuit/],
    [manifest({ 'bad name!': { circuit: P + ':1' } }), /Dependency name/],
    [manifest({ a: { circuit: P + ':1', acceptchange: {} } }), /Unknown field "acceptchange"/],
    [manifest({ a: { circuit: P + ':1', acceptChange: { from: P + ':1' } } }), /reason/],
    [manifest({ a: { circuit: P + ':1', inputs: [1] } }), /inputs/],
    [manifest({ a: { circuit: P + ':1' } }, { chain: 1 }), /196/],
  ];
  for (const [text, pattern] of bad) assert.throws(() => parseManifest(text), pattern);
});

test('unchanged dependencies pass without touching the chain', async () => {
  const m = parseManifest(manifest({ guard: { circuit: P + ':1' } }));
  const gate = await runGate(m, m, { compare: () => assert.fail('no RPC expected') });
  assert.equal(gate.decision, 'pass');
  assert.equal(gate.exitCode, 0);
  assert.equal(gate.changed, 0);
});

test('a behavior change blocks the merge and the summary shows the counterexample', async () => {
  const base = parseManifest(manifest({ guard: { circuit: P + ':1', inputs: ['amountOk', 'payeeKnown'], outputs: ['approve'] } }));
  const head = parseManifest(manifest({ guard: { circuit: P + ':11', inputs: ['amountOk', 'payeeKnown'], outputs: ['approve'] } }));
  const gate = await runGate(base, head, { compare });
  assert.equal(gate.decision, 'fail');
  assert.equal(gate.exitCode, 1);
  const md = renderSummary(gate, { siteUrl: 'https://pincheck.example' });
  assert.match(md, /PinCheck blocked this merge: a circuit dependency changed behavior/);
  assert.match(md, /input `0x01` → current output `0x01`, candidate output `0x00`/);
  assert.match(md, /Named inputs: `amountOk=1` `payeeKnown=0`/);
  assert.match(md, /Changed output bit: 0 \(approve\)/);
  assert.match(md, /both deployed processors returned these outputs/);
  assert.match(md, /"acceptChange": \{ "from": "0x57f3.*:1"/);
  assert.match(md, /node cli\.mjs --block 0x5050/);
  assert.match(md, /pincheck\.example\/\?baseline=/);
});

test('a compatible upgrade passes', async () => {
  const gate = await runGate(parseManifest(manifest({ g: { circuit: P + ':1' } })), parseManifest(manifest({ g: { circuit: P + ':2' } })), { compare });
  assert.equal(gate.decision, 'pass');
  assert.match(renderSummary(gate), /PinCheck passed: circuit dependencies are compatible/);
});

test('acceptChange records an intended change only for the exact transition', async () => {
  const base = parseManifest(manifest({ g: { circuit: P + ':1' } }));
  const accepted = await runGate(base, parseManifest(manifest({ g: { circuit: P + ':11', acceptChange: { from: P + ':1', reason: 'New fee rule, see #42' } } })), { compare });
  assert.equal(accepted.decision, 'pass');
  assert.equal(accepted.dependencies[0].decision, 'accepted');
  assert.match(renderSummary(accepted), /Accepted in `pincheck.json`:\*\* New fee rule, see #42/);

  const wrongFrom = await runGate(base, parseManifest(manifest({ g: { circuit: P + ':11', acceptChange: { from: P + ':5', reason: 'stale approval' } } })), { compare });
  assert.equal(wrongFrom.decision, 'fail');
  assert.match(wrongFrom.notes[0], /ignored/);
});

test('acceptChange never turns a failed run into a pass', async () => {
  const base = parseManifest(manifest({ g: { circuit: P + ':1' } }));
  const gate = await runGate(base, parseManifest(manifest({ g: { circuit: P + ':12', acceptChange: { from: P + ':1', reason: 'trying to force it' } } })), { compare });
  assert.equal(gate.decision, 'inconclusive');
  assert.equal(gate.exitCode, 2);
  assert.match(gate.notes[0], /cannot accept a comparison that failed to run/);
  // An out-of-scope circuit (too wide to prove) can be accepted on purpose.
  const wide = await runGate(base, parseManifest(manifest({ g: { circuit: P + ':16', acceptChange: { from: P + ':1', reason: 'reviewed by hand' } } })), { compare });
  assert.equal(wide.decision, 'pass');
});

test('an RPC failure blocks with exit 2', async () => {
  const gate = await runGate(parseManifest(manifest({ g: { circuit: P + ':1' } })), parseManifest(manifest({ g: { circuit: P + ':12' } })), { compare });
  assert.equal(gate.decision, 'inconclusive');
  assert.match(renderSummary(gate), /did not complete/);
});

test('added and removed dependencies are reported without blocking', async () => {
  const gate = await runGate(parseManifest(manifest({ old: { circuit: P + ':1' } })), parseManifest(manifest({ fresh: { circuit: P + ':2' } })), { compare });
  assert.equal(gate.decision, 'pass');
  assert.deepEqual(gate.dependencies.map(d => d.change), ['removed', 'added']);
  const first = await runGate(null, parseManifest(manifest({ fresh: { circuit: P + ':2' } })), { compare });
  assert.match(first.notes[0], /no manifest/);
});

test('several dependencies: one failure blocks the whole gate', async () => {
  const base = parseManifest(manifest({ a: { circuit: P + ':1' }, b: { circuit: P + ':1' }, c: { circuit: P + ':1' } }));
  const head = parseManifest(manifest({ a: { circuit: P + ':2' }, b: { circuit: P + ':11' }, c: { circuit: P + ':1' } }));
  const gate = await runGate(base, head, { compare });
  assert.equal(gate.decision, 'fail');
  assert.equal(gate.changed, 2);
  assert.match(renderSummary(gate), /1 other dependency is unchanged/);
});

test('schema 1 reports render through the current view', () => {
  const report = normalize(recorded);
  assert.equal(report.comparison.firstMismatch.packedInput, '0x01');
  assert.equal(report.replay.status, 'confirmed');
  assert.match(report.guarantee, /not a drop-in replacement/);
});

const run = promisify(execFile);
const cli = (...args) => run(process.execPath, [new URL('../cli.mjs', import.meta.url).pathname, ...args]).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('CLI exit codes: help 0, invalid input 2', async () => {
  assert.equal((await cli('--help')).code, 0);
  const bad = await cli('0x12:1', P + ':2');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /processor address/);
});

test('CLI gate rejects a malformed proposed manifest with exit 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pincheck-'));
  await writeFile(join(dir, 'base.json'), manifest({ g: { circuit: P + ':1' } }));
  await writeFile(join(dir, 'head.json'), '{"pincheck":1,"dependencies":{"g":{"circuit":"oops"}}}');
  const result = await cli('gate', '--base', join(dir, 'base.json'), '--head', join(dir, 'head.json'));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /proposed pincheck\.json: dependencies\.g\.circuit/);
  const same = await cli('gate', '--base', join(dir, 'base.json'), '--head', join(dir, 'base.json'), '--summary', join(dir, 's.md'));
  assert.equal(same.code, 0);
  assert.match(await readFile(join(dir, 's.md'), 'utf8'), /No pinned circuit changed/);
});
