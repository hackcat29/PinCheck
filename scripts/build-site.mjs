#!/usr/bin/env node
// Builds dist/: the static site the Cloudflare Worker serves next to /api (see wrangler.jsonc).
//   npm run build
import { mkdirSync, rmSync, readFileSync, writeFileSync, cpSync, readdirSync } from 'node:fs';
import { renderDocsPage } from '../src/markdown.mjs';
import { VERSION } from '../src/report.mjs';
import { SECURITY_HEADERS } from '../src/api.mjs';

const root = new URL('../', import.meta.url).pathname;
const out = root + 'dist/';
rmSync(out, { recursive: true, force: true });
mkdirSync(out + 'examples', { recursive: true });
mkdirSync(out + 'demo', { recursive: true });

const read = path => readFileSync(root + path, 'utf8');
writeFileSync(out + 'index.html', read('web/index.html').replace(/\{\{VERSION\}\}/g, VERSION));
writeFileSync(out + 'docs.html', renderDocsPage(read('web/docs.html'), read('docs/install.md'), VERSION));
writeFileSync(out + '404.html', read('web/404.html').replace(/\{\{VERSION\}\}/g, VERSION));
for (const file of ['style.css', 'app.mjs', 'docs.mjs', 'favicon.svg', 'llms.txt']) cpSync(root + 'web/' + file, out + file);
cpSync(root + 'src/report.mjs', out + 'report.mjs');
cpSync(root + 'web/landing', out + 'landing', { recursive: true });
cpSync(root + 'web/vendor', out + 'vendor', { recursive: true });
for (const file of readdirSync(root + 'examples').filter(f => f.endsWith('.json'))) cpSync(root + 'examples/' + file, out + 'examples/' + file);
for (const file of ['compatible.json', 'incompatible.json']) cpSync(root + 'demo/' + file, out + 'demo/' + file);

// Headers for static files; the Worker sets the same security headers on /api responses itself.
const security = Object.entries(SECURITY_HEADERS).map(([k, v]) => '  ' + k + ': ' + v).join('\n');
writeFileSync(out + '_headers', `/*\n${security}\n\n/vendor/*\n  cache-control: public, max-age=86400\n\n/examples/*\n  cache-control: public, max-age=300\n\n/demo/*\n  cache-control: public, max-age=300\n`);

const count = dir => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(dir + e.name + '/') : 1), 0);
console.log('dist/ built: ' + count(out) + ' files, PinCheck ' + VERSION);
