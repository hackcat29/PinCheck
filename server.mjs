import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { compareOnChain, reference, parseBlock, createRpc, defaultRpc, CheckError } from './src/xlayer.mjs';
import { renderMarkdown } from './src/markdown.mjs';
import { VERSION } from './src/report.mjs';

const config = {
  port: Number(process.env.PORT ?? 4173),
  host: process.env.HOST ?? '127.0.0.1',
  rpc: process.env.X_LAYER_RPC || defaultRpc,
  maxActive: Number(process.env.PINCHECK_MAX_CONCURRENCY ?? 4),
  trustProxy: process.env.PINCHECK_TRUST_PROXY === '1',
};
// The public workbench answers within seconds; the CLI and GitHub Action allow wider circuits.
export const WEB_LIMITS = { maxExhaustiveBits: 24, maxWork: 2 ** 28, sampleWords: 2 ** 13, deadlineMs: 20000 };
const TRANSIENT = new Set(['rpc-unavailable', 'rpc-timeout', 'rpc-error', 'historical-state-unavailable', 'block-changed', 'time-budget', 'error']);
const root = new URL('./', import.meta.url);
const STATIC = {
  '/': ['web/index.html', 'text/html'],
  '/style.css': ['web/style.css', 'text/css'],
  '/app.mjs': ['web/app.mjs', 'text/javascript'],
  '/docs.mjs': ['web/docs.mjs', 'text/javascript'],
  '/report.mjs': ['src/report.mjs', 'text/javascript'],
  '/favicon.svg': ['web/favicon.svg', 'image/svg+xml'],
  '/examples/index.json': ['examples/index.json', 'application/json'],
  '/examples/orderguard-1-to-11.json': ['examples/orderguard-1-to-11.json', 'application/json'],
  '/examples/orderguard-1-to-2.json': ['examples/orderguard-1-to-2.json', 'application/json'],
  '/examples/neon-reliquary-5-vs-7.json': ['examples/neon-reliquary-5-vs-7.json', 'application/json'],
  '/demo/incompatible.json': ['demo/incompatible.json', 'application/json'],
  '/demo/compatible.json': ['demo/compatible.json', 'application/json'],
};
const HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const cache = new Map();          // pinned comparison results, LRU by insertion order
const inflight = new Map();       // identical requests share one run
const activeByClient = new Map();
let active = 0;
const CACHE_SIZE = 200;

function remember(key, report) {
  cache.delete(key);
  cache.set(key, report);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
}

async function runCompare(baseline, candidate, block) {
  const pinned = block.hash ? baseline.address + ':' + baseline.id + '|' + candidate.address + ':' + candidate.id + '|' + block.hash : null;
  if (pinned && cache.has(pinned)) return { report: cache.get(pinned), cache: 'hit' };
  const key = baseline.address + ':' + baseline.id + '|' + candidate.address + ':' + candidate.id + '|' + (block.hash ?? block.number ?? 'latest');
  if (inflight.has(key)) return { report: await inflight.get(key), cache: 'shared' };
  const promise = compareOnChain(baseline, candidate, { url: config.rpc, block: block.hash ?? block.number ?? 'latest', limits: WEB_LIMITS });
  inflight.set(key, promise);
  try {
    const report = await promise;
    if (report.block?.hash && !TRANSIENT.has(report.code)) {
      remember(baseline.address + ':' + baseline.id + '|' + candidate.address + ':' + candidate.id + '|' + report.block.hash, report);
    }
    return { report, cache: 'miss' };
  } finally {
    inflight.delete(key);
  }
}

let docs;
async function docsPage() {
  if (docs && process.env.NODE_ENV === 'production') return docs;
  const [template, source] = await Promise.all([readFile(new URL('web/docs.html', root), 'utf8'), readFile(new URL('docs/install.md', root), 'utf8')]);
  const { html, toc } = renderMarkdown(source.replace(/^# .*\n/, ''));
  const nav = toc.map(({ id, text }) => '<li><a href="#' + id + '">' + text + '</a></li>').join('');
  docs = template.replace('<!--TOC-->', nav).replace('<!--DOCS-->', html).replace(/\{\{VERSION\}\}/g, VERSION);
  return docs;
}

function clientOf(req) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export const server = createServer(async (req, res) => {
  const started = Date.now();
  const send = (status, body, type = 'application/json', extra = {}) => {
    res.writeHead(status, { ...HEADERS, 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', ...extra });
    res.end(req.method === 'HEAD' ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { reason: 'Use GET', code: 'method' }, 'application/json', { allow: 'GET, HEAD' });

    if (pathname === '/api/health') {
      const body = { ok: true, version: VERSION, rpc: config.rpc === defaultRpc ? defaultRpc : 'configured', active, cached: cache.size };
      if (searchParams.get('deep') === '1') {
        try {
          const chain = await createRpc(config.rpc, { signal: AbortSignal.timeout(5000) })('eth_chainId', []);
          body.chainId = Number(BigInt(chain));
          if (body.chainId !== 196) throw new CheckError('wrong chain', 'wrong-chain');
        } catch (error) {
          return send(503, { ...body, ok: false, rpcError: error.code ?? 'error' });
        }
      }
      return send(200, body);
    }

    if (pathname === '/api/compare') {
      let baseline, candidate, block;
      try {
        baseline = reference(searchParams.get('baseline'));
        candidate = reference(searchParams.get('candidate'));
        block = parseBlock(searchParams.get('block'));
      } catch (error) {
        return send(400, { reason: error.message, code: 'invalid-input' });
      }
      const client = clientOf(req);
      if (active >= config.maxActive || (activeByClient.get(client) ?? 0) >= 1) {
        return send(429, { reason: 'PinCheck is busy with another comparison. Try again in a few seconds.', code: 'busy' }, 'application/json', { 'retry-after': '5' });
      }
      active++;
      activeByClient.set(client, (activeByClient.get(client) ?? 0) + 1);
      try {
        const { report, cache: cacheState } = await runCompare(baseline, candidate, block);
        console.log(JSON.stringify({ at: new Date().toISOString(), event: 'compare', status: report.status, code: report.code, ms: Date.now() - started, cache: cacheState }));
        return send(200, report, 'application/json', { 'x-pincheck-cache': cacheState });
      } finally {
        active--;
        const remaining = activeByClient.get(client) - 1;
        if (remaining) activeByClient.set(client, remaining); else activeByClient.delete(client);
      }
    }

    if (pathname === '/docs' || pathname === '/docs/') return send(200, await docsPage(), 'text/html', { 'cache-control': 'no-cache' });
    if (!Object.hasOwn(STATIC, pathname)) return send(404, { reason: 'Not found', code: 'not-found' });
    const [file, type] = STATIC[pathname];
    let data = await readFile(new URL(file, root));
    if (pathname === '/') data = data.toString('utf8').replace(/\{\{VERSION\}\}/g, VERSION);
    return send(200, data, type, { 'cache-control': pathname.startsWith('/examples/') || pathname.startsWith('/demo/') ? 'public, max-age=300' : 'no-cache' });
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), event: 'error', message: error.message }));
    if (!res.headersSent) send(500, { reason: 'Unexpected server error', code: 'server' });
  }
});

server.requestTimeout = 75000;
server.headersTimeout = 10000;

if (import.meta.url === 'file://' + process.argv[1] || process.argv[1]?.endsWith('server.mjs')) {
  server.listen(config.port, config.host, function () {
    console.log('PinCheck ' + VERSION + ' listening on http://' + config.host + ':' + this.address().port);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
