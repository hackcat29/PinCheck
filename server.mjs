import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { defaultRpc } from './src/xlayer.mjs';
import { renderDocsPage } from './src/markdown.mjs';
import { VERSION } from './src/report.mjs';
import { createApi, SECURITY_HEADERS, WEB_LIMITS } from './src/api.mjs';

const config = {
  port: Number(process.env.PORT ?? 4173),
  host: process.env.HOST ?? '127.0.0.1',
  rpc: process.env.X_LAYER_RPC || defaultRpc,
  maxActive: Number(process.env.PINCHECK_MAX_CONCURRENCY ?? 4),
  trustProxy: process.env.PINCHECK_TRUST_PROXY === '1',
};
export { WEB_LIMITS };
const api = createApi({ rpc: config.rpc, maxActive: config.maxActive, log: event => console.log(JSON.stringify(event)) });
const root = new URL('./', import.meta.url);
const STATIC = {
  '/': ['web/index.html', 'text/html'],
  '/style.css': ['web/style.css', 'text/css'],
  '/app.mjs': ['web/app.mjs', 'text/javascript'],
  '/docs.mjs': ['web/docs.mjs', 'text/javascript'],
  '/report.mjs': ['src/report.mjs', 'text/javascript'],
  '/favicon.svg': ['web/favicon.svg', 'image/svg+xml'],
  '/llms.txt': ['web/llms.txt', 'text/plain'],
  '/examples/index.json': ['examples/index.json', 'application/json'],
  '/examples/netlists.json': ['examples/netlists.json', 'application/json'],
  '/examples/orderguard-1-to-11.json': ['examples/orderguard-1-to-11.json', 'application/json'],
  '/examples/orderguard-1-to-2.json': ['examples/orderguard-1-to-2.json', 'application/json'],
  '/examples/neon-reliquary-5-vs-7.json': ['examples/neon-reliquary-5-vs-7.json', 'application/json'],
  '/demo/incompatible.json': ['demo/incompatible.json', 'application/json'],
  '/demo/compatible.json': ['demo/compatible.json', 'application/json'],
};
// Directories served by file name. Only plain names with an allowed extension resolve.
const DIRS = {
  '/vendor/': ['web/vendor/', { '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.md': 'text/markdown', '.json': 'application/json' }],
  '/landing/': ['web/landing/', { '.mjs': 'text/javascript' }],
};
function resolveStatic(pathname) {
  if (Object.hasOwn(STATIC, pathname)) return STATIC[pathname];
  for (const [prefix, [dir, types]] of Object.entries(DIRS)) {
    if (!pathname.startsWith(prefix)) continue;
    const name = pathname.slice(prefix.length);
    const ext = name.slice(name.lastIndexOf('.'));
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(name) && !name.includes('..') && Object.hasOwn(types, ext)) return [dir + name, types[ext]];
  }
  return null;
}
const TEXT = /^(text\/|application\/json|image\/svg)/;
const gzipped = new Map();  // path -> { mtime, body }
async function compressed(file, data) {
  const { mtimeMs } = await stat(new URL(file, root));
  const hit = gzipped.get(file);
  if (hit?.mtime === mtimeMs) return hit.body;
  const body = gzipSync(data, { level: 9 });
  gzipped.set(file, { mtime: mtimeMs, body });
  return body;
}

const HEADERS = SECURITY_HEADERS;

let docs;
async function docsPage() {
  if (docs && process.env.NODE_ENV === 'production') return docs;
  const [template, source] = await Promise.all([readFile(new URL('web/docs.html', root), 'utf8'), readFile(new URL('docs/install.md', root), 'utf8')]);
  docs = renderDocsPage(template, source, VERSION);
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
  const send = (status, body, type = 'application/json', extra = {}) => {
    res.writeHead(status, { ...HEADERS, 'content-type': TEXT.test(type) || type === 'text/javascript' ? type + '; charset=utf-8' : type, 'cache-control': 'no-store', ...extra });
    res.end(req.method === 'HEAD' ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const result = await api.handle(req.method, pathname, searchParams, clientOf(req));
    if (result) return send(result.status, result.body, 'application/json', result.headers ?? {});
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { reason: 'Use GET', code: 'method' }, 'application/json', { allow: 'GET, HEAD' });

    if (pathname === '/docs' || pathname === '/docs/') return send(200, await docsPage(), 'text/html', { 'cache-control': 'no-cache' });
    const found = resolveStatic(pathname);
    if (!found) return send(404, { reason: 'Not found', code: 'not-found' });
    const [file, type] = found;
    let data;
    try {
      data = await readFile(new URL(file, root));
    } catch (error) {
      if (error.code === 'ENOENT') return send(404, { reason: 'Not found', code: 'not-found' });
      throw error;
    }
    if (pathname === '/') data = Buffer.from(data.toString('utf8').replace(/\{\{VERSION\}\}/g, VERSION));
    const cacheControl = pathname.startsWith('/vendor/') ? 'public, max-age=86400' : pathname.startsWith('/examples/') || pathname.startsWith('/demo/') ? 'public, max-age=300' : 'no-cache';
    const extra = { 'cache-control': cacheControl, vary: 'accept-encoding' };
    if (data.length > 1024 && (TEXT.test(type) || type === 'text/javascript') && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
      return send(200, pathname === '/' ? gzipSync(data) : await compressed(file, data), type, { ...extra, 'content-encoding': 'gzip' });
    }
    return send(200, data, type, extra);
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
