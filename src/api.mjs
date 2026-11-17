// HTTP API shared by the Node server (server.mjs) and the Cloudflare Worker (worker.mjs).
// Returns plain { status, body, headers } results so each host only adapts the transport.
import { compareOnChain, reference, parseBlock, createRpc, defaultRpc, CheckError } from './xlayer.mjs';
import { VERSION } from './report.mjs';

// The public workbench answers within seconds; the CLI and GitHub Action allow wider circuits.
export const WEB_LIMITS = { maxExhaustiveBits: 24, maxWork: 2 ** 28, sampleWords: 2 ** 13, deadlineMs: 20000 };
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const TRANSIENT = new Set(['rpc-unavailable', 'rpc-timeout', 'rpc-error', 'historical-state-unavailable', 'block-changed', 'time-budget', 'error']);
const CACHE_SIZE = 200;

export function createApi({ rpc = defaultRpc, maxActive = 4, log = () => {} } = {}) {
  const cache = new Map();          // pinned comparison results, LRU by insertion order
  const inflight = new Map();       // identical requests share one run
  const activeByClient = new Map();
  let active = 0;
  const pair = (a, b) => a.address + ':' + a.id + '|' + b.address + ':' + b.id;

  function remember(key, report) {
    cache.delete(key);
    cache.set(key, report);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  }

  async function runCompare(baseline, candidate, block) {
    if (block.hash && cache.has(pair(baseline, candidate) + '|' + block.hash)) return { report: cache.get(pair(baseline, candidate) + '|' + block.hash), cache: 'hit' };
    const key = pair(baseline, candidate) + '|' + (block.hash ?? block.number ?? 'latest');
    if (inflight.has(key)) return { report: await inflight.get(key), cache: 'shared' };
    const promise = compareOnChain(baseline, candidate, { url: rpc, block: block.hash ?? block.number ?? 'latest', limits: WEB_LIMITS });
    inflight.set(key, promise);
    try {
      const report = await promise;
      if (report.block?.hash && !TRANSIENT.has(report.code)) remember(pair(baseline, candidate) + '|' + report.block.hash, report);
      return { report, cache: 'miss' };
    } finally {
      inflight.delete(key);
    }
  }

  async function health(deep) {
    const body = { ok: true, version: VERSION, rpc: rpc === defaultRpc ? defaultRpc : 'configured', active, cached: cache.size };
    if (!deep) return { status: 200, body };
    try {
      const chain = await createRpc(rpc, { signal: AbortSignal.timeout(5000) })('eth_chainId', []);
      body.chainId = Number(BigInt(chain));
      if (body.chainId !== 196) throw new CheckError('wrong chain', 'wrong-chain');
      return { status: 200, body };
    } catch (error) {
      return { status: 503, body: { ...body, ok: false, rpcError: error.code ?? 'error' } };
    }
  }

  async function compare(searchParams, client) {
    let baseline, candidate, block;
    try {
      baseline = reference(searchParams.get('baseline'));
      candidate = reference(searchParams.get('candidate'));
      block = parseBlock(searchParams.get('block'));
    } catch (error) {
      return { status: 400, body: { reason: error.message, code: 'invalid-input' } };
    }
    if (active >= maxActive || (activeByClient.get(client) ?? 0) >= 1) {
      return { status: 429, body: { reason: 'PinCheck is busy with another comparison. Try again in a few seconds.', code: 'busy' }, headers: { 'retry-after': '5' } };
    }
    const started = Date.now();
    active++;
    activeByClient.set(client, (activeByClient.get(client) ?? 0) + 1);
    try {
      const { report, cache: cacheState } = await runCompare(baseline, candidate, block);
      log({ at: new Date().toISOString(), event: 'compare', status: report.status, code: report.code, ms: Date.now() - started, cache: cacheState });
      return { status: 200, body: report, headers: { 'x-pincheck-cache': cacheState } };
    } finally {
      active--;
      const remaining = activeByClient.get(client) - 1;
      if (remaining) activeByClient.set(client, remaining); else activeByClient.delete(client);
    }
  }

  // Resolves API paths; returns null for anything else so the host can serve static files.
  return {
    async handle(method, pathname, searchParams, client) {
      if (!pathname.startsWith('/api/')) return null;
      if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: { reason: 'Use GET', code: 'method' }, headers: { allow: 'GET, HEAD' } };
      if (pathname === '/api/health') return health(searchParams.get('deep') === '1');
      if (pathname === '/api/compare') return compare(searchParams, client);
      return { status: 404, body: { reason: 'Not found', code: 'not-found' } };
    },
    get active() { return active; },
  };
}
