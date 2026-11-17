import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareOnChain, reference, parseBlock, redact, XLAYER } from '../src/xlayer.mjs';
import { VERSION } from '../src/report.mjs';

const address = '0x' + 'ab'.repeat(20);
const word = value => BigInt(value).toString(16).padStart(64, '0');
const abiBytes = bytes => '0x' + word(32) + word(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64 || 64, '0');
const snapshot = { number: '0x123', hash: '0x' + 'cd'.repeat(32), timestamp: '0x6560' };
const NETLISTS = { 1: '00000002000003', 2: '00000002000002', 3: '00000003000002' };  // NAND(a,b), NAND(a,a), NAND(b,a)

// A fake X Layer node. `options` overrides individual behaviors.
function node(context, options = {}) {
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url, request) => {
    const { id, method, params } = JSON.parse(request.body);
    calls.push({ method, params, url });
    const reply = result => Response.json({ jsonrpc: '2.0', id, result });
    const fail = (message, code = -32000) => Response.json({ jsonrpc: '2.0', id, error: { code, message } });
    if (options.down) throw new TypeError('fetch failed');
    if (method === 'eth_chainId') return reply(options.chainId ?? '0xc4');
    if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') {
      const isRecheck = calls.filter(c => c.method === 'eth_getBlockByNumber').length > 1 || (method === 'eth_getBlockByNumber' && params[0] === snapshot.number);
      return reply(isRecheck && options.reorg ? { ...snapshot, hash: '0x' + 'ee'.repeat(32) } : snapshot);
    }
    if (method !== 'eth_call') return fail('unsupported method');
    const [{ to, data }, block] = params;
    if (typeof block === 'object' && options.noBlockHash) return fail('invalid argument 1: cannot unmarshal blockHash', -32602);
    if (typeof block === 'object') assert.deepEqual(block, { blockHash: snapshot.hash, requireCanonical: true });
    else assert.equal(block, snapshot.number);
    const selector = data.slice(2, 10);
    if (to === XLAYER.factory && selector === '5f5a364f') return reply('0x' + word(options.unregistered ? 0 : 1));
    if (to === XLAYER.factory && selector === '631f9852') return reply('0x' + word(0));
    if (to === XLAYER.beacon && selector === '5c60da1b') return reply('0x' + word('0x977f217887e085d298cb3819cdad5a0ee35f29b2'));
    const circuit = Number(BigInt('0x' + data.slice(10, 74)));
    if (!NETLISTS[circuit]) return fail('execution reverted: no circuit', 3);
    if (selector === '084d60f1') return reply('0x' + [2, 1, 0, 1].map(word).join(''));
    if (selector === '3fc4be56') return reply(abiBytes(NETLISTS[circuit]));
    if (selector === '934d06ea') {
      if (options.evalDown) return fail('execution reverted');
      assert.equal(data.slice(74, 202), word(64) + word(1));
      const input = Number.parseInt(data.slice(202, 204), 16);
      const [a, b] = [input & 1, (input >> 1) & 1];
      let out = circuit === 2 ? 1 - a : 1 - (a & b);
      if (options.lyingProcessor && circuit === 2) out = 1 - out;
      return reply(abiBytes(out ? '01' : '00'));
    }
    return fail('unknown selector');
  });
  return calls;
}
const ref = id => reference(address + ':' + id);

test('replays a counterexample with the correct dynamic ABI offset at the pinned block hash', async context => {
  const calls = node(context);
  const report = await compareOnChain(ref(1), ref(2));
  assert.equal(report.schema, 2);
  assert.equal(report.tool.version, VERSION);
  assert.equal(report.status, 'behavior-changed');
  assert.deepEqual(report.comparison.firstMismatch, { input: 1, packedInput: '0x01', baselineOutput: '0x01', candidateOutput: '0x00', changedBits: [0] });
  assert.equal(report.replay.status, 'confirmed');
  assert.equal(report.replay.kind, 'counterexample');
  const evals = calls.filter(c => c.method === 'eth_call' && c.params[0].data.startsWith('0x934d06ea'));
  assert.equal(evals.length, 2);
  assert.equal(evals[0].params[0].data.slice(74), word(64) + word(1) + '01'.padEnd(64, '0'));
  assert.deepEqual(report.block, snapshot);
  assert.equal(report.pinning.method, 'eip-1898-block-hash');
  assert.equal(report.implementation.address, '0x977f217887e085d298cb3819cdad5a0ee35f29b2');
  assert.equal(report.factory.sealed, false);
  assert.equal(report.processors[address].registered, true);
  const dep = report.dependencies[address + ':1'];
  assert.equal(dep.bytes, 7);
  assert.match(dep.sha256, /^[0-9a-f]{64}$/);
  assert.match(dep.keccak256, /^0x[0-9a-f]{64}$/);
  assert.match(report.guarantee, /not a drop-in replacement/);
});

test('falls back to block-number pinning only when the RPC rejects EIP-1898', async context => {
  node(context, { noBlockHash: true });
  const report = await compareOnChain(ref(1), ref(2));
  assert.equal(report.status, 'behavior-changed');
  assert.equal(report.pinning.method, 'block-number');
});

test('a compatible pair is spot-checked against both processors', async context => {
  node(context);
  const report = await compareOnChain(ref(1), ref(3));
  assert.equal(report.status, 'compatible');
  assert.equal(report.comparison.method, 'exhaustive');
  assert.equal(report.replay.kind, 'spot-check');
  assert.equal(report.replay.status, 'confirmed');
  assert.ok(report.replay.inputs >= 2);
});

test('a processor that disagrees with the evaluator makes the result inconclusive', async context => {
  node(context, { lyingProcessor: true });
  const report = await compareOnChain(ref(1), ref(2));
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.code, 'replay-disagrees');
  assert.equal(report.comparison.status, 'different');
  assert.equal(report.replay.status, 'disagrees');
});

test('an unavailable replay keeps a genuine mismatch visible and failing', async context => {
  node(context, { evalDown: true });
  const report = await compareOnChain(ref(1), ref(2));
  assert.equal(report.status, 'behavior-changed');
  assert.equal(report.replay.status, 'unavailable');
  assert.equal(report.comparison.firstMismatch.packedInput, '0x01');
});

test('an unavailable replay on a compatible pair does not upgrade or downgrade the local proof', async context => {
  node(context, { evalDown: true });
  const report = await compareOnChain(ref(1), ref(3));
  assert.equal(report.status, 'compatible');
  assert.equal(report.replay.status, 'unavailable');
});

test('an unreachable RPC is inconclusive, never compatible', async context => {
  node(context, { down: true });
  const report = await compareOnChain(ref(1), ref(3));
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.code, 'rpc-unavailable');
  assert.equal(report.replay.status, 'not-run');
});

test('an RPC for another chain is rejected', async context => {
  node(context, { chainId: '0x1' });
  const report = await compareOnChain(ref(1), ref(3));
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.code, 'wrong-chain');
});

test('a processor that is not registered with the factory is rejected', async context => {
  node(context, { unregistered: true });
  const report = await compareOnChain(ref(1), ref(3));
  assert.equal(report.code, 'unregistered-processor');
});

test('a missing circuit is reported as such', async context => {
  node(context);
  const report = await compareOnChain(ref(1), ref(9));
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.code, 'no-circuit');
});

test('a block replaced during the run is inconclusive', async context => {
  node(context, { reorg: true });
  const report = await compareOnChain(ref(1), ref(3));
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.code, 'block-changed');
});

test('a pinned block hash is read with eth_getBlockByHash', async context => {
  const calls = node(context);
  const report = await compareOnChain(ref(1), ref(2), { block: snapshot.hash });
  assert.equal(report.status, 'behavior-changed');
  assert.ok(calls.some(c => c.method === 'eth_getBlockByHash' && c.params[0] === snapshot.hash));
});

test('RPC credentials never appear in reports', async context => {
  const url = 'https://user:hunter22@xlayer.example/v1/sk_live_0123456789?apikey=SECRETKEY';
  context.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { id } = JSON.parse(request.body);
    return Response.json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'rate limited for ' + _url + ' key SECRETKEY' } });
  });
  const report = await compareOnChain(ref(1), ref(2), { url });
  const text = JSON.stringify(report);
  for (const secret of ['hunter22', 'sk_live_0123456789', 'SECRETKEY', 'xlayer.example/v1']) assert.ok(!text.includes(secret), secret);
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.rpc.endpoint, 'configured (redacted)');
  assert.equal(redact('see ' + url, url), 'see [redacted]');
});

test('oversized RPC responses are refused', async context => {
  context.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(3_000_000)));
  const report = await compareOnChain(ref(1), ref(2));
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.code, 'too-large');
});

test('historical state errors explain how to rerun', async context => {
  context.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { id, method } = JSON.parse(request.body);
    if (method === 'eth_chainId') return Response.json({ jsonrpc: '2.0', id, result: '0xc4' });
    if (method.startsWith('eth_getBlockBy')) return Response.json({ jsonrpc: '2.0', id, result: snapshot });
    return Response.json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'missing trie node abc' } });
  });
  const report = await compareOnChain(ref(1), ref(2), { block: snapshot.hash });
  assert.equal(report.code, 'historical-state-unavailable');
});

test('rejects invalid circuit IDs instead of truncating them', () => {
  for (const id of ['0', '-1', '1.5', (2n ** 64n).toString(), (2n ** 256n).toString()]) {
    assert.throws(() => reference(address + ':' + id));
  }
  assert.deepEqual(reference(' 0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:11 '), { address: '0x57f319cf056f72f48cf1dbb670f2a3db007aa355', id: '11' });
});

test('parses block selectors', () => {
  assert.deepEqual(parseBlock(undefined), { tag: 'latest' });
  assert.deepEqual(parseBlock('76160736'), { number: '0x48a1ee0' });
  assert.deepEqual(parseBlock('0x48A1EE0'), { number: '0x48a1ee0' });
  assert.deepEqual(parseBlock(snapshot.hash.toUpperCase().replace('0X', '0x')), { hash: snapshot.hash });
  assert.throws(() => parseBlock('yesterday'));
});
