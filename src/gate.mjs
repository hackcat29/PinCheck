// Release gate: compare every dependency a pull request changes. Exit 0 pass, 1 blocked, 2 inconclusive.
import { sameRef } from './manifest.mjs';
import { VERSION, refText } from './report.mjs';

export const GATE_SCHEMA = 'pincheck-gate/1';
// Results that a maintainer may accept on purpose. Failed runs (RPC errors, replay disagreement,
// malformed or missing circuits) can never be accepted: they say nothing about the change.
const ACCEPTABLE = new Set(['behavior-changed', 'interface-mismatch', 'stateful', 'too-wide', 'too-large', 'time-budget']);

export async function runGate(base, head, { compare, context = {} } = {}) {
  const dependencies = [];
  const notes = [];
  if (!base) notes.push('The base branch has no manifest. Every dependency is new, so nothing can regress yet.');
  const baseDeps = base?.dependencies ?? new Map();
  const names = [...new Set([...baseDeps.keys(), ...head.dependencies.keys()])];
  for (const name of names) {
    const before = baseDeps.get(name);
    const after = head.dependencies.get(name);
    const entry = { name, baseline: before?.circuit ?? null, candidate: after?.circuit ?? null };
    if (after?.inputs || after?.outputs) entry.labels = { inputs: after.inputs ?? [], outputs: after.outputs ?? [] };
    if (!before) {
      dependencies.push({ ...entry, change: 'added', decision: 'pass' });
      continue;
    }
    if (!after) {
      dependencies.push({ ...entry, change: 'removed', decision: 'pass' });
      notes.push('`' + name + '` is no longer pinned. Make sure the app no longer calls ' + refText(before.circuit) + '.');
      continue;
    }
    const accept = after.acceptChange;
    if (sameRef(before.circuit, after.circuit)) {
      dependencies.push({ ...entry, change: 'unchanged', decision: 'pass' });
      continue;
    }
    const report = await compare(before.circuit, after.circuit);
    const result = { ...entry, change: 'changed', report };
    if (report.status === 'compatible') result.decision = 'pass';
    else if (accept && sameRef(accept.from, before.circuit) && ACCEPTABLE.has(report.status === 'inconclusive' ? report.code : report.status)) {
      result.decision = 'accepted';
      result.accepted = { reason: accept.reason, from: accept.from };
    } else {
      result.decision = report.status === 'inconclusive' ? 'inconclusive' : 'fail';
      if (accept && !sameRef(accept.from, before.circuit)) {
        notes.push('`' + name + '`: acceptChange names ' + refText(accept.from) + ', but the base branch pins ' + refText(before.circuit) + '. It was ignored.');
      } else if (accept) {
        notes.push('`' + name + '`: acceptChange cannot accept a comparison that failed to run (' + report.code + '). Rerun the check.');
      }
    }
    dependencies.push(result);
  }
  for (const [name, after] of head.dependencies) {
    const before = baseDeps.get(name);
    if (after.acceptChange && before && sameRef(before.circuit, after.circuit)) {
      notes.push('`' + name + '`: acceptChange from an earlier upgrade is still present. It has no effect until the circuit changes again.');
    }
  }
  const decisions = dependencies.map(d => d.decision);
  const decision = decisions.includes('fail') ? 'fail' : decisions.includes('inconclusive') ? 'inconclusive' : 'pass';
  return {
    schema: GATE_SCHEMA,
    tool: { name: 'pincheck', version: VERSION },
    decision,
    exitCode: { pass: 0, fail: 1, inconclusive: 2 }[decision],
    changed: dependencies.filter(d => d.change === 'changed').length,
    dependencies,
    notes,
    context,
    generatedAt: new Date().toISOString(),
  };
}
