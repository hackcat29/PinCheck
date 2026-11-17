import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { decode, diffWordsCpu, popcount, gpuProgram, outputsOf, bitsOf, pack, DIFF_WGSL } from '../web/landing/circuit.mjs';

const read = path => readFile(new URL('../' + path, import.meta.url));
const json = async path => JSON.parse(await read(path));

test('recorded netlists match the fingerprints in the recorded reports', async () => {
  const { circuits } = await json('examples/netlists.json');
  const { examples } = await json('examples/index.json');
  for (const example of examples) {
    const report = await json('examples/' + example.report);
    for (const [key, dep] of Object.entries(report.dependencies)) {
      const bytes = Buffer.from(circuits[key].netlist.slice(2), 'hex');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), dep.sha256, key);
      assert.equal(circuits[key].keccak256, dep.keccak256, key);
    }
  }
});

test('the browser evaluator reproduces the recorded mismatch counts and counterexamples', async () => {
  const { circuits } = await json('examples/netlists.json');
  for (const id of ['orderguard-1-to-11', 'orderguard-1-to-2', 'neon-reliquary-5-vs-7']) {
    const report = await json('examples/' + id + '.json');
    const [a, b] = [report.baseline, report.candidate].map(r => {
      const c = circuits[r.address + ':' + r.id];
      return decode(c.netlist, c.nIn, c.nOut);
    });
    assert.equal(popcount(diffWordsCpu(a, b)), report.comparison.mismatches, id);
    const m = report.comparison.firstMismatch;
    if (m) {
      const bits = bitsOf(m.input, a.nIn);
      assert.equal(pack(outputsOf(a, bits)), m.baselineOutput, id);
      assert.equal(pack(outputsOf(b, bits)), m.candidateOutput, id);
    }
  }
});

test('the GPU program layout matches what the WGSL kernel reads', async () => {
  const { circuits } = await json('examples/netlists.json');
  const c5 = circuits['0x57e9e1111f42f448126a9f12b2b3f99a79dd1a44:5'], c7 = circuits['0x57e9e1111f42f448126a9f12b2b3f99a79dd1a44:7'];
  const a = decode(c5.netlist, c5.nIn, c5.nOut), b = decode(c7.netlist, c7.nIn, c7.nOut);
  const program = gpuProgram(a, b);
  assert.deepEqual([...program.slice(0, 5)], [2 ** 15, 20, a.gates.length, b.gates.length, 22]);
  assert.equal(program.length, 5 + 2 * a.gates.length + 2 * b.gates.length + 2 * 22);
  for (const name of ['program[0]', 'program[1]', 'program[2]', 'program[3]', 'program[4]', 'diff[word]']) assert.ok(DIFF_WGSL.includes(name), name);
});

test('vendored files match the hashes recorded by scripts/vendor.mjs', async () => {
  const manifest = await json('web/vendor/manifest.json');
  for (const [file, sha] of Object.entries(manifest.sha256)) {
    assert.equal(createHash('sha256').update(await read('web/vendor/' + file)).digest('hex'), sha, file);
  }
  assert.ok((await read('web/vendor/LICENSES.md')).toString().includes('three'));
});

test('the server serves site modules, vendored files and llms.txt, and nothing else', async context => {
  const http = await import('node:http');
  const { server } = await import('../server.mjs?site');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + server.address().port + path, { headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const three = await get('/vendor/three.mjs', { 'accept-encoding': 'gzip' });
  assert.equal(three.status, 200);
  assert.equal(three.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(three.body).length, (await read('web/vendor/three.mjs')).length);
  assert.ok(three.body.length < 400_000, 'three.js is served compressed');
  const font = await get('/vendor/geist-sans.woff2');
  assert.equal(font.headers['content-type'], 'font/woff2');
  assert.equal((await get('/landing/scene.mjs')).status, 200);
  assert.match((await get('/llms.txt')).body.toString(), /\/api\/compare/);
  assert.equal((await get('/examples/netlists.json')).status, 200);
  for (const path of ['/vendor/../server.mjs', '/vendor/%2e%2e/server.mjs', '/landing/missing.mjs', '/landing/circuit.json', '/vendor/.hidden.mjs']) {
    assert.equal((await get(path)).status, 404, path);
  }
});
