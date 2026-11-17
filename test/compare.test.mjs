import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, pack, unpack } from '../src/compare.mjs';

const address = '0x' + 'ab'.repeat(20);
const baseline = { address, id: '1' };
const candidate = { address, id: '2' };
const u24 = value => value.toString(16).padStart(6, '0');
const nand = (a, b) => '00' + u24(a) + u24(b);
const latch = d => '01' + u24(d);
const ref = (id, nOuts, ...ins) => '02' + address.slice(2) + BigInt(id).toString(16).padStart(16, '0')
  + ins.length.toString(16).padStart(2, '0') + nOuts.toString(16).padStart(2, '0') + ins.map(u24).join('');
const make = (netlist, extra = {}) => ({ nIn: 2, nOut: 1, nState: 0, netlist: '0x' + netlist, ...extra });
const reader = circuits => ({
  info: async ({ id }) => { const c = circuits[Number(id) - 1]; if (!c) throw new Error('no circuit'); const { netlist, ...info } = c; return info; },
  netlist: async ({ id }) => circuits[Number(id) - 1].netlist,
});
const check = (circuits, options) => compare(reader(circuits), baseline, candidate, options);

// Build an n-input circuit that computes AND of all inputs via NAND pairs (inverting each step).
function andAll(n) {
  let records = '', next = 2 + n, acc = 2;
  for (let i = 1; i < n; i++) {
    records += nand(acc, 2 + i); records += nand(next, next); acc = next + 1; next += 2;
  }
  return { records, count: next - 2 - n };
}

test('equivalent circuits can use different NAND arrangements', async () => {
  const report = await check([make(nand(2, 3)), make(nand(3, 2))]);
  assert.equal(report.status, 'compatible');
  assert.equal(report.comparison.method, 'exhaustive');
  assert.equal(report.comparison.checked, 4);
  assert.equal(report.comparison.space, '4');
});

test('counterexample is packed LSB-first and preserves output bit positions', async () => {
  const report = await check([make(nand(2, 3)), make(nand(2, 2))]);
  assert.equal(report.status, 'behavior-changed');
  assert.equal(report.comparison.mismatches, 1);
  assert.deepEqual(report.comparison.firstMismatch, {
    input: 1, packedInput: '0x01', baselineOutput: '0x01', candidateOutput: '0x00', changedBits: [0],
  });
});

test('REF binds its inputs in record order and resolves a separate circuit', async () => {
  const report = await check([make(nand(2, 3)), make(ref(3, 1, 3, 2)), make(nand(2, 3))]);
  assert.equal(report.status, 'compatible');
  assert.equal(Object.keys(report.dependencies).length, 3);
});

test('REF outputs keep their order when a child has several outputs', async () => {
  // child #3: outputs [NAND(a,b), NOT a]. Parent swaps them via a second REF ordering.
  const child = { nIn: 2, nOut: 2, nState: 0, netlist: '0x' + nand(2, 3) + nand(2, 2) };
  const direct = { nIn: 2, nOut: 2, nState: 0, netlist: '0x' + nand(2, 3) + nand(2, 2) };
  const viaRef = { nIn: 2, nOut: 2, nState: 0, netlist: '0x' + ref(3, 2, 2, 3) };
  assert.equal((await check([direct, viaRef, child])).status, 'compatible');
  const swapped = { nIn: 2, nOut: 2, nState: 0, netlist: '0x' + nand(2, 2) + nand(2, 3) };
  const report = await check([direct, swapped, child]);
  assert.equal(report.status, 'behavior-changed');
  assert.deepEqual(report.comparison.firstMismatch.changedBits, [0, 1]);
});

test('self-references, truncation, forward signals and undeclared state cannot produce a pass', async () => {
  for (const invalid of [make(ref(2, 1, 2, 3)), make('00'), make(nand(2, 3), { nState: 1 }), make(nand(2, 4)), make('ff')]) {
    const report = await check([make(nand(2, 3)), invalid]);
    assert.equal(report.status, 'inconclusive', JSON.stringify(report.reason));
    assert.ok(report.code);
  }
});

test('mismatched interfaces are rejected before enumeration', async () => {
  const report = await check([make(nand(2, 3)), make(nand(2, 3), { nIn: 3 })]);
  assert.equal(report.status, 'interface-mismatch');
  assert.deepEqual(report.interface.candidate, { nIn: 3, nOut: 1, nState: 0 });
});

test('a missing circuit is inconclusive', async () => {
  const report = await compare(reader([make(nand(2, 3))]), baseline, { address, id: '9' });
  assert.equal(report.status, 'inconclusive');
  assert.match(report.reason, /no circuit/);
});

test('wide circuits are enumerated exhaustively with bit-sliced evaluation', async () => {
  const n = 20;
  const { records } = andAll(n);
  const a = { nIn: n, nOut: 1, nState: 0, netlist: '0x' + records };
  const report = await check([a, { ...a }]);
  assert.equal(report.comparison.method, 'exhaustive');
  assert.equal(report.comparison.identicalNetlist, true);
  const wide = await check([a, { ...a }], { limits: { maxExhaustiveBits: 8 } });
  assert.equal(wide.status, 'compatible');
  assert.equal(wide.comparison.method, 'identical-netlist');
  // Change only the last gate's polarity for one input pattern: OR the final output with input 0 AND NOT input 1.
  const flipped = { ...a, netlist: '0x' + records + nand(2, 2) + nand(2 + n + andAll(n).count - 1, 2 + n + andAll(n).count) };
  // flipped output = NAND(out, NOT x0) = NOT out OR x0 -> differs widely; use exhaustive count check
  const changed = await check([a, flipped]);
  assert.equal(changed.status, 'behavior-changed');
  assert.equal(changed.comparison.method, 'exhaustive');
  assert.equal(changed.comparison.checked, 2 ** n);
  assert.equal(changed.comparison.firstMismatch.input, 0);
});

test('a single differing input among 2^22 is found exactly', async () => {
  const n = 22;
  const { records } = andAll(n);
  const and = { nIn: n, nOut: 1, nState: 0, netlist: '0x' + records };
  // Candidate: constant 0 (NAND(1,1) = 0), differs only when every input is 1.
  const zero = { ...and, netlist: '0x' + records + nand(1, 1) };
  const report = await check([and, zero]);
  assert.equal(report.status, 'behavior-changed');
  assert.equal(report.comparison.mismatches, 1);
  assert.equal(report.comparison.firstMismatch.input, 2 ** n - 1);
  assert.equal(report.comparison.firstMismatch.packedInput, '0xffff3f');
});

test('circuits too wide to enumerate never pass, but a sampled mismatch fails', async () => {
  const n = 40;
  const { records } = andAll(n);
  const and = { nIn: n, nOut: 1, nState: 0, netlist: '0x' + records };
  const alsoAnd = { ...and, netlist: '0x' + records + nand(2, 3) };  // extra unused gate shifts outputs: output becomes NAND(x0,x1)
  const changed = await check([and, alsoAnd], { limits: { sampleWords: 64 } });
  assert.equal(changed.status, 'behavior-changed');
  assert.equal(changed.comparison.method, 'sampled');
  assert.equal(changed.comparison.exhaustive, false);
  assert.equal(changed.comparison.firstMismatch.input, undefined);

  // Double inversion of the output: equivalent, but too wide to prove by enumeration.
  const rewired = await check([and, { ...and, netlist: '0x' + records + nand(2 + n + andAll(n).count - 1, 1) + nand(2 + n + andAll(n).count, 1) }],
    { limits: { sampleWords: 64 } });
  assert.equal(rewired.status, 'inconclusive');
  assert.equal(rewired.code, 'too-wide');
  assert.equal(rewired.comparison.status, 'incomplete');
  assert.equal(rewired.comparison.checked, 64 * 32);
});

test('identical netlists pass at any width, including stateful circuits', async () => {
  const toggle = { nIn: 1, nOut: 1, nState: 1, netlist: '0x' + latch(4) + nand(2, 3) + nand(4, 4) };
  const report = await check([toggle, { ...toggle }]);
  assert.equal(report.status, 'compatible');
  assert.equal(report.comparison.method, 'identical-netlist');
  assert.deepEqual(report.probes, []);
});

test('different stateful circuits are inconclusive', async () => {
  const a = { nIn: 1, nOut: 1, nState: 1, netlist: '0x' + latch(4) + nand(2, 3) + nand(4, 4) };
  const b = { ...a, netlist: '0x' + latch(4) + nand(3, 2) + nand(4, 4) };
  const report = await check([a, b]);
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.code, 'stateful');
});

test('limits stop oversized work before evaluation', async () => {
  const big = make(nand(2, 3), { gateCount: 50000 });
  const other = make(nand(3, 2), { gateCount: 50001 });
  assert.equal((await check([big, other])).code, 'too-large');
  const huge = make('00'.repeat(4096));
  assert.equal((await check([make(nand(2, 3)), huge], { limits: { maxNetlistBytes: 1024 } })).code, 'too-large');
  let depth = [];
  for (let i = 0; i < 20; i++) depth.push(make(i === 19 ? nand(2, 3) : ref(i + 4, 1, 2, 3)));
  // circuits #3..#22 form a 20-deep REF chain
  const chain = [make(nand(2, 3)), make(ref(3, 1, 2, 3)), ...depth];
  assert.equal((await check(chain, { limits: { maxRefDepth: 8 } })).code, 'too-large');
});

test('a gate count that disagrees with the netlist is rejected', async () => {
  const report = await check([make(nand(2, 3), { gateCount: 1 }), make(nand(3, 2), { gateCount: 2 })]);
  assert.equal(report.code, 'invalid-netlist');
  assert.match(report.reason, /gate count/);
});

test('the exhaustive bound falls back to sampling instead of passing', async () => {
  const report = await check([make(nand(2, 3)), make(nand(3, 2) + nand(2, 3))], { limits: { maxExhaustiveBits: 1 } });
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.comparison.method, 'sampled');
});

test('compatible comparisons carry processor probes computed locally', async () => {
  const report = await check([make(nand(2, 3)), make(nand(3, 2))]);
  assert.deepEqual(report.probes.map(p => p.packedInput), ['0x00', '0x03', ...report.probes.slice(2).map(p => p.packedInput)]);
  for (const probe of report.probes) assert.equal(probe.baselineOutput, probe.candidateOutput);
  assert.equal(report.probes.find(p => p.packedInput === '0x03').baselineOutput, '0x00');
});

test('pack and unpack are inverse and LSB-first', () => {
  const bits = [1, 0, 0, 0, 0, 0, 0, 0, 1, 1];
  assert.equal(pack(bits), '0x0103');
  assert.deepEqual(unpack('0x0103', 10), bits);
});
