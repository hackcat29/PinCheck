// Report vocabulary shared by the CLI, the GitHub summary and the browser. No Node APIs here.
export const VERSION = '0.2.0';
export const SCHEMA = 2;
export const REPO = 'https://github.com/hackcat29/PinCheck';

export const DECISIONS = {
  compatible: 'Compatible',
  'behavior-changed': 'Behavior changed',
  'interface-mismatch': 'Interface mismatch',
  inconclusive: 'Inconclusive',
};

export const REPLAY = {
  confirmed: 'Confirmed on X Layer',
  disagrees: 'Processor disagrees',
  unavailable: 'Replay unavailable',
  'not-applicable': 'Not applicable',
  'not-run': 'Not run',
};

export const METHODS = {
  exhaustive: 'Exhaustive',
  'identical-netlist': 'Identical netlists',
  sampled: 'Sampled (not exhaustive)',
  interface: 'Interface check',
};

const blockText = report => report.block ? 'X Layer block ' + Number(BigInt(report.block.number)).toLocaleString('en-US') : 'the recorded block';

export function coverage(report) {
  const c = report.comparison;
  if (!c || c.method === 'interface') return null;
  const space = formatCount(c.space);
  if (c.method === 'identical-netlist') return 'All ' + space + ' inputs (identical netlists)';
  if (c.method === 'exhaustive') return formatCount(c.checked) + ' of ' + space + ' inputs checked' + (c.identicalNetlist ? ' (identical netlists)' : '');
  return formatCount(c.checked) + ' sampled of ' + space + ' inputs';
}

export function formatCount(value) {
  if (value == null) return '?';
  const text = String(value);
  if (/^2\^/.test(text)) return text;
  if (text.length > 15) return '2^' + Math.round(Math.log2(Number(text)));
  return Number(text).toLocaleString('en-US');
}

export function guaranteeFor(report) {
  const c = report.comparison ?? {};
  const scope = 'It covers the raw TAP-02 output bits at ' + blockText(report) + '. It does not show that either circuit is correct, what the bits mean to your app, or how the circuits behave after the processor implementation changes.';
  if (report.status === 'compatible' && c.method === 'identical-netlist') {
    return 'Both circuits have byte-identical netlists with the same REF targets, so they produce the same outputs (and next state) for every input' + (report.interface?.baseline?.nState ? ' and state' : '') + '. ' + scope;
  }
  if (report.status === 'compatible') {
    return 'Every one of the ' + formatCount(c.space) + ' possible inputs produces the same outputs from both circuits. ' + scope;
  }
  if (report.status === 'behavior-changed') {
    return 'At least one input produces different outputs, so the candidate is not a drop-in replacement. The counterexample is reproducible at ' + blockText(report) + '.';
  }
  if (report.status === 'interface-mismatch') {
    return 'The circuits have different input or output widths, so the candidate cannot replace the current circuit without changing the calling code.';
  }
  return 'PinCheck makes no compatibility claim for this pair. A release check treats this result as failed.';
}

export function headline(report) {
  const c = report.comparison ?? {};
  const m = c.firstMismatch;
  if (report.status === 'behavior-changed' && m) {
    return 'Input ' + m.packedInput + ': current output ' + m.baselineOutput + ', candidate output ' + m.candidateOutput + '.';
  }
  if (report.status === 'compatible') return coverage(report) + '. No output differs.';
  if (report.status === 'interface-mismatch') {
    const { baseline: b, candidate: n } = report.interface ?? {};
    return 'The current circuit takes ' + bits(b?.nIn, 'input') + ' and returns ' + bits(b?.nOut, 'output') + '. The candidate takes ' + bits(n?.nIn, 'input') + ' and returns ' + bits(n?.nOut, 'output') + '.';
  }
  return report.reason ? sentence(report.reason) : 'The comparison did not complete.';
}

export function nextSteps(report) {
  const steps = [];
  const code = report.code;
  if (report.status === 'compatible') {
    steps.push('Merge the upgrade. Keep this report with the release; it records the block, fingerprints and evaluator version.');
    if (report.replay?.status === 'unavailable') steps.push('The processor spot-check could not run. The local proof stands; rerun to add on-chain confirmation.');
  } else if (report.status === 'behavior-changed') {
    steps.push('Decide whether the change at input ' + report.comparison?.firstMismatch?.packedInput + ' is intended.');
    steps.push('If it is, record the decision with acceptChange in pincheck.json so reviewers see it. Otherwise keep the current circuit.');
    if (report.replay?.status === 'unavailable') steps.push('On-chain replay was unavailable. The local mismatch still fails the release check; rerun to confirm it on X Layer.');
  } else if (report.status === 'interface-mismatch') {
    steps.push('Update the code that packs inputs and reads outputs for the new widths, then review it as a breaking change.');
  } else {
    const byCode = {
      'rpc-unavailable': 'Retry, or set X_LAYER_RPC to another X Layer mainnet endpoint. The check stays failed until a comparison completes.',
      'rpc-timeout': 'Retry, or use a faster X Layer RPC. The check stays failed until a comparison completes.',
      'rpc-error': 'Retry with another X Layer RPC. The check stays failed until a comparison completes.',
      'historical-state-unavailable': 'The recorded report is still valid evidence. To rerun at that block, use an archive RPC, or rerun at the latest block.',
      'block-not-found': 'Check the block hash, or rerun at the latest block.',
      'block-changed': 'The block was reorganized during the run. Rerun the comparison.',
      'wrong-chain': 'Point X_LAYER_RPC at an X Layer mainnet (chain 196) endpoint.',
      'no-circuit': 'Check the circuit ID. It must already be taped out on that processor.',
      'unregistered-processor': 'Use a processor created by the X Layer TapeOut factory. PinCheck does not read other contracts.',
      'unsupported-processor': 'The contract did not answer with the TAP-02 processor ABI.',
      stateful: 'Stateful circuits are supported only when the netlists are identical. Review this change manually, and record it with acceptChange if you approve it.',
      'too-wide': 'Exhaustive checks cover up to 26 input bits in the CLI and GitHub Action, and 24 in the web workbench. Review this change manually, and record it with acceptChange if you approve it.',
      'too-large': 'The circuit exceeds PinCheck limits. Review this change manually, and record it with acceptChange if you approve it.',
      'time-budget': 'Run the CLI locally or in CI, which allows more time than the web workbench.',
      'invalid-netlist': 'The stored netlist is not well-formed TAP-02. Do not adopt it.',
      'replay-disagrees': 'A processor and PinCheck disagree. Do not ship this change, and open an issue with this report.',
      'invalid-input': 'Enter each circuit as processor-address:circuit-id.',
    };
    steps.push(byCode[code] ?? 'Rerun the comparison. If it keeps failing, open an issue with this report.');
  }
  return steps;
}

export function cliCommand(report) {
  const block = report.block?.hash ?? report.block?.number;
  return 'node cli.mjs ' + (block ? '--block ' + block + ' ' : '') + refText(report.baseline) + ' ' + refText(report.candidate);
}

export const refText = ref => ref ? ref.address + ':' + ref.id : '';
export const shortAddress = address => address ? address.slice(0, 6) + '…' + address.slice(-4) : '';
export const shortRef = ref => ref ? shortAddress(ref.address) + ' #' + ref.id : '';
const bits = (count, noun) => count + ' ' + noun + (count === 1 ? ' bit' : ' bits');
const sentence = text => /[.!?]$/.test(text) ? text : text + '.';

// Bit-level view of a counterexample, with names when the manifest declares them. Vectors are LSB-first.
export function bitRows(packed, width, names = []) {
  const bytes = (packed ?? '0x').slice(2).match(/../g) ?? [];
  return Array.from({ length: width }, (_, i) => ({
    index: i, name: names[i] ?? null, value: (Number.parseInt(bytes[i >> 3] ?? '00', 16) >> (i & 7)) & 1,
  }));
}

// Schema 1 reports (captured before v0.2.0) are rendered through the same view.
export function normalize(report) {
  if (!report || typeof report !== 'object') throw new Error('Not a PinCheck report');
  if (report.schema === SCHEMA || report.schema === 'pincheck-gate/1') return report;
  if (report.schema !== 1) throw new Error('Unsupported report schema ' + report.schema);
  const comparison = report.status === 'interface-mismatch'
    ? { status: 'interface-mismatch', method: 'interface' }
    : report.checked != null
      ? { status: report.mismatches ? 'different' : 'equivalent', method: 'exhaustive', exhaustive: true, checked: report.checked, space: String(report.checked), mismatches: report.mismatches, firstMismatch: report.firstMismatch }
      : undefined;
  const iface = report.nIn != null ? { baseline: { nIn: report.nIn, nOut: report.nOut, nState: 0 }, candidate: { nIn: report.nIn, nOut: report.nOut, nState: 0 } }
    : report.baselineWidth ? { baseline: { nIn: report.baselineWidth[0], nOut: report.baselineWidth[1] }, candidate: { nIn: report.candidateWidth[0], nOut: report.candidateWidth[1] } } : undefined;
  const normalized = {
    schema: 1, tool: { name: 'pincheck', version: '0.1.0', evaluator: report.evaluator },
    status: report.status, reason: report.reason, baseline: report.baseline, candidate: report.candidate,
    interface: iface, comparison,
    replay: report.replay ? { kind: 'counterexample', ...report.replay } : { status: report.status === 'compatible' ? 'not-applicable' : 'not-run' },
    chain: { id: report.chainId, name: 'X Layer mainnet' }, block: report.block,
    pinning: { method: 'block-number', note: 'Schema 1 reports pinned calls by block number and rechecked the hash after the run' },
    dependencies: report.dependencies,
  };
  normalized.guarantee = guaranteeFor(normalized);
  return normalized;
}
