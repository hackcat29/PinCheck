import {
  DECISIONS, REPLAY, METHODS, coverage, guaranteeFor, headline, nextSteps, cliCommand, refText, shortRef, bitRows, normalize, formatCount,
} from '/report.mjs';

const $ = id => document.getElementById(id);
const form = $('compare-form');
const reportEl = $('report');
const notice = $('notice');
const REF = /^\s*0x[0-9a-fA-F]{40}:[1-9][0-9]{0,19}\s*$/;
const BLOCK = /^\s*(latest|[0-9]{1,19}|0x[0-9a-fA-F]{1,16}|0x[0-9a-fA-F]{64})?\s*$/;
const GLYPH = { compatible: '✓', 'behavior-changed': '✕', 'interface-mismatch': '≠', inconclusive: '?' };
const TRANSIENT = new Set(['rpc-unavailable', 'rpc-timeout', 'rpc-error', 'historical-state-unavailable', 'block-changed', 'time-budget', 'busy', 'network']);

let examples = [];
let current = null;   // { report, source: {kind, example?, file?}, labels? }
let busy = false;

// Small DOM builder. Text is always set with textContent.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}
const mono = text => h('code', {}, text);
const fmtBlock = block => block ? Number(BigInt(block.number)).toLocaleString('en-US') : '';

// ---------- rendering ----------

function render(entry) {
  current = entry;
  const r = entry.report;
  const c = r.comparison ?? {};
  const m = c.firstMismatch;
  const replay = r.replay ?? {};
  reportEl.setAttribute('aria-busy', 'false');
  reportEl.dataset.status = r.status;

  const source = sourceLine(entry);
  const head = h('header', { class: 'report-head' },
    source,
    h('h3', { class: 'decision', 'data-status': r.status, tabindex: '-1', id: 'decision' },
      h('span', { class: 'glyph', 'aria-hidden': 'true' }, GLYPH[r.status] ?? '?'), DECISIONS[r.status] ?? r.status),
    h('p', { class: 'headline' }, headline(r)),
    h('p', { class: 'pair' }, mono(shortRef(r.baseline)), h('span', { 'aria-hidden': 'true' }, ' → '), h('span', { class: 'visually-hidden' }, ' to '), mono(shortRef(r.candidate))),
  );

  const facts = m ? h('dl', { class: 'evidence-row' },
    fact('Input', m.packedInput),
    fact('Current output', m.baselineOutput),
    fact('Candidate output', m.candidateOutput, 'changed'),
    fact('Replay', REPLAY[replay.status] ?? '—', 'plain'),
  ) : r.status === 'interface-mismatch' ? h('dl', { class: 'evidence-row' },
    fact('Current inputs', r.interface?.baseline?.nIn), fact('Candidate inputs', r.interface?.candidate?.nIn, r.interface?.baseline?.nIn !== r.interface?.candidate?.nIn ? 'changed' : ''),
    fact('Current outputs', r.interface?.baseline?.nOut), fact('Candidate outputs', r.interface?.candidate?.nOut, r.interface?.baseline?.nOut !== r.interface?.candidate?.nOut ? 'changed' : ''),
  ) : null;

  const statuses = h('div', { class: 'statuses' },
    statusLine('Local comparison', compareStatus(r), [c.method && METHODS[c.method], coverage(r), c.mismatches ? formatCount(c.mismatches) + ' differ' : null]),
    statusLine('On-chain replay', REPLAY[replay.status] ?? 'Not run', [replayDetail(r)]),
  );

  const next = h('div', { class: 'next' }, h('h4', {}, 'What to do next'), h('ul', {}, nextSteps(r).map(step => h('li', {}, step))));
  const actions = h('div', { class: 'actions', role: 'group', 'aria-label': 'Report actions' },
    r.baseline && h('button', { type: 'button', class: 'button primary', onclick: () => runLive({ baseline: refText(r.baseline), candidate: refText(r.candidate) }) }, 'Run live'),
    r.block?.hash && h('button', { type: 'button', class: 'button', onclick: () => runLive({ baseline: refText(r.baseline), candidate: refText(r.candidate), block: r.block.hash }) }, 'Rerun at this block'),
    h('button', { type: 'button', class: 'button', onclick: event => copy(event.currentTarget, shareLink()) }, 'Copy link'),
    r.baseline && h('button', { type: 'button', class: 'button', onclick: event => copy(event.currentTarget, cliCommand(r)), title: 'Run from a clone of the PinCheck repository' }, 'Copy CLI command'),
    h('button', { type: 'button', class: 'button', onclick: download }, 'Download JSON'),
  );

  reportEl.replaceChildren(head, facts ?? '', statuses, h('p', { class: 'guarantee' }, guaranteeFor(r)), next, actions,
    m ? bitsTable(r, entry.labels) : '', evidenceList(r));
}

function sourceLine(entry) {
  const r = entry.report;
  const parts = [];
  if (entry.source.kind === 'example') {
    const ex = entry.source.example;
    parts.push(h('span', { class: 'tag' }, 'Recorded'));
    if (ex.pullRequest) parts.push(h('a', { href: ex.pullRequest }, 'Pull request #' + ex.pullRequest.split('/').pop()));
    if (ex.run) parts.push(h('a', { href: ex.run }, 'GitHub check run'));
    if (ex.original) parts.push(h('a', { href: ex.original.replace('..', '') }, 'Original report'));
    if (ex.source) parts.push(h('a', { href: ex.source }, 'Deployment source'));
  } else if (entry.source.kind === 'file') {
    parts.push(h('span', { class: 'tag' }, 'Opened file'), entry.source.file);
  } else {
    parts.push(h('span', { class: 'tag live' }, 'Live'), 'Run ' + new Date(r.generatedAt ?? Date.now()).toLocaleString());
  }
  if (r.block) parts.push('X Layer block ' + fmtBlock(r.block));
  const line = h('p', { class: 'source' });
  parts.forEach((part, i) => { if (i > 1) line.append(h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · ')); line.append(part); });
  const extra = entry.source.kind === 'example' ? h('p', { class: 'summary' }, entry.source.example.summary) : null;
  return h('div', {}, line, extra);
}

function fact(label, value, cls) {
  return h('div', {}, h('dt', {}, label), h('dd', { class: cls || null }, value == null ? '—' : String(value)));
}

function statusLine(label, value, details) {
  return h('p', {}, h('span', { class: 'k' }, label), h('strong', {}, value), ...details.filter(Boolean).map(detail => [h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · '), detail]));
}

function compareStatus(r) {
  const s = r.comparison?.status;
  return { equivalent: 'Equivalent', different: 'Different', 'interface-mismatch': 'Interface differs', incomplete: 'Incomplete' }[s] ?? 'Not completed';
}

function replayDetail(r) {
  const replay = r.replay ?? {};
  if (replay.status === 'confirmed') return replay.kind === 'counterexample' ? 'both processors returned these outputs via eval' : replay.inputs + ' spot-check inputs agree with PinCheck';
  if (replay.status === 'disagrees') return 'a processor returned a different output than PinCheck';
  if (replay.status === 'unavailable') return replay.reason;
  if (r.comparison?.method === 'identical-netlist' && r.interface?.baseline?.nState) return 'stateful circuits are not replayed with eval';
  return null;
}

function bitsTable(r, labels = {}) {
  const m = r.comparison.firstMismatch;
  const { nIn, nOut } = r.interface?.baseline ?? {};
  if (!Number.isInteger(nIn) || !Number.isInteger(nOut)) return '';
  const inputs = bitRows(m.packedInput, nIn, labels.inputs);
  const oldOut = bitRows(m.baselineOutput, nOut, labels.outputs);
  const newOut = bitRows(m.candidateOutput, nOut, labels.outputs);
  const named = (labels.inputs?.length || labels.outputs?.length);
  return h('details', { class: 'bits' },
    h('summary', {}, 'Bits of the first mismatch (' + nIn + ' in, ' + nOut + ' out, least significant bit first)'),
    h('div', { class: 'bit-tables' },
      h('div', { class: 'table' }, h('table', {},
        h('caption', {}, 'Input ' + m.packedInput),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Bit'), named ? h('th', { scope: 'col' }, 'Name') : null, h('th', { scope: 'col' }, 'Value'))),
        h('tbody', {}, inputs.map(b => h('tr', {}, h('td', {}, b.index), named ? h('td', {}, b.name ?? '') : null, h('td', {}, b.value)))))),
      h('div', { class: 'table' }, h('table', {},
        h('caption', {}, 'Outputs'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Bit'), named ? h('th', { scope: 'col' }, 'Name') : null, h('th', { scope: 'col' }, 'Current'), h('th', { scope: 'col' }, 'Candidate'))),
        h('tbody', {}, oldOut.map((b, i) => {
          const changed = b.value !== newOut[i].value;
          return h('tr', { class: changed ? 'changed' : null }, h('td', {}, b.index), named ? h('td', {}, b.name ?? '') : null, h('td', {}, b.value),
            h('td', {}, newOut[i].value, changed ? h('span', { class: 'visually-hidden' }, ' (changed)') : null));
        })))),
    ));
}

function evidenceList(r) {
  const rows = [];
  const add = (k, ...v) => rows.push(h('dt', {}, k), h('dd', {}, ...v));
  if (r.chain) add('Chain', (r.chain.name ?? 'X Layer') + ' (' + r.chain.id + ')');
  if (r.block) {
    add('Block', fmtBlock(r.block), ' ', mono(r.block.hash));
    if (r.block.timestamp) add('Block time', new Date(Number(BigInt(r.block.timestamp)) * 1000).toISOString());
  }
  if (r.pinning) add('Pinning', r.pinning.method === 'eip-1898-block-hash' ? 'EIP-1898 block-hash calls with requireCanonical' : 'Block number; ' + (r.pinning.note ?? 'hash rechecked after the run'));
  for (const [address, info] of Object.entries(r.processors ?? {})) add('Processor', mono(address), info.registered ? ' registered with the X Layer TapeOut factory' : ' not registered');
  if (r.factory) add('Factory', mono(r.factory.address), r.factory.sealed ? ' sealed' : ' not sealed: the implementation can change after this block');
  if (r.implementation) add('Implementation', mono(r.implementation.address), ' via beacon ', mono(r.implementation.beacon));
  if (r.comparison?.method) add('Method', METHODS[r.comparison.method] + (r.comparison.seed ? ', seed ' + r.comparison.seed : ''));
  for (const [key, dep] of Object.entries(r.dependencies ?? {})) {
    add('Netlist', mono(key), h('br'), dep.nIn + ' in, ' + dep.nOut + ' out, ' + (dep.nState ? dep.nState + ' state bits, ' : '') + (dep.gateCount ?? '?') + ' gates' + (dep.bytes ? ', ' + dep.bytes + ' bytes' : ''),
      dep.keccak256 ? [h('br'), 'keccak256 ', mono(dep.keccak256)] : '', h('br'), 'sha256 ', mono(dep.sha256));
  }
  add('Evaluator', 'PinCheck ' + (r.tool?.version ?? '?') + ', report schema ' + r.schema);
  if (r.rpc) add('RPC', r.rpc.endpoint);
  if (r.generatedAt) add('Generated', r.generatedAt);
  return h('details', { class: 'evidence' }, h('summary', {}, 'Evidence: block, fingerprints, processors, evaluator'), h('dl', {}, rows));
}

// ---------- actions ----------

function setBusy(on, label) {
  busy = on;
  reportEl.setAttribute('aria-busy', String(on));
  for (const button of document.querySelectorAll('.workbench button')) button.disabled = on;
  if (on) {
    const started = Date.now();
    const timer = h('span', {}, '');
    const status = h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, label + ' '), timer);
    notice.hidden = false;
    notice.className = 'notice';
    notice.replaceChildren(status);
    const tick = setInterval(() => { if (!busy) return clearInterval(tick); timer.textContent = Math.round((Date.now() - started) / 1000) + 's'; }, 1000);
  } else {
    notice.hidden = true;
    notice.replaceChildren();
  }
}

async function runLive({ baseline, candidate, block }) {
  if (busy) return;
  const params = new URLSearchParams({ baseline: baseline.trim(), candidate: candidate.trim() });
  if (block && block.trim() && block.trim() !== 'latest') params.set('block', block.trim());
  setBusy(true, params.has('block') ? 'Reading both circuits from X Layer at the pinned block…' : 'Reading both circuits from the latest X Layer block…');
  let report, failure;
  try {
    const response = await fetch('/api/compare?' + params);
    const body = await response.json().catch(() => ({}));
    if (response.status === 429) failure = { code: 'busy', reason: body.reason ?? 'PinCheck is busy. Try again in a few seconds.' };
    else if (!response.ok) failure = { code: body.code ?? 'error', reason: body.reason ?? 'The server returned HTTP ' + response.status };
    else report = body;
  } catch {
    failure = { code: 'network', reason: 'Could not reach the PinCheck server. Check your connection and try again.' };
  }
  setBusy(false);
  if (report && !(report.status === 'inconclusive' && TRANSIENT.has(report.code) && current)) {
    history.replaceState(null, '', '/?' + new URLSearchParams({ baseline: refText(report.baseline), candidate: refText(report.candidate), ...(report.block ? { block: report.block.hash } : {}) }) + '#compare');
    selectExampleButton(null);
    render({ report, source: { kind: 'live' } });
    document.getElementById('decision')?.focus();
    return;
  }
  // A failed rerun never replaces evidence already on screen.
  const reason = report ? report.reason : failure.reason;
  const steps = report ? nextSteps(report) : [failure.code === 'busy' ? 'Wait a few seconds and run it again.' : 'Try again.'];
  notice.hidden = false;
  notice.className = 'notice warn';
  notice.replaceChildren(h('p', {}, h('strong', {}, 'The live run did not complete. '), reason.replace(/\.?$/, '.'), current ? ' The report below is unchanged.' : ''), h('p', {}, steps.join(' ')));
  notice.focus?.();
  if (!current) render({ report: report ?? { schema: 2, status: 'inconclusive', code: failure.code, reason, replay: { status: 'not-run' } }, source: { kind: 'live' } });
}

function shareLink() {
  const url = new URL(location.origin + '/');
  const { report, source } = current ?? {};
  if (source?.kind === 'example') url.searchParams.set('example', source.example.id);
  else if (report?.baseline) {
    url.searchParams.set('baseline', refText(report.baseline));
    url.searchParams.set('candidate', refText(report.candidate));
    if (report.block) url.searchParams.set('block', report.block.hash);
  }
  url.hash = 'compare';
  return url.toString();
}

async function copy(button, text) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    window.prompt('Copy this:', text);
  }
  setTimeout(() => { button.textContent = label; }, 1600);
}

function download() {
  const r = current?.report;
  if (!r) return;
  const name = r.baseline ? 'pincheck-' + r.baseline.id + '-to-' + r.candidate.id + (r.block ? '-' + Number(BigInt(r.block.number)) : '') + '.json' : 'pincheck-report.json';
  const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2) + '\n'], { type: 'application/json' }));
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- examples ----------

function selectExampleButton(id) {
  for (const button of $('examples').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === id));
}

async function showExample(id, { focus = false, updateUrl = true } = {}) {
  const example = examples.find(e => e.id === id) ?? examples[0];
  if (!example) return;
  selectExampleButton(example.id);
  notice.hidden = true;
  const response = await fetch('/examples/' + example.report);
  const report = normalize(await response.json());
  render({ report, source: { kind: 'example', example } });
  if (updateUrl) history.replaceState(null, '', '/?example=' + example.id + (location.hash || ''));
  if (focus) document.getElementById('decision')?.focus();
}

async function loadExamples() {
  const index = await (await fetch('/examples/index.json')).json();
  examples = index.examples;
  $('examples').replaceChildren(...examples.map(example => h('button', {
    type: 'button', class: 'chip', 'data-id': example.id, 'aria-pressed': 'false',
    onclick: () => showExample(example.id, { focus: true }),
  }, example.title)));
}

// ---------- form ----------

function validate() {
  let first = null;
  for (const [name, pattern, message] of [
    ['baseline', REF, 'Enter a processor address, a colon, and a circuit ID, such as 0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355:1.'],
    ['candidate', REF, 'Enter a processor address, a colon, and a circuit ID.'],
    ['block', BLOCK, 'Use latest, a block number, or a 32-byte block hash.'],
  ]) {
    const input = form.elements[name];
    const error = $(name + '-error');
    const ok = pattern.test(input.value);
    input.setAttribute('aria-invalid', String(!ok));
    error.hidden = ok;
    error.textContent = ok ? '' : message;
    if (!ok && !first) first = input;
  }
  if (first) {
    if (first.name === 'block') first.closest('details').open = true;
    first.focus();
  }
  return !first;
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (!validate()) return;
  runLive({ baseline: form.elements.baseline.value, candidate: form.elements.candidate.value, block: form.elements.block.value });
});

$('open-report').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error('That file is larger than 5 MB.');
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('It is not valid JSON.'); }
    if (!data || (data.schema !== 1 && data.schema !== 2 && data.schema !== 'pincheck-gate/1')) throw new Error('It is not a PinCheck report.');
    let labels;
    let report = data;
    if (data.schema === 'pincheck-gate/1') {
      const dep = data.dependencies.find(d => d.report && d.decision !== 'pass') ?? data.dependencies.find(d => d.report);
      if (!dep) throw new Error('This gate report has no changed dependency to show.');
      report = dep.report;
      labels = dep.labels;
    }
    selectExampleButton(null);
    render({ report: normalize(report), source: { kind: 'file', file: file.name }, labels });
    document.getElementById('decision')?.focus();
  } catch (error) {
    notice.hidden = false;
    notice.className = 'notice warn';
    notice.replaceChildren(h('p', {}, h('strong', {}, 'Could not open that file. '), error.message));
  } finally {
    event.target.value = '';
  }
});

for (const link of document.querySelectorAll('[data-focus-form]')) {
  link.addEventListener('click', () => setTimeout(() => form.elements.baseline.focus({ preventScroll: false }), 0));
}

// ---------- start ----------

const params = new URLSearchParams(location.search);
try {
  await loadExamples();
  if (params.has('baseline') && params.has('candidate')) {
    form.elements.baseline.value = params.get('baseline');
    form.elements.candidate.value = params.get('candidate');
    if (params.get('block')) form.elements.block.value = params.get('block');
    await showExample(params.get('example'), { updateUrl: false });
    if (validate()) runLive({ baseline: params.get('baseline'), candidate: params.get('candidate'), block: params.get('block') ?? '' });
  } else {
    await showExample(params.get('example'));
  }
} catch {
  reportEl.setAttribute('aria-busy', 'false');
  reportEl.replaceChildren(h('p', { class: 'empty' }, 'The recorded examples could not be loaded. You can still compare circuits with the form.'));
}
