import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare } from '../src/compare.mjs';

const address = '0x' + 'ab'.repeat(20);
const baseline = { address, id: '1' };
const candidate = { address, id: '2' };
const nand = (a, b) => '00' + [a, b].map(value => value.toString(16).padStart(6, '0')).join('');
const make = (netlist, extra = {}) => ({ nIn: 2, nOut: 1, nState: 0, netlist: '0x' + netlist, ...extra });
const check = (...circuits) => compare(({ id }) => circuits[Number(id) - 1], baseline, candidate);

test('equivalent circuits can use different NAND arrangements', async () => {
  const report = await check(make(nand(2, 3)), make(nand(3, 2)));
  assert.equal(report.status, 'compatible');
  assert.equal(report.checked, 4);
});

test('counterexample is packed LSB-first and preserves output bit positions', async () => {
  const report = await check(make(nand(2, 3)), make(nand(2, 2)));
  assert.equal(report.status, 'behavior-changed');
  assert.equal(report.mismatches, 1);
  assert.deepEqual(report.firstMismatch, {
    input: 1, packedInput: '0x01', baselineOutput: '0x01', candidateOutput: '0x00', changedBits: [0],
  });
});

test('REF binds its inputs in record order and resolves a separate circuit', async () => {
  const ref = '02' + address.slice(2) + '0000000000000003' + '0201' + '000003000002';
  const report = await check(make(nand(2, 3)), make(ref), make(nand(2, 3)));
  assert.equal(report.status, 'compatible');
  assert.equal(Object.keys(report.dependencies).length, 3);
});

test('self-references, truncation and state cannot produce a pass', async () => {
  const self = '02' + address.slice(2) + '0000000000000002' + '0201' + '000002000003';
  for (const invalid of [make(self), make('00'), make(nand(2, 3), { nState: 1 }), make(nand(2, 4))]) {
    assert.equal((await check(make(nand(2, 3)), invalid)).status, 'inconclusive');
  }
});

test('mismatched interfaces are rejected before enumeration', async () => {
  const report = await check(make(nand(2, 3)), make(nand(2, 3), { nIn: 3 }));
  assert.equal(report.status, 'interface-mismatch');
});
