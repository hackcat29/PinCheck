import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { compareOnChain, reference } from './src/xlayer.mjs';

const files = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.mjs': ['app.mjs', 'text/javascript'],
};
let active = 0;
createServer(async (req, res) => {
  const json = (status, body) => {
    res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
    res.end(JSON.stringify(body));
  };
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') return json(405, { reason: 'Use GET' });
    if (pathname === '/api/compare') {
      const baseline = reference(searchParams.get('baseline'));
      const candidate = reference(searchParams.get('candidate'));
      if (active >= 4) return json(429, { reason: 'All comparison slots are busy. Try again shortly.' });
      active++;
      try {
        return json(200, await compareOnChain(baseline, candidate, {
          url: process.env.X_LAYER_RPC, block: searchParams.get('block') ?? 'latest',
        }));
      } finally {
        active--;
      }
    }
    if (!Object.hasOwn(files, pathname)) return json(404, { reason: 'Page not found' });
    const [file, type] = files[pathname];
    const data = await readFile(new URL('./web/' + file, import.meta.url));
    res.writeHead(200, {'content-type': type + '; charset=utf-8', 'x-content-type-options': 'nosniff'});
    res.end(data);
  } catch (error) {
    json(400, { reason: error.message });
  }
}).listen(Number(process.env.PORT ?? 4173), process.env.HOST ?? '127.0.0.1', function () {
  console.log('PinCheck listening on port ' + this.address().port);
});
