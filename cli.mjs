#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { compareOnChain, reference } from './src/xlayer.mjs';
import { parseManifest } from './src/manifest.mjs';
import { runGate } from './src/gate.mjs';
import { renderSummary } from './src/summary.mjs';
import { VERSION } from './src/report.mjs';

const HELP = `PinCheck ${VERSION}: catch breaking TapeOut circuit upgrades on X Layer.

Compare two circuits:
  node cli.mjs [--block LATEST|NUMBER|HASH] BASELINE CANDIDATE
  node cli.mjs --manifest BASE.json HEAD.json     (manifests with one dependency)

Gate a pull request (what the GitHub Action runs):
  node cli.mjs gate --base BASE.json|none --head HEAD.json
               [--report report.json] [--summary summary.md] [--site-url URL]

A circuit is processor-address:circuit-id, for example
  0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:1

Exit codes: 0 compatible / gate passed, 1 behavior or interface changed,
2 inconclusive or invalid input. Reports are JSON on stdout.
Environment: X_LAYER_RPC (default https://rpc.xlayer.tech),
PINCHECK_RPC_TRANSPORT=curl for proxies that block Node fetch.`;

const EXIT = { compatible: 0, 'behavior-changed': 1, 'interface-mismatch': 1, inconclusive: 2 };
const rpcOptions = () => ({ url: process.env.X_LAYER_RPC || undefined });

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      block: { type: 'string' }, manifest: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
      base: { type: 'string' }, head: { type: 'string' }, report: { type: 'string' }, summary: { type: 'string' },
      'site-url': { type: 'string' }, 'manifest-path': { type: 'string' },
    },
  });
  if (values.help) console.log(HELP);
  else if (values.version) console.log(VERSION);
  else if (positionals[0] === 'gate') process.exitCode = await gate(values);
  else {
    if (positionals.length !== 2) throw new Error('Supply two circuits or two manifest files. See --help.');
    let refs;
    if (values.manifest) {
      const manifests = await Promise.all(positionals.map(async path => parseManifest(await readFile(path, 'utf8'), path)));
      if (manifests.some(m => m.dependencies.size !== 1)) throw new Error('--manifest compares single-dependency manifests. Use "gate" for several.');
      refs = manifests.map(m => [...m.dependencies.values()][0].circuit);
    } else {
      refs = positionals.map(reference);
    }
    const result = await compareOnChain(...refs, { ...rpcOptions(), block: values.block });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = EXIT[result.status] ?? 2;
  }
} catch (error) {
  console.error('pincheck: ' + error.message);
  process.exitCode = 2;
}

async function gate(values) {
  if (!values.base || !values.head) throw new Error('gate needs --base and --head. Use --base none when the base branch has no manifest.');
  const manifestPath = values['manifest-path'] ?? 'pincheck.json';
  const base = values.base === 'none' ? null : parseManifest(await readFile(values.base, 'utf8'), 'base ' + manifestPath);
  const head = parseManifest(await readFile(values.head, 'utf8'), 'proposed ' + manifestPath);
  const result = await runGate(base, head, {
    compare: (baseline, candidate) => compareOnChain(baseline, candidate, rpcOptions()),
    context: { manifest: manifestPath, base: process.env.PINCHECK_BASE_SHA, head: process.env.PINCHECK_HEAD_SHA },
  });
  const json = JSON.stringify(result, null, 2) + '\n';
  if (values.report) await writeFile(values.report, json);
  else console.log(json);
  if (values.summary) await appendFile(values.summary, renderSummary(result, { siteUrl: values['site-url'], manifestPath }));
  const line = { pass: 'passed', fail: 'blocked: behavior or interface changed', inconclusive: 'blocked: comparison inconclusive' }[result.decision];
  console.error('PinCheck gate ' + line + ' (' + result.changed + ' changed dependenc' + (result.changed === 1 ? 'y' : 'ies') + ')');
  return result.exitCode;
}
