// Browser-side view of TAP-02 netlists for the landing page: decode REF-free netlists, lay them out,
// evaluate them per signal, and compute bit-sliced difference maps. Results are cross-checked against
// the recorded reports produced by src/compare.mjs.

export function decode(hex, nIn, nOut) {
  const bytes = hex.slice(2).match(/../g).map(pair => Number.parseInt(pair, 16));
  const gates = [];
  for (let offset = 0; offset < bytes.length; offset += 7) {
    if (bytes[offset] !== 0) return null;  // LATCH or REF: not drawn here
    const signal = at => bytes[at] * 65536 + bytes[at + 1] * 256 + bytes[at + 2];
    gates.push([signal(offset + 1), signal(offset + 4)]);
  }
  const width = 2 + nIn + gates.length;
  const outputs = Array.from({ length: nOut }, (_, i) => width - nOut + i);
  return { nIn, nOut, gates, outputs, base: 2 + nIn };
}

// Longest path from the inputs, per signal. Constants and inputs are level 0.
export function levels(circuit) {
  const level = new Array(circuit.base + circuit.gates.length).fill(0);
  circuit.gates.forEach(([a, b], k) => { level[circuit.base + k] = Math.max(level[a], level[b]) + 1; });
  return level;
}

// Every signal's value for one input vector (bits LSB-first).
export function signals(circuit, bits) {
  const s = [0, 1, ...bits];
  for (const [a, b] of circuit.gates) s.push(1 - (s[a] & s[b]));
  return s;
}

export const outputsOf = (circuit, bits) => {
  const s = signals(circuit, bits);
  return circuit.outputs.map(index => s[index]);
};

export const bitsOf = (value, width) => Array.from({ length: width }, (_, i) => Math.floor(value / 2 ** i) % 2);

export function pack(bits) {
  const bytes = new Array(Math.ceil(bits.length / 8)).fill(0);
  bits.forEach((bit, i) => { bytes[i >> 3] |= bit << (i & 7); });
  return '0x' + bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

const PATTERNS = [0xaaaaaaaa | 0, 0xcccccccc | 0, 0xf0f0f0f0 | 0, 0xff00ff00 | 0, 0xffff0000 | 0];

// One 32-bit mask per 32 consecutive inputs: bit L of word W is set when input W*32+L differs.
export function diffWordsCpu(a, b) {
  const nIn = a.nIn;
  const words = nIn <= 5 ? 1 : 2 ** (nIn - 5);
  const sa = new Int32Array(a.base + a.gates.length), sb = new Int32Array(b.base + b.gates.length);
  sa[1] = sb[1] = -1;
  const ga = Int32Array.from(a.gates.flat()), gb = Int32Array.from(b.gates.flat());
  const out = new Uint32Array(words);
  const mask = nIn >= 5 ? -1 : (1 << (2 ** nIn)) - 1;
  for (let w = 0; w < words; w++) {
    for (let i = 0; i < nIn; i++) sa[2 + i] = sb[2 + i] = i < 5 ? PATTERNS[i] : ((w >>> (i - 5)) & 1 ? -1 : 0);
    for (let k = 0, base = a.base; k < ga.length; k += 2) sa[base++] = ~(sa[ga[k]] & sa[ga[k + 1]]);
    for (let k = 0, base = b.base; k < gb.length; k += 2) sb[base++] = ~(sb[gb[k]] & sb[gb[k + 1]]);
    let d = 0;
    for (let j = 0; j < a.outputs.length; j++) d |= sa[a.outputs[j]] ^ sb[b.outputs[j]];
    out[w] = (d & mask) >>> 0;
  }
  return out;
}

export function popcount(words) {
  let total = 0;
  for (let v of words) {
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    total += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return total;
}

// The same bit-sliced evaluation as diffWordsCpu, as one WGSL compute pass (one invocation per word).
export const DIFF_WGSL = /* wgsl */ `{
  let word = in.gid.x;
  if (word >= program[0]) { return; }
  let nIn = program[1];
  let countA = program[2];
  let countB = program[3];
  let nOut = program[4];
  var sa: array<u32, 512>;
  var sb: array<u32, 512>;
  var patterns = array<u32, 5>(0xaaaaaaaau, 0xccccccccu, 0xf0f0f0f0u, 0xff00ff00u, 0xffff0000u);
  sa[0] = 0u; sb[0] = 0u; sa[1] = 0xffffffffu; sb[1] = 0xffffffffu;
  for (var i = 0u; i < nIn; i++) {
    var v = 0u;
    if (i < 5u) { v = patterns[i]; } else if (((word >> (i - 5u)) & 1u) == 1u) { v = 0xffffffffu; }
    sa[2u + i] = v;
    sb[2u + i] = v;
  }
  let base = 2u + nIn;
  var p = 5u;
  for (var k = 0u; k < countA; k++) { sa[base + k] = ~(sa[program[p]] & sa[program[p + 1u]]); p += 2u; }
  for (var k = 0u; k < countB; k++) { sb[base + k] = ~(sb[program[p]] & sb[program[p + 1u]]); p += 2u; }
  var d = 0u;
  for (var j = 0u; j < nOut; j++) { d = d | (sa[program[p + j]] ^ sb[program[p + nOut + j]]); }
  if (nIn < 5u) { d = d & ((1u << (1u << nIn)) - 1u); }
  diff[word] = d;
}`;

// Flat program for DIFF_WGSL: [words, nIn, countA, countB, nOut, gatesA…, gatesB…, outputsA…, outputsB…]
export function gpuProgram(a, b) {
  const words = a.nIn <= 5 ? 1 : 2 ** (a.nIn - 5);
  return Uint32Array.from([words, a.nIn, a.gates.length, b.gates.length, a.nOut, ...a.gates.flat(), ...b.gates.flat(), ...a.outputs, ...b.outputs]);
}

export const fitsGpu = (a, b) => a.base + a.gates.length <= 512 && b.base + b.gates.length <= 512 && a.nIn <= 26;
