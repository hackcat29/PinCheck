// TAP-02 circuit comparison. Pure: all chain access goes through the injected reader.
// Signal indices are big-endian u24; input/output vectors are packed LSB-first (TAP-02 §5).

export const DEFAULT_LIMITS = Object.freeze({
  maxNetlistBytes: 512 * 1024,  // per circuit, after ABI decoding
  maxCircuits: 64,              // distinct circuits in both REF closures
  maxRefDepth: 16,              // REF nesting
  maxExpandedGates: 20000,      // NAND gates per circuit after inlining REFs
  maxExhaustiveBits: 26,        // widest input space enumerated
  maxWork: 2 ** 32,             // (2^nIn / 32) × total gates, bounds exhaustive and sampled work
  sampleWords: 2 ** 15,         // 32 inputs per word: ~1M sampled inputs for wide circuits
  deadlineMs: 45000,
});

export const SAMPLE_SEED = 0x5eed1e55;

class Unsupported extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export async function compare(reader, baseline, candidate, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const deadline = Date.now() + limits.deadlineMs;
  const parsed = new Map();
  const dependencies = {};
  const result = { dependencies };
  const infos = new Map();
  const infoOf = ref => {
    const key = refKey(ref);
    if (!infos.has(key)) infos.set(key, Promise.resolve().then(() => reader.info(ref)));
    return infos.get(key);
  };

  async function load(ref, path) {
    const key = refKey(ref);
    if (path.includes(key)) throw new Unsupported('Circuit references form a cycle', 'invalid-netlist');
    if (path.length > limits.maxRefDepth) throw new Unsupported('REF nesting exceeds ' + limits.maxRefDepth + ' levels', 'too-large');
    if (parsed.has(key)) return parsed.get(key);
    if (parsed.size >= limits.maxCircuits) throw new Unsupported('More than ' + limits.maxCircuits + ' circuits in the REF closure', 'too-large');
    const info = await infoOf(ref);
    checkInfo(info, path.length > 0);
    const netlist = await reader.netlist(ref);
    const bytes = decodeHex(netlist, limits.maxNetlistBytes);
    dependencies[key] = { nIn: info.nIn, nOut: info.nOut, nState: info.nState, gateCount: info.gateCount, bytes };
    const circuit = { key, ...info, bytes, records: [], cost: 0, latches: 0, depth: 0 };
    parsed.set(key, circuit);
    let width = info.nIn + 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const index = at => bytes[at] * 65536 + view.getUint16(at + 1);
    for (let offset = 0; offset < bytes.length;) {
      const opcode = bytes[offset];
      if (opcode === 0 && offset + 7 <= bytes.length) {
        const a = index(offset + 1), b = index(offset + 4);
        if (a >= width || b >= width) throw new Unsupported('NAND references a future signal', 'invalid-netlist');
        circuit.records.push({ a, b });
        circuit.cost++;
        width++;
        offset += 7;
      } else if (opcode === 1 && offset + 4 <= bytes.length) {
        circuit.records.push({ latch: index(offset + 1) });
        circuit.latches++;
        width++;
        offset += 4;
      } else if (opcode === 2 && offset + 31 <= bytes.length) {
        const address = '0x' + hex(bytes.subarray(offset + 1, offset + 21));
        const id = view.getBigUint64(offset + 21).toString();
        const nIns = bytes[offset + 29], nOuts = bytes[offset + 30];
        if (offset + 31 + nIns * 3 > bytes.length) throw new Unsupported('Truncated REF record', 'invalid-netlist');
        const inputs = Array.from({ length: nIns }, (_, i) => index(offset + 31 + 3 * i));
        if (inputs.some(signal => signal >= width)) throw new Unsupported('REF references a future signal', 'invalid-netlist');
        const child = await load({ address, id }, [...path, key]);
        if (child.nIn !== nIns || child.nOut !== nOuts) throw new Unsupported('REF pin count does not match the referenced circuit', 'invalid-netlist');
        circuit.records.push({ child, inputs });
        circuit.cost += child.cost;
        circuit.latches += child.latches;
        circuit.depth = Math.max(circuit.depth, child.depth + 1);
        width += nOuts;
        offset += 31 + nIns * 3;
      } else {
        throw new Unsupported(opcode > 2 ? 'Unknown netlist opcode 0x' + opcode.toString(16) : 'Truncated netlist record', 'invalid-netlist');
      }
      if (width > 2 ** 24) throw new Unsupported('Netlist exceeds 2^24 signals', 'invalid-netlist');
    }
    for (const record of circuit.records) {
      if ('latch' in record && record.latch >= width) throw new Unsupported('LATCH input out of range', 'invalid-netlist');
    }
    if (width - info.nIn - 2 < info.nOut) throw new Unsupported('Netlist produces fewer signals than its outputs', 'invalid-netlist');
    if (circuit.latches !== info.nState) throw new Unsupported('Declared state size does not match the netlist', 'invalid-netlist');
    if (Number.isInteger(info.gateCount) && info.gateCount !== circuit.cost + circuit.latches) {
      throw new Unsupported('Reported gate count does not match the netlist', 'invalid-netlist');
    }
    return circuit;
  }

  try {
    const [baseInfo, candInfo] = await Promise.all([infoOf(baseline), infoOf(candidate)]);
    checkInfo(baseInfo, false);
    checkInfo(candInfo, false);
    result.interface = { baseline: publicInfo(baseInfo), candidate: publicInfo(candInfo) };
    if (baseInfo.nIn !== candInfo.nIn || baseInfo.nOut !== candInfo.nOut) {
      return { status: 'interface-mismatch', comparison: { status: 'interface-mismatch', method: 'interface' }, ...result };
    }
    const { nIn, nOut } = baseInfo;
    const space = nIn <= 64 ? (2n ** BigInt(nIn)).toString() : '2^' + nIn;

    // Read both closures. gateCount from circuitInfo bounds REF expansion before any netlist is fetched.
    const identicalCandidate = baseInfo.nState === candInfo.nState && baseInfo.gateCount === candInfo.gateCount;
    const oversized = [baseInfo, candInfo].some(info => Number.isInteger(info.gateCount) && info.gateCount > limits.maxExpandedGates);
    if (oversized && !identicalCandidate) {
      throw new Unsupported('A circuit has more than ' + limits.maxExpandedGates + ' gates including REFs', 'too-large');
    }
    const oldCircuit = await load(baseline, []);
    const newCircuit = await load(candidate, []);

    // Same records, same REF targets, same dimensions: identical beat function for every input and state.
    const identical = equalBytes(oldCircuit.bytes, newCircuit.bytes) && oldCircuit.nState === newCircuit.nState;
    const tooBig = oldCircuit.cost > limits.maxExpandedGates || newCircuit.cost > limits.maxExpandedGates;
    const identicalResult = () => ({
      status: 'compatible',
      comparison: { status: 'equivalent', method: 'identical-netlist', exhaustive: true, checked: null, space, mismatches: 0, identicalNetlist: true },
      probes: oldCircuit.nState === 0 && !tooBig ? probes(oldCircuit, newCircuit, nIn) : [],
      ...result,
    });
    if (identical && (oldCircuit.nState || tooBig)) return identicalResult();
    if (oldCircuit.nState || newCircuit.nState) {
      throw new Unsupported('Stateful circuits (LATCH) can only be compared when their netlists are identical', 'stateful');
    }
    if (tooBig) throw new Unsupported('A circuit expands to more than ' + limits.maxExpandedGates + ' gates', 'too-large');
    const programs = [compile(oldCircuit, limits), compile(newCircuit, limits)];
    const gates = programs[0].count + programs[1].count;
    const exhaustiveWords = nIn <= 5 ? 1 : 2 ** (nIn - 5);
    if (nIn <= limits.maxExhaustiveBits && exhaustiveWords * Math.max(gates, 1) <= limits.maxWork) {
      const scan = await search(programs, nIn, nOut, exhaustiveWords, null, deadline);
      const checked = 2 ** nIn;
      return {
        status: scan.mismatches ? 'behavior-changed' : 'compatible',
        comparison: {
          status: scan.mismatches ? 'different' : 'equivalent', method: 'exhaustive', exhaustive: true,
          checked, space, mismatches: scan.mismatches, firstMismatch: scan.first, identicalNetlist: identical,
        },
        probes: scan.mismatches ? [] : probes(oldCircuit, newCircuit, nIn),
        ...result,
      };
    }
    if (identical) return identicalResult();
    // Too wide to enumerate: a sampled counterexample is still a real behavior change, but no sample can pass.
    const words = Math.max(1, Math.min(limits.sampleWords, Math.floor(limits.maxWork / Math.max(gates, 1))));
    const scan = await search(programs, nIn, nOut, words, SAMPLE_SEED, deadline);
    const comparison = {
      status: scan.mismatches ? 'different' : 'incomplete', method: 'sampled', exhaustive: false,
      checked: words * 32, space, mismatches: scan.mismatches, firstMismatch: scan.first, seed: SAMPLE_SEED,
    };
    if (scan.mismatches) return { status: 'behavior-changed', comparison, probes: [], ...result };
    return {
      status: 'inconclusive', code: 'too-wide',
      reason: nIn + ' input bits is too many to check every input. ' + (words * 32).toLocaleString('en-US') + ' sampled inputs matched, which is not proof of compatibility',
      comparison, probes: [], ...result,
    };
  } catch (error) {
    return { status: 'inconclusive', code: error.code ?? 'error', reason: error.message, ...result };
  }
}

// Inline REFs into one flat NAND program. Flat signal 0 = constant 0, 1 = constant 1, 2.. = inputs, then gates.
function compile(circuit, limits) {
  if (circuit.program) return circuit.program;
  const a = [], b = [];
  const base = 2 + circuit.nIn;
  function inline(node, inputs) {
    const local = [0, 1, ...inputs];
    for (const record of node.records) {
      if (record.child) {
        local.push(...inline(record.child, record.inputs.map(signal => local[signal])));
      } else {
        if (a.length >= limits.maxExpandedGates) throw new Unsupported('A circuit expands to more than ' + limits.maxExpandedGates + ' gates', 'too-large');
        a.push(local[record.a]);
        b.push(local[record.b]);
        local.push(base + a.length - 1);
      }
    }
    return local.slice(local.length - node.nOut);
  }
  const outputs = inline(circuit, Array.from({ length: circuit.nIn }, (_, i) => 2 + i));
  circuit.program = { nIn: circuit.nIn, base, count: a.length, a: Int32Array.from(a), b: Int32Array.from(b), outputs: Int32Array.from(outputs) };
  return circuit.program;
}

function run(program, signals) {
  const { a, b, base, count } = program;
  for (let k = 0; k < count; k++) signals[base + k] = ~(signals[a[k]] & signals[b[k]]);
}

const LANE_PATTERNS = [0xaaaaaaaa | 0, 0xcccccccc | 0, 0xf0f0f0f0 | 0, 0xff00ff00 | 0, 0xffff0000 | 0];

async function search(programs, nIn, nOut, words, seed, deadline) {
  const signals = programs.map(program => { const s = new Int32Array(program.base + program.count); s[1] = -1; return s; });
  const lanes = nIn >= 5 ? 32 : 2 ** nIn;
  const mask = lanes === 32 ? -1 : (1 << lanes) - 1;
  let random = seed ?? 0;
  let mismatches = 0;
  let first;
  for (let word = 0; word < words; word++) {
    for (let i = 0; i < nIn; i++) {
      let value;
      if (seed === null) value = i < 5 ? LANE_PATTERNS[i] : ((word >>> (i - 5)) & 1 ? -1 : 0);
      else {
        random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
        value = word === 0 ? (random & ~3) | 2 : random;  // first word: lane 0 all zeros, lane 1 all ones
      }
      signals[0][2 + i] = value;
      signals[1][2 + i] = value;
    }
    run(programs[0], signals[0]);
    run(programs[1], signals[1]);
    let diff = 0;
    const [outA, outB] = [programs[0].outputs, programs[1].outputs];
    for (let j = 0; j < nOut; j++) diff |= signals[0][outA[j]] ^ signals[1][outB[j]];
    diff &= mask;
    if (diff) {
      mismatches += popcount(diff);
      if (!first) {
        const lane = 31 - Math.clz32(diff & -diff);
        const bit = (s, index) => (s[index] >>> lane) & 1;
        const inputBits = Array.from({ length: nIn }, (_, i) => bit(signals[0], 2 + i));
        const oldBits = Array.from(outA, index => bit(signals[0], index));
        const newBits = Array.from(outB, index => bit(signals[1], index));
        first = {
          ...(nIn <= 48 && seed === null ? { input: word * lanes + lane } : {}),
          packedInput: pack(inputBits), baselineOutput: pack(oldBits), candidateOutput: pack(newBits),
          changedBits: oldBits.flatMap((value, index) => value === newBits[index] ? [] : [index]),
        };
      }
    }
    if ((word & 4095) === 4095) {
      if (Date.now() > deadline) throw new Unsupported('The comparison exceeded its time budget', 'time-budget');
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return { mismatches, first };
}

// A few fixed inputs whose local outputs the adapter can replay against the deployed processors.
function probes(oldCircuit, newCircuit, nIn) {
  try {
    return probeInputs(oldCircuit, newCircuit, nIn);
  } catch {
    return [];  // probes are optional cross-checks; they never decide a result
  }
}

function probeInputs(oldCircuit, newCircuit, nIn) {
  const programs = [oldCircuit.program ?? compile(oldCircuit, DEFAULT_LIMITS), newCircuit.program ?? compile(newCircuit, DEFAULT_LIMITS)];
  const inputs = [Array(nIn).fill(0), Array(nIn).fill(1)];
  let random = SAMPLE_SEED;
  inputs.push(Array.from({ length: nIn }, () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random & 1; }));
  const seen = new Set();
  return inputs.flatMap(bits => {
    const packedInput = pack(bits);
    if (seen.has(packedInput)) return [];
    seen.add(packedInput);
    const [baselineOutput, candidateOutput] = programs.map(program => pack(evaluateOne(program, bits)));
    return [{ packedInput, baselineOutput, candidateOutput }];
  });
}

export function evaluateOne(program, bits) {
  const signals = new Int32Array(program.base + program.count);
  signals[1] = -1;
  bits.forEach((bit, i) => { signals[2 + i] = bit ? -1 : 0; });
  run(program, signals);
  return Array.from(program.outputs, index => signals[index] & 1);
}

function checkInfo(info, referenced) {
  const { nIn, nOut, nState } = info;
  const max = referenced ? 255 : 65536;
  if (![nIn, nOut, nState].every(Number.isInteger) || nIn < 0 || nIn > max || nOut < 1 || nOut > max || nState < 0) {
    throw new Unsupported('Circuit dimensions are outside TAP-02 limits', 'invalid-netlist');
  }
}

const publicInfo = ({ nIn, nOut, nState, gateCount }) => ({ nIn, nOut, nState, ...(gateCount === undefined ? {} : { gateCount }) });

export function refKey(ref) {
  return ref.address.toLowerCase() + ':' + ref.id;
}

function decodeHex(value, maxBytes) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new Unsupported('Invalid netlist encoding', 'invalid-netlist');
  if ((value.length - 2) / 2 > maxBytes) throw new Unsupported('Netlist is larger than ' + maxBytes + ' bytes', 'too-large');
  return Uint8Array.from(value.slice(2).match(/../g) ?? [], pair => Number.parseInt(pair, 16));
}

function equalBytes(x, y) {
  return x.length === y.length && x.every((value, i) => value === y[i]);
}

function popcount(value) {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function pack(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => { bytes[index >> 3] |= bit << (index & 7); });
  return '0x' + hex(bytes);
}

export function unpack(packed, length) {
  const bytes = packed.slice(2).match(/../g) ?? [];
  return Array.from({ length }, (_, i) => (Number.parseInt(bytes[i >> 3] ?? '00', 16) >> (i & 7)) & 1);
}

export function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
