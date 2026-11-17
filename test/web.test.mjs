import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderMarkdown } from '../src/markdown.mjs';
import { normalize, headline, coverage } from '../src/report.mjs';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('the hero evidence matches the recorded report it links to', async () => {
  const html = await read('web/index.html');
  const report = JSON.parse(await read('examples/orderguard-1-to-11.json'));
  const m = report.comparison.firstMismatch;
  const start = html.indexOf('<dl class="evidence-row"');
  const row = html.slice(start, html.indexOf('</dl>', start));
  assert.ok(start > 0);
  for (const value of [m.packedInput, m.baselineOutput, m.candidateOutput]) assert.ok(row.includes('<dd') && row.includes(value), value);
  assert.ok(html.includes(Number(BigInt(report.block.number)).toLocaleString('en-US')));
  assert.ok(html.includes(coverage(report)));
  assert.equal(report.replay.status, 'confirmed');
  assert.equal(headline(report), 'Input 0x01: current output 0x01, candidate output 0x00.');
});

test('recorded examples are schema 2, pinned to the recorded block hash, and listed', async () => {
  const index = JSON.parse(await read('examples/index.json'));
  const server = await read('server.mjs');
  for (const example of index.examples) {
    const report = JSON.parse(await read('examples/' + example.report));
    assert.equal(report.schema, 2);
    assert.equal(report.pinning.method, 'eip-1898-block-hash');
    assert.ok(server.includes("'/examples/" + example.report + "'"), example.report + ' is served');
    assert.doesNotThrow(() => normalize(report));
  }
  const [bad, good] = await Promise.all(['orderguard-1-to-11', 'orderguard-1-to-2'].map(async id => JSON.parse(await read('examples/' + id + '.json'))));
  const [badV1, goodV1] = await Promise.all(['demo/incompatible.json', 'demo/compatible.json'].map(async path => JSON.parse(await read(path))));
  for (const [v2, v1] of [[bad, badV1], [good, goodV1]]) {
    assert.equal(v2.block.hash, v1.block.hash, 'same block as the captured report');
    assert.equal(v2.status, v1.status);
    for (const [key, dep] of Object.entries(v1.dependencies)) assert.equal(v2.dependencies[key].sha256, dep.sha256, key);
  }
});

test('markdown rendering escapes HTML and neutralizes unsafe links', () => {
  const { html, toc } = renderMarkdown('## Title `x`\n\n<script>alert(1)</script> [a](javascript:alert(1)) [b](https://ok.example)\n\n```sh\necho "<b>"\n```');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('href="#"'));
  assert.ok(html.includes('href="https://ok.example" rel="noopener"'));
  assert.ok(html.includes('echo &quot;&lt;b&gt;&quot;'));
  assert.deepEqual(toc, [{ id: 'title-x', text: 'Title x' }]);
});

const word = value => BigInt(value).toString(16).padStart(64, '0');
const abiBytes = bytes => '0x' + word(32) + word(bytes.length / 2) + bytes.padEnd(64, '0');
// Minimal fake X Layer node: circuits #1 NAND(a,b) and #2 NAND(b,a) on one registered processor.
function fakeNode(context, { hold } = {}) {
  const calls = { count: 0 };
  context.mock.method(globalThis, 'fetch', async (_url, request) => {
    calls.count++;
    if (hold) await hold;
    const { id, method, params } = JSON.parse(request.body);
    const reply = result => Response.json({ jsonrpc: '2.0', id, result });
    if (method === 'eth_chainId') return reply('0xc4');
    if (method.startsWith('eth_getBlockBy')) return reply({ number: '0x10', hash: '0x' + '11'.repeat(32), timestamp: '0x1' });
    const data = params[0].data.slice(2);
    const selector = data.slice(0, 8);
    if (selector === '5f5a364f' || selector === '631f9852') return reply('0x' + word(selector === '5f5a364f' ? 1 : 0));
    if (selector === '5c60da1b') return reply('0x' + word(1));
    const circuit = Number(BigInt('0x' + data.slice(8, 72)));
    if (selector === '084d60f1') return reply('0x' + [2, 1, 0, 1].map(word).join(''));
    if (selector === '3fc4be56') return reply(abiBytes(circuit === 1 ? '00000002000003' : '00000003000002'));
    if (selector === '934d06ea') { const x = Number.parseInt(data.slice(200, 202), 16); return reply(abiBytes((x & 3) === 3 ? '00' : '01')); }
  });
  return calls;
}

test('the server validates input, serves docs and health, bounds concurrency and caches pinned runs', async context => {
  process.env.PINCHECK_MAX_CONCURRENCY = '1';
  const http = await import('node:http');
  const { server } = await import('../server.mjs?test');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    http.request(base + path, { method }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
  });
  const a = '0x' + 'ab'.repeat(20);

  assert.equal((await get('/api/compare?baseline=nope&candidate=x')).status, 400);
  assert.equal((await get('/api/compare?baseline=' + a + ':1&candidate=' + a + ':2&block=yesterday')).status, 400);
  assert.equal((await get('/api/compare', 'POST')).status, 405);
  assert.equal((await get('/../package.json')).status, 404);
  const docs = (await get('/docs')).body;
  assert.match(docs, /<h2 id="what-a-result-means">/);
  assert.ok(!docs.includes('<!--DOCS-->'));
  assert.equal(JSON.parse((await get('/api/health')).body).ok, true);
  const home = await get('/');
  assert.match(home.headers['content-security-policy'], /script-src 'self'/);
  assert.ok(!home.body.includes('{{VERSION}}'));

  // One slot: a second comparison while the first is running is refused with 429.
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const calls = fakeNode(context, { hold });
  const first = get('/api/compare?baseline=' + a + ':1&candidate=' + a + ':2');
  while (!calls.count) await new Promise(resolve => setTimeout(resolve, 5));
  const busy = await get('/api/compare?baseline=' + a + ':1&candidate=' + a + ':2');
  assert.equal(busy.status, 429);
  assert.equal(busy.headers['retry-after'], '5');
  release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(JSON.parse(done.body).status, 'compatible');

  // The same pair pinned to the block just read is answered from cache without RPC calls.
  const before = calls.count;
  const pinned = await get('/api/compare?baseline=' + a + ':1&candidate=' + a + ':2&block=0x' + '11'.repeat(32));
  assert.equal(pinned.headers['x-pincheck-cache'], 'hit');
  assert.equal(calls.count, before);
  assert.equal(JSON.parse(pinned.body).status, 'compatible');
});
