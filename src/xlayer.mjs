import { createHash } from 'node:crypto';
import { compare, hex, refKey } from './compare.mjs';
import { keccak256 } from './keccak.mjs';
import { guaranteeFor, VERSION, SCHEMA } from './report.mjs';

export const defaultRpc = 'https://rpc.xlayer.tech';
// TapeOut deployments on X Layer mainnet, listed in TAP-10 and read back on chain (see README).
export const XLAYER = Object.freeze({
  chainId: 196,
  name: 'X Layer mainnet',
  factory: '0x1f09daefa827f02cbb40967cc91b259763760761',
  beacon: '0xf70d1ed4f62cf3780157b0b421b7e2f45bd0991c',
});
const SELECTOR = {
  circuitInfo: '084d60f1', netlist: '3fc4be56', eval: '934d06ea',
  isCPU: '5f5a364f', implementation: '5c60da1b', isSealed: '631f9852',
};
const word = value => BigInt(value).toString(16).padStart(64, '0');
const MAX_RESPONSE_BYTES = 2_500_000;
const MAX_CALLS = 400;

export class CheckError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function reference(value) {
  const match = /^(0x[0-9a-f]{40}):([1-9][0-9]{0,77})$/i.exec(String(value ?? '').trim());
  if (!match || BigInt(match[2]) >= 2n ** 64n) {
    throw new CheckError('Use a processor address, a colon, and a circuit ID, for example 0x57F3…a355:1', 'invalid-input');
  }
  return { address: match[1].toLowerCase(), id: match[2] };
}

export function parseBlock(value) {
  if (value == null || value === '' || value === 'latest') return { tag: 'latest' };
  const text = String(value).trim();
  if (/^0x[0-9a-f]{64}$/i.test(text)) return { hash: text.toLowerCase() };
  if (/^0x[0-9a-f]{1,16}$/i.test(text)) return { number: '0x' + BigInt(text).toString(16) };
  if (/^[0-9]{1,19}$/.test(text)) return { number: '0x' + BigInt(text).toString(16) };
  throw new CheckError('Block must be latest, a block number, or a 32-byte block hash', 'invalid-input');
}

// Strings that must never appear in errors or reports: the endpoint and any credential-like parts of it.
function secretsOf(url) {
  try {
    const parsed = new URL(url);
    return [url, parsed.username, parsed.password, ...parsed.pathname.split('/').filter(part => part.length >= 8),
      ...[...parsed.searchParams.values()].filter(value => value.length >= 4)].filter(Boolean);
  } catch {
    return [url].filter(Boolean);
  }
}

export function redact(message, url) {
  let text = String(message ?? '');
  for (const secret of secretsOf(url).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.slice(0, 300);
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const RETRY_ATTEMPTS = 3;

export function createRpc(url = defaultRpc, { signal, transport = globalThis.process?.env?.PINCHECK_RPC_TRANSPORT, maxCalls = MAX_CALLS, retryDelayMs = 300 } = {}) {
  let id = 0;
  const budget = signal ?? AbortSignal.timeout(60000);
  const wait = ms => new Promise((resolve, reject) => {
    if (budget.aborted) return reject(new CheckError('X Layer RPC timed out', 'rpc-timeout'));
    const timer = setTimeout(resolve, ms);
    budget.addEventListener('abort', () => { clearTimeout(timer); reject(new CheckError('X Layer RPC timed out', 'rpc-timeout')); }, { once: true });
  });

  // One HTTP exchange. Rate limits and gateway errors are marked retryable; everything else is final.
  async function send(payload) {
    const callSignal = AbortSignal.any([budget, AbortSignal.timeout(15000)]);
    try {
      if (transport === 'curl') {
        // Loaded only when requested, so runtimes without child processes (Workers) never touch it.
        const [{ execFile }, { promisify }] = await Promise.all([import('node:child_process'), import('node:util')]);
        const { stdout } = await promisify(execFile)('curl', [
          '--disable', '--silent', '--show-error', '--fail', '--max-time', '14', '--max-filesize', String(MAX_RESPONSE_BYTES),
          '--header', 'content-type: application/json', '--data-binary', payload, '--', url,
        ], { signal: callSignal, maxBuffer: MAX_RESPONSE_BYTES });
        return { text: stdout };
      }
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal: callSignal });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new CheckError('X Layer RPC returned HTTP ' + response.status, 'rpc-unavailable');
        if (RETRY_STATUS.has(response.status)) return { retry: error, after: Number(response.headers.get('retry-after')) };
        throw error;
      }
      return { text: await readLimited(response, MAX_RESPONSE_BYTES) };
    } catch (error) {
      if (error instanceof CheckError) throw error;
      if (error.code === 'ENOENT') throw new CheckError('The curl RPC transport requires curl to be installed', 'rpc-unavailable');
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError' || error.killed;
      throw new CheckError(timedOut ? 'X Layer RPC timed out' : 'X Layer RPC could not be reached', timedOut ? 'rpc-timeout' : 'rpc-unavailable');
    }
  }

  return async function rpc(method, params) {
    if (id >= maxCalls) throw new CheckError('The comparison needed more than ' + maxCalls + ' RPC calls', 'too-large');
    const requestId = ++id;
    const payload = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
    for (let attempt = 1; ; attempt++) {
      const { text, retry, after } = await send(payload);
      let body;
      if (!retry) {
        try { body = JSON.parse(text); } catch { throw new CheckError('X Layer RPC returned a response that is not JSON', 'rpc-unavailable'); }
      }
      const limited = retry ?? (body?.error && (body.error.code === -32005 || /rate limit|too many requests/i.test(body.error.message ?? ''))
        ? new CheckError('X Layer RPC rate limit: ' + redact(body.error.message, url), 'rpc-unavailable') : null);
      if (limited) {
        if (attempt >= RETRY_ATTEMPTS) throw limited;
        // Honor Retry-After up to 2 s, otherwise back off exponentially with jitter.
        const delay = after > 0 ? Math.min(after * 1000, 2000) : retryDelayMs * 3 ** (attempt - 1) * (0.75 + Math.random() / 2);
        await wait(delay);
        continue;
      }
      if (body?.error) throw rpcError(body.error, url);
      if (body?.id !== requestId || body.result === undefined) throw new CheckError('X Layer RPC returned no result', 'rpc-unavailable');
      return body.result;
    }
  };
}

async function readLimited(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new CheckError('X Layer RPC response exceeded ' + limit + ' bytes', 'too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

function rpcError(error, url) {
  const message = redact(error.message ?? 'RPC error', url);
  if (/no circuit/i.test(message)) return new CheckError('The circuit does not exist on that processor', 'no-circuit');
  if (/missing trie node|header not found|state.*(not available|pruned|unavailable)|historical state|required historical/i.test(message)) {
    return new CheckError('This RPC no longer serves state for the requested block. Use an archive RPC to rerun it', 'historical-state-unavailable');
  }
  if (/block .*not found|unknown block/i.test(message)) return new CheckError('The requested block was not found on X Layer', 'block-not-found');
  if (/not canonical|non-canonical/i.test(message)) return new CheckError('The pinned block is no longer canonical', 'block-changed');
  const unsupportedPin = error.code === -32602 || /blockHash|cannot unmarshal|invalid argument/i.test(message);
  return new CheckError('X Layer RPC error: ' + message, unsupportedPin ? 'rpc-unsupported-param' : 'rpc-error');
}

function decodeBytes(value) {
  if (value.length < 128 || value.slice(0, 64) !== word(32)) throw new CheckError('Unexpected processor ABI response', 'unsupported-processor');
  const length = Number(BigInt('0x' + value.slice(64, 128)));
  if (value.length !== 128 + Math.ceil(length / 32) * 64) throw new CheckError('Malformed processor byte response', 'unsupported-processor');
  return '0x' + value.slice(128, 128 + length * 2);
}

const decodeWord = value => {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new CheckError('Unexpected processor ABI response', 'unsupported-processor');
  return BigInt('0x' + value);
};

export async function compareOnChain(baseline, candidate, { url = defaultRpc, block = 'latest', limits, signal, rpc } = {}) {
  const report = {
    schema: SCHEMA,
    tool: { name: 'pincheck', version: VERSION },
    chain: { id: XLAYER.chainId, name: XLAYER.name },
    rpc: { endpoint: url === defaultRpc ? defaultRpc : 'configured (redacted)' },
    baseline, candidate,
  };
  const budget = AbortSignal.any([signal ?? AbortSignal.timeout(60000), AbortSignal.timeout(60000)]);
  const call = rpc ?? createRpc(url, { signal: budget });
  let pin;
  const ethCall = async (to, data) => {
    const value = await call('eth_call', [{ to, data: '0x' + data }, pin]);
    if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new CheckError('Invalid eth_call response', 'rpc-error');
    return value.slice(2).toLowerCase();
  };
  try {
    const target = parseBlock(block);
    const [chainId, snapshot] = await Promise.all([
      call('eth_chainId', []),
      target.hash ? call('eth_getBlockByHash', [target.hash, false]) : call('eth_getBlockByNumber', [target.number ?? 'latest', false]),
    ]);
    if (BigInt(chainId) !== BigInt(XLAYER.chainId)) throw new CheckError('The RPC is not X Layer mainnet (chain 196)', 'wrong-chain');
    if (!snapshot?.hash || !snapshot?.number) throw new CheckError('The requested block was not found on X Layer', 'block-not-found');
    report.block = { number: snapshot.number, hash: snapshot.hash, timestamp: snapshot.timestamp };

    // Prefer EIP-1898 block-hash calls; fall back to the block number only when the RPC rejects the parameter.
    pin = { blockHash: snapshot.hash, requireCanonical: true };
    report.pinning = { method: 'eip-1898-block-hash', requireCanonical: true };
    const registered = async address => decodeWord(await ethCall(XLAYER.factory, SELECTOR.isCPU + word(address))) === 1n;
    let baseRegistered;
    try {
      baseRegistered = await registered(baseline.address);
    } catch (error) {
      if (error.code !== 'rpc-unsupported-param') throw error;
      pin = snapshot.number;
      report.pinning = { method: 'block-number', note: 'RPC rejected EIP-1898 block-hash calls; the block hash is rechecked after the run' };
      baseRegistered = await registered(baseline.address);
    }
    const candRegistered = baseline.address === candidate.address ? baseRegistered : await registered(candidate.address);
    report.processors = { [baseline.address]: { registered: baseRegistered }, [candidate.address]: { registered: candRegistered } };
    const [implementation, sealed] = await Promise.all([
      ethCall(XLAYER.beacon, SELECTOR.implementation),
      ethCall(XLAYER.factory, SELECTOR.isSealed),
    ]);
    report.factory = { address: XLAYER.factory, sealed: decodeWord(sealed) === 1n };
    report.implementation = { beacon: XLAYER.beacon, address: '0x' + implementation.slice(24) };
    for (const [address, ok] of [[baseline.address, baseRegistered], [candidate.address, candRegistered]]) {
      if (!ok) throw new CheckError(address + ' is not a TapeOut processor registered with the X Layer factory', 'unregistered-processor');
    }

    const reader = {
      async info({ address, id }) {
        const info = await ethCall(address, SELECTOR.circuitInfo + word(id));
        if (info.length !== 256) throw new CheckError('Unexpected circuitInfo response', 'unsupported-processor');
        const [nIn, nOut, nState, gateCount] = [0, 64, 128, 192].map(offset => Number(decodeWord(info.slice(offset, offset + 64))));
        return { nIn, nOut, nState, gateCount };
      },
      async netlist({ address, id }) {
        return decodeBytes(await ethCall(address, SELECTOR.netlist + word(id)));
      },
    };
    const { dependencies, probes, ...result } = await compare(reader, baseline, candidate, { limits });
    Object.assign(report, result);
    report.dependencies = Object.fromEntries(Object.entries(dependencies).map(([key, { bytes, ...info }]) => [key, {
      ...info, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      keccak256: '0x' + keccak256(bytes),
    }]));
    if (result.code && ['rpc-unavailable', 'rpc-timeout', 'rpc-error', 'historical-state-unavailable', 'block-changed'].includes(result.code)) {
      throw new CheckError(result.reason, result.code);
    }

    report.replay = await replay(report, probes, ethCall);
    if (report.replay.status === 'disagrees') {
      report.status = 'inconclusive';
      report.code = 'replay-disagrees';
      report.reason = 'A deployed processor returned a different output than the local evaluator';
    }
    const canonical = await call('eth_getBlockByNumber', [snapshot.number, false]);
    if (canonical?.hash !== snapshot.hash) throw new CheckError('The pinned block was replaced during the run', 'block-changed');
  } catch (error) {
    report.status = 'inconclusive';
    report.code = error.code ?? 'error';
    report.reason = redact(error.message, url);
    report.replay ??= { status: 'not-run' };
  }
  report.guarantee = guaranteeFor(report);
  report.generatedAt = new Date().toISOString();
  return order(report);
}

async function replay(report, probes, ethCall) {
  const comparison = report.comparison ?? {};
  const evaluate = async ({ address, id }, packedInput) => {
    const bytes = packedInput.slice(2);
    const args = word(64) + word(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
    return decodeBytes(await ethCall(address, SELECTOR.eval + word(id) + args));
  };
  let checks;
  if (comparison.status === 'different') checks = [comparison.firstMismatch];
  else if (comparison.status === 'equivalent' && probes?.length) checks = probes;
  else return { status: 'not-applicable', reason: report.status === 'inconclusive' ? 'No result to replay' : 'No evaluable input to replay' };
  const kind = comparison.status === 'different' ? 'counterexample' : 'spot-check';
  try {
    const results = [];
    for (const check of checks) {
      const [baselineOutput, candidateOutput] = await Promise.all([evaluate(report.baseline, check.packedInput), evaluate(report.candidate, check.packedInput)]);
      results.push({ packedInput: check.packedInput, expected: [check.baselineOutput, check.candidateOutput], actual: [baselineOutput, candidateOutput] });
    }
    const agrees = results.every(r => r.actual[0] === r.expected[0] && r.actual[1] === r.expected[1]);
    const first = results[0];
    return { status: agrees ? 'confirmed' : 'disagrees', kind, inputs: results.length, baselineOutput: first.actual[0], candidateOutput: first.actual[1], checks: results };
  } catch (error) {
    if (['historical-state-unavailable', 'block-changed'].includes(error.code)) throw error;
    return { status: 'unavailable', kind, reason: error.message };
  }
}

const KEY_ORDER = ['schema', 'tool', 'status', 'code', 'reason', 'guarantee', 'baseline', 'candidate', 'interface', 'comparison', 'replay',
  'chain', 'block', 'pinning', 'processors', 'factory', 'implementation', 'dependencies', 'rpc', 'generatedAt'];
function order(report) {
  return Object.fromEntries([...KEY_ORDER.filter(key => key in report).map(key => [key, report[key]]),
    ...Object.entries(report).filter(([key]) => !KEY_ORDER.includes(key))]);
}

export { refKey, hex };
