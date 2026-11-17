import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareOnChain, reference } from '../src/xlayer.mjs';

const address = '0x' + 'ab'.repeat(20);
const word = value => BigInt(value).toString(16).padStart(64, '0');
const abiBytes = bytes => '0x' + word(32) + word(bytes.length / 2) + bytes.padEnd(64, '0');

test('replays a counterexample with the correct dynamic ABI offset at the pinned block', async context => {
  const replays = [];
  const snapshot = { number: '0x123', hash: '0x' + 'ab'.repeat(32) };
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { id, method, params } = JSON.parse(options.body);
    let result;
    if (method === 'eth_chainId') result = '0xc4';
    if (method === 'eth_getBlockByNumber') result = snapshot;
    if (method === 'eth_call') {
      const [{ data }, block] = params;
      assert.equal(block, snapshot.number);
      const selector = data.slice(0, 10);
      const candidate = data.slice(10, 74) === word(2);
      if (selector === '0x084d60f1') result = '0x' + [2, 1, 0, 1].map(word).join('');
      if (selector === '0x3fc4be56') result = abiBytes(candidate ? '00000002000002' : '00000002000003');
      if (selector === '0x934d06ea') {
        assert.equal(data.slice(74), word(64) + word(1) + '01'.padEnd(64, '0'));
        replays.push(data);
        result = abiBytes(candidate ? '00' : '01');
      }
    }
    return Response.json({ id, result });
  });
  const report = await compareOnChain(reference(address + ':1'), reference(address + ':2'));
  assert.equal(report.status, 'behavior-changed');
  assert.equal(report.replay.status, 'confirmed');
  assert.equal(replays.length, 2);
  assert.equal(report.block.hash, snapshot.hash);
});

test('rejects invalid circuit IDs instead of truncating them', () => {
  for (const id of ['0', '-1', '1.5', (2n ** 256n).toString()]) {
    assert.throws(() => reference(address + ':' + id));
  }
});
