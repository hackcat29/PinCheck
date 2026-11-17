const form = document.querySelector('form');
const byId = id => document.getElementById(id);
const submit = form.querySelector('[type=submit]');
const example = byId('example');
const processor = '0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355';
const titles = {
  compatible: 'Compatible',
  'behavior-changed': 'Behavior changed',
  'interface-mismatch': 'Interface mismatch',
  inconclusive: 'Could not complete comparison',
};
let report;

function rows(id, entries) {
  const terms = entries.flatMap(([label, value]) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    return [dt, dd];
  });
  byId(id).replaceChildren(...terms);
}

async function run(parameters) {
  submit.disabled = example.disabled = true;
  byId('results').hidden = false;
  byId('results').dataset.status = '';
  byId('status').textContent = 'Comparing circuits…';
  byId('detail').textContent = '';
  for (const id of ['download', 'mismatch', 'permalink']) byId(id).hidden = true;
  rows('metadata', []);
  try {
    const response = await fetch('/api/compare?' + parameters);
    report = await response.json();
    if (!response.ok) throw new Error(report.reason);
    byId('results').dataset.status = report.status;
    byId('status').textContent = titles[report.status];
    byId('detail').textContent = report.reason ?? (report.status === 'interface-mismatch'
      ? 'Current: ' + report.baselineWidth.join(' → ') + ' bits. Candidate: ' + report.candidateWidth.join(' → ') + ' bits.'
      : report.checked + ' inputs compared. ' + report.mismatches + ' inputs produced different outputs.');
    if (report.block) {
      rows('metadata', [['X Layer block', BigInt(report.block.number).toLocaleString()], ['Dependencies read', Object.keys(report.dependencies ?? {}).length]]);
      const pinned = new URLSearchParams(parameters);
      pinned.set('block', report.block.number);
      byId('permalink').href = '/?' + pinned;
      byId('permalink').hidden = false;
    }
    if (report.firstMismatch) {
      const { input, packedInput, baselineOutput, candidateOutput, changedBits } = report.firstMismatch;
      rows('outputs', [['Input', input + ' (' + packedInput + ')'], ['Current output', baselineOutput],
        ['Candidate output', candidateOutput], ['Changed bit positions', changedBits.join(', ')]]);
      byId('replay').textContent = report.replay?.status === 'confirmed'
        ? 'Both outputs confirmed by the deployed processors on X Layer.'
        : 'Processor replay ' + (report.replay?.status ?? 'unavailable') + (report.replay?.reason ? '. ' + report.replay.reason : '.');
      byId('mismatch').hidden = false;
    }
    byId('download').hidden = false;
  } catch (error) {
    byId('status').textContent = 'Could not complete comparison';
    byId('detail').textContent = error.message;
  } finally {
    submit.disabled = example.disabled = false;
  }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  run(new URLSearchParams(new FormData(form)));
});
example.addEventListener('click', () => {
  form.elements.baseline.value = processor + ':1';
  form.elements.candidate.value = processor + ':2';
  form.requestSubmit();
});
byId('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pincheck-report.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const preset = new URLSearchParams(location.search);
if (preset.has('baseline') && preset.has('candidate')) {
  form.elements.baseline.value = preset.get('baseline');
  form.elements.candidate.value = preset.get('candidate');
  run(preset);
}
