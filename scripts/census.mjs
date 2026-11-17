#!/usr/bin/env node
// Census of every TapeOut circuit on X Layer mainnet, pinned to one block hash: what PinCheck can prove today.
// Writes docs/census.json.   node scripts/census.mjs
import { writeFile } from 'node:fs/promises';
import { XLAYER, defaultRpc } from '../src/xlayer.mjs';
import { DEFAULT_LIMITS } from '../src/compare.mjs';
import { WEB_LIMITS } from '../src/api.mjs';

const url = process.env.X_LAYER_RPC || defaultRpc;
const word = value => BigInt(value).toString(16).padStart(64, '0');
const SEL = { cpuCount: 'a94da8a7', cpuAt: '4bc7cbbd', nextId: '61b8ce8c', circuitInfo: '084d60f1' };
let pin;

// One JSON-RPC batch. A non-array reply (rate limit, batch error) or HTTP failure is retried with backoff.
async function post(body) {
  for (let attempt = 1; ; attempt++) {
    let problem;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const reply = response.ok ? await response.json() : null;
      if (Array.isArray(reply)) return reply;
      problem = response.ok ? JSON.stringify(reply?.error ?? reply).slice(0, 120) : 'HTTP ' + response.status;
    } catch (error) {
      problem = error.message;
    }
    if (attempt === 8) throw new Error('RPC failed: ' + problem);
    await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt));
  }
}

// eth_call in JSON-RPC batches of 10 (the endpoint's limit), four batches in flight; reverted calls come back as null.
async function calls(list, size = 10, parallel = 4) {
  const out = new Array(list.length).fill(null);
  let next = 0, done = 0;
  async function lane() {
    while (next < list.length) {
      const start = next;
      next += size;
      const chunk = list.slice(start, start + size);
      const replies = await post(chunk.map(([to, data], j) => ({ jsonrpc: '2.0', id: j, method: 'eth_call', params: [{ to, data: '0x' + data }, pin] })));
      for (const reply of replies) if (Number.isInteger(reply.id) && reply.id < chunk.length) out[start + reply.id] = reply.result ?? null;
      done += chunk.length;
      if (list.length > 100) process.stderr.write('\r  ' + done + '/' + list.length);
    }
  }
  await Promise.all(Array.from({ length: parallel }, lane));
  if (list.length > 100) process.stderr.write('\n');
  return out;
}

const [{ result: block }] = await post([{ jsonrpc: '2.0', id: 0, method: 'eth_getBlockByNumber', params: ['latest', false] }]);
pin = { blockHash: block.hash, requireCanonical: true };
const [count] = await calls([[XLAYER.factory, SEL.cpuCount]]);
const processors = (await calls(Array.from({ length: Number(BigInt(count)) }, (_, i) => [XLAYER.factory, SEL.cpuAt + word(i)])))
  .map(r => '0x' + r.slice(26));
const nextIds = (await calls(processors.map(p => [p, SEL.nextId]))).map(r => r ? Number(BigInt(r)) : 1);
const refs = processors.flatMap((p, i) => Array.from({ length: Math.max(0, nextIds[i] - 1) }, (_, k) => [p, k + 1]));
const infos = await calls(refs.map(([p, id]) => [p, SEL.circuitInfo + word(id)]));

// Classify every circuit by the strongest result PinCheck can give for a changed candidate of the same shape.
const classes = { webExhaustive: 0, ciExhaustive: 0, wideStateless: 0, stateful: 0, tooLarge: 0, unreadable: 0 };
const byInputs = {};
let gates = 0;
infos.forEach(info => {
  if (!info || info.length !== 258) return classes.unreadable++;
  const [nIn, , nState, gateCount] = [0, 64, 128, 192].map(o => Number(BigInt('0x' + info.slice(2 + o, 66 + o))));
  gates += gateCount;
  byInputs[nIn > 64 ? '65+' : nIn > 32 ? '33-64' : nIn > 26 ? '27-32' : nIn > 24 ? '25-26' : nIn > 8 ? '9-24' : '0-8'] =
    (byInputs[nIn > 64 ? '65+' : nIn > 32 ? '33-64' : nIn > 26 ? '27-32' : nIn > 24 ? '25-26' : nIn > 8 ? '9-24' : '0-8'] ?? 0) + 1;
  const work = (nIn <= 5 ? 1 : 2 ** (nIn - 5)) * gateCount * 2;
  if (gateCount > DEFAULT_LIMITS.maxExpandedGates) classes.tooLarge++;
  else if (nState > 0) classes.stateful++;
  else if (nIn <= WEB_LIMITS.maxExhaustiveBits && work <= WEB_LIMITS.maxWork) classes.webExhaustive++;
  else if (nIn <= DEFAULT_LIMITS.maxExhaustiveBits && work <= DEFAULT_LIMITS.maxWork) classes.ciExhaustive++;
  else classes.wideStateless++;
});

const circuits = infos.length;
const census = {
  description: 'Every circuit on every processor registered with the X Layer TapeOut factory, read at one block hash by scripts/census.mjs.',
  chain: 196, block: { number: Number(BigInt(block.number)), hash: block.hash, timestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() },
  factory: XLAYER.factory, processors: processors.length, processorsWithCircuits: nextIds.filter(n => n > 1).length, circuits, gates,
  classes, inputBits: byInputs,
  meaning: {
    webExhaustive: 'stateless and small enough to check every input in the web workbench',
    ciExhaustive: 'stateless; every input checked by the CLI and GitHub Action (not the web workbench)',
    wideStateless: 'stateless but too wide to enumerate: identical-netlist proof or sampled counterexample only',
    stateful: 'has LATCH state: proven only when byte-identical',
    tooLarge: 'more gates than PinCheck evaluates',
    unreadable: 'circuitInfo did not return a TAP-02 answer',
  },
};
await writeFile(new URL('../docs/census.json', import.meta.url), JSON.stringify(census, null, 2) + '\n');
const pct = n => (100 * n / circuits).toFixed(1) + '%';
console.log(`${circuits} circuits on ${census.processorsWithCircuits}/${processors.length} processors at block ${census.block.number}`);
for (const [k, v] of Object.entries(classes)) console.log('  ' + k.padEnd(14), String(v).padStart(6), pct(v));
console.log('  inputs', JSON.stringify(byInputs));
