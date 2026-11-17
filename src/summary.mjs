// GitHub job summary for a gate report. Plain Markdown; every value comes from the report.
import { DECISIONS, REPLAY, coverage, cliCommand, refText, shortRef, nextSteps, bitRows, REPO } from './report.mjs';

const TITLE = {
  pass: 'PinCheck passed: circuit dependencies are compatible',
  fail: 'PinCheck blocked this merge: a circuit dependency changed behavior',
  inconclusive: 'PinCheck blocked this merge: a circuit comparison did not complete',
};
const DEP = { pass: 'Pass', fail: 'Blocked', inconclusive: 'Blocked (inconclusive)', accepted: 'Accepted change' };
const code = text => '`' + String(text).replace(/`/g, "'") + '`';
const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderSummary(gate, { siteUrl, manifestPath = 'pincheck.json' } = {}) {
  const lines = [];
  const unchanged = gate.dependencies.filter(d => d.change === 'unchanged').length;
  lines.push('## ' + TITLE[gate.decision], '');
  if (!gate.changed) {
    lines.push('No pinned circuit changed in ' + code(manifestPath) + ' (' + gate.dependencies.length + ' dependenc' + (gate.dependencies.length === 1 ? 'y' : 'ies') + ' checked).', '');
  }
  const rows = gate.dependencies.filter(d => d.change !== 'unchanged');
  if (rows.length) {
    lines.push('| Dependency | Change | Result | Coverage | On-chain replay |', '|---|---|---|---|---|');
    for (const d of rows) {
      const change = d.change === 'changed' ? code(shortRef(d.baseline)) + ' → ' + code('#' + d.candidate.id) : d.change === 'added' ? 'added ' + code(shortRef(d.candidate)) : 'removed';
      const result = d.report ? DECISIONS[d.report.status] + (d.decision === 'accepted' ? ' (accepted)' : '') : DEP[d.decision];
      lines.push('| ' + [code(d.name), change, '**' + cell(result) + '**', cell(d.report ? coverage(d.report) ?? '—' : '—'), cell(d.report ? REPLAY[d.report.replay?.status] ?? '—' : '—')].join(' | ') + ' |');
    }
    if (unchanged) lines.push('', unchanged + ' other dependenc' + (unchanged === 1 ? 'y is' : 'ies are') + ' unchanged.');
    lines.push('');
  }
  for (const d of gate.dependencies.filter(dep => dep.report)) lines.push(...dependencySection(d, siteUrl, manifestPath));
  if (gate.notes.length) lines.push('**Notes**', '', ...gate.notes.map(note => '- ' + note), '');
  lines.push('<sub>PinCheck ' + gate.tool.version + ' · ' + 'full JSON report attached to this run as ' + code('pincheck-report') + ' · [How this check works](' + REPO + '/blob/main/docs/install.md)</sub>', '');
  return lines.join('\n');
}

function dependencySection(d, siteUrl, manifestPath) {
  const r = d.report;
  const lines = ['### ' + code(d.name) + ': ' + DECISIONS[r.status] + (d.decision === 'accepted' ? ', accepted by maintainers' : ''), ''];
  const m = r.comparison?.firstMismatch;
  if (m) {
    const width = r.interface?.baseline;
    lines.push('**First mismatch:** input ' + code(m.packedInput) + ' → current output ' + code(m.baselineOutput) + ', candidate output ' + code(m.candidateOutput) + '.');
    const named = d.labels && width ? describeBits(m, width, d.labels) : null;
    if (named) lines.push(named);
    lines.push('Changed output bit' + (m.changedBits.length === 1 ? '' : 's') + ': ' + m.changedBits.map(i => d.labels?.outputs?.[i] ? i + ' (' + d.labels.outputs[i] + ')' : i).join(', ') + '. ' +
      (r.comparison.method === 'exhaustive' ? r.comparison.mismatches.toLocaleString('en-US') + ' of ' + r.comparison.checked.toLocaleString('en-US') + ' inputs differ.' : 'Found by sampling.'));
    lines.push('');
  } else if (r.status !== 'behavior-changed') {
    lines.push(r.reason ? r.reason.replace(/\.?$/, '.') : r.guarantee, '');
  }
  const replay = r.replay ?? {};
  if (replay.status === 'confirmed') lines.push('**Replay:** both deployed processors returned these outputs via ' + code('eval') + ' at the pinned block.', '');
  else if (replay.status === 'unavailable') lines.push('**Replay:** unavailable (' + replay.reason + '). The local result still decides this check.', '');
  else if (replay.status === 'disagrees') lines.push('**Replay:** a processor returned a different output than PinCheck. Treat this as a PinCheck or processor defect.', '');
  if (d.decision === 'accepted') lines.push('**Accepted in ' + code(manifestPath) + ':** ' + d.accepted.reason, '');
  lines.push('**Next:** ' + nextSteps(r).join(' '), '');
  if (r.status === 'behavior-changed' || r.status === 'interface-mismatch' || ['stateful', 'too-wide', 'too-large'].includes(r.code)) {
    if (d.decision !== 'accepted') {
      lines.push('To accept this change on purpose, add this to ' + code('dependencies.' + d.name) + ' in ' + code(manifestPath) + ' and have a code owner approve:', '',
        '```json', '"acceptChange": { "from": "' + refText(d.baseline) + '", "reason": "Why this change is intended" }', '```', '');
    }
  }
  lines.push('<details><summary>Evidence and reproduction</summary>', '');
  lines.push(...evidence(r).map(([k, v]) => '- ' + k + ': ' + v));
  lines.push('', '```sh', 'git clone ' + REPO + ' && cd PinCheck', cliCommand(r), '```');
  if (siteUrl && r.block) {
    const params = new URLSearchParams({ baseline: refText(r.baseline), candidate: refText(r.candidate), block: r.block.hash });
    lines.push('', '[Open this comparison in the PinCheck workbench](' + siteUrl.replace(/\/$/, '') + '/?' + params + ')');
  }
  lines.push('', '</details>', '');
  return lines;
}

function describeBits(m, width, labels) {
  const inputs = bitRows(m.packedInput, width.nIn, labels.inputs).filter(b => b.name);
  if (!inputs.length) return null;
  return 'Named inputs: ' + inputs.map(b => code(b.name + '=' + b.value)).join(' ') + '.';
}

export function evidence(r) {
  const rows = [
    ['Current', code(refText(r.baseline))],
    ['Candidate', code(refText(r.candidate))],
  ];
  if (r.block) rows.push(['Block', Number(BigInt(r.block.number)).toLocaleString('en-US') + ' ' + code(r.block.hash)]);
  if (r.pinning) rows.push(['Pinning', r.pinning.method === 'eip-1898-block-hash' ? 'EIP-1898 block-hash calls (requireCanonical)' : 'block number, hash rechecked after the run']);
  if (r.comparison?.method) rows.push(['Method', r.comparison.method + (r.comparison.seed ? ' (seed ' + r.comparison.seed + ')' : '')]);
  if (r.implementation) rows.push(['Processor implementation', code(r.implementation.address) + ' via beacon ' + code(r.implementation.beacon) + (r.factory?.sealed === false ? ' (factory not sealed)' : '')]);
  for (const [key, dep] of Object.entries(r.dependencies ?? {})) {
    rows.push(['Netlist ' + code(key.replace(/^(0x[0-9a-f]{6})[0-9a-f]+([0-9a-f]{4}):/, '$1…$2 #')), dep.nIn + ' in / ' + dep.nOut + ' out, ' + (dep.gateCount ?? '?') + ' gates, keccak256 ' + code(dep.keccak256 ?? '-') + ', sha256 ' + code(dep.sha256)]);
  }
  rows.push(['Evaluator', 'PinCheck ' + (r.tool?.version ?? '?') + ', report schema ' + r.schema]);
  return rows;
}
