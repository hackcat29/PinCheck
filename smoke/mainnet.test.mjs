// Live X Layer mainnet checks. Run with `npm run test:live`; kept out of the deterministic suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareOnChain, reference } from '../src/xlayer.mjs';

const url = process.env.X_LAYER_RPC || undefined;
const ORDERGUARD = '0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355';
const NEON = '0x57E9e1111f42F448126A9F12b2b3f99a79dd1A44';
const RECORDED = '0x5069ea174c5373b88fd00a9172a0303b10364083dd85eadb131c32ee5aa06a99';
const read = async path => JSON.parse(await readFile(new URL('../' + path, import.meta.url), 'utf8'));
const run = (a, b, block) => compareOnChain(reference(a), reference(b), { url, block });

async function atRecordedBlock(t, a, b) {
  const report = await run(a, b, RECORDED);
  if (report.code === 'historical-state-unavailable') t.skip('this RPC no longer serves the recorded block');
  return report;
}

test('PR #1 regression reproduces at its recorded block', async t => {
  const report = await atRecordedBlock(t, ORDERGUARD + ':1', ORDERGUARD + ':11');
  if (report.code === 'historical-state-unavailable') return;
  const recorded = await read('examples/orderguard-1-to-11.json');
  assert.equal(report.status, 'behavior-changed');
  assert.deepEqual(report.comparison, recorded.comparison);
  assert.equal(report.replay.status, 'confirmed');
  assert.deepEqual(report.dependencies, recorded.dependencies);
  assert.equal(report.pinning.method, 'eip-1898-block-hash');
});

test('PR #2 compatible upgrade reproduces at its recorded block', async t => {
  const report = await atRecordedBlock(t, ORDERGUARD + ':1', ORDERGUARD + ':2');
  if (report.code === 'historical-state-unavailable') return;
  assert.equal(report.status, 'compatible');
  assert.equal(report.comparison.checked, 4);
  assert.equal(report.replay.status, 'confirmed');
});

test('the deployed regression still holds at the latest block', async () => {
  const report = await run(ORDERGUARD + ':1', ORDERGUARD + ':11');
  assert.equal(report.status, 'behavior-changed', report.reason);
  assert.equal(report.comparison.firstMismatch.packedInput, '0x01');
  assert.equal(report.replay.status, 'confirmed');
  assert.equal(report.processors[ORDERGUARD.toLowerCase()].registered, true);
  // TAP-10 lists this circuit implementation for X Layer; a change means every recorded report needs review.
  assert.equal(report.implementation.address, '0x977f217887e085d298cb3819cdad5a0ee35f29b2');
});

test('a 20-input production circuit is checked exhaustively and its fingerprint matches the published hash', async () => {
  const report = await run(NEON + ':5', NEON + ':7');
  assert.equal(report.status, 'behavior-changed', report.reason);
  assert.equal(report.comparison.checked, 2 ** 20);
  assert.equal(report.replay.status, 'confirmed');
  // Published in tizerluo/neon-reliquary-xlayer docs/XLAYER-MAINNET.md
  assert.equal(report.dependencies[NEON.toLowerCase() + ':5'].keccak256, '0xe7817e016ecc710b8c7a2a68d10fdb24248eb2320155bb1d67d09e80a5200b02');
});

test('a 33-input identical circuit passes and a stateful identical circuit passes without replay', async () => {
  const wide = await run(ORDERGUARD + ':16', ORDERGUARD + ':16');
  assert.equal(wide.status, 'compatible', wide.reason);
  assert.equal(wide.comparison.method, 'identical-netlist');
  const stateful = await run(ORDERGUARD + ':17', ORDERGUARD + ':17');
  assert.equal(stateful.status, 'compatible', stateful.reason);
  assert.equal(stateful.replay.status, 'not-applicable');
});

test('an unregistered contract and a missing circuit are inconclusive', async () => {
  assert.equal((await run('0x' + '11'.repeat(20) + ':1', ORDERGUARD + ':1')).code, 'unregistered-processor');
  assert.equal((await run(ORDERGUARD + ':1', ORDERGUARD + ':999999')).code, 'no-circuit');
});
