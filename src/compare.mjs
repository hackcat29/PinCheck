// Stateless subset of TAP-02. Signal indices are big-endian, vectors LSB-first.
const MAX_GATES = 12000;
const MAX_DEPTH = 12;
const MAX_CIRCUITS = 64;

export async function compare(read, baseline, candidate) {
  const cache = new Map();
  const dependencies = {};
  async function resolve(ref, path = []) {
    const key = ref.address.toLowerCase() + ':' + ref.id;
    if (path.includes(key) || path.length >= MAX_DEPTH) throw new Error('Circuit reference recursion exceeds the supported limit');
    if (cache.has(key)) {
      const cached = cache.get(key);
      if (path.length + cached.depth > MAX_DEPTH) throw new Error('Circuit reference depth exceeds the supported limit');
      return cached;
    }
    if (Object.keys(dependencies).length >= MAX_CIRCUITS) throw new Error('Too many circuit dependencies');
    const { nIn, nOut, nState, netlist } = await read(ref);
    if (nState !== 0) throw new Error('Stateful circuits are unsupported');
    if (!Number.isInteger(nIn) || nIn < 0 || nIn > 255 || !Number.isInteger(nOut) || nOut < 1 || nOut > 255) {
      throw new Error('Circuit dimensions exceed the supported limit');
    }
    if (!/^0x(?:[0-9a-f]{2})*$/i.test(netlist) || netlist.length > 2 + MAX_GATES * 1592) throw new Error('Invalid or oversized netlist');
    const bytes = Uint8Array.from(netlist.slice(2).match(/../g) ?? [], pair => Number.parseInt(pair, 16));
    const view = new DataView(bytes.buffer);
    const records = [];
    let width = nIn + 2;
    let cost = 0;
    let depth = 1;
    dependencies[key] = { nIn, nOut, nState, netlist };
    function signal(at) {
      const index = bytes[at] * 65536 + view.getUint16(at + 1);
      if (index >= width) throw new Error('Netlist references an unavailable signal');
      return index;
    }
    for (let offset = 0; offset < bytes.length;) {
      const opcode = bytes[offset];
      if (opcode === 0 && offset + 7 <= bytes.length) {
        records.push({ inputs: [signal(offset + 1), signal(offset + 4)] });
        width++;
        cost++;
        offset += 7;
      } else if (opcode === 2 && offset + 31 <= bytes.length) {
        const address = '0x' + hex(bytes.slice(offset + 1, offset + 21));
        const id = view.getBigUint64(offset + 21).toString();
        const inputs = bytes[offset + 29];
        const outputs = bytes[offset + 30];
        if (offset + 31 + inputs * 3 > bytes.length) throw new Error('Truncated REF record');
        const child = await resolve({ address, id }, [...path, key]);
        if (child.nIn !== inputs || child.nOut !== outputs) throw new Error('REF interface mismatch');
        records.push({ child, inputs: Array.from({length: inputs}, (_, index) => signal(offset + 31 + 3 * index)) });
        width += outputs;
        cost += 1 + child.cost;
        depth = Math.max(depth, child.depth + 1);
        offset += 31 + inputs * 3;
      } else {
        throw new Error(opcode === 1 ? 'Stateful circuits are unsupported' : 'Unknown or truncated netlist record');
      }
      if (cost > MAX_GATES || width > MAX_GATES * 4) throw new Error('Expanded circuit exceeds the evaluation limit');
    }
    if (width - nIn - 2 < nOut) throw new Error('Netlist produces too few output signals');
    const circuit = { nIn, nOut, records, depth, cost };
    cache.set(key, circuit);
    return circuit;
  }
  try {
    const oldCircuit = await resolve(baseline);
    const newCircuit = await resolve(candidate);
    if (oldCircuit.nIn !== newCircuit.nIn || oldCircuit.nOut !== newCircuit.nOut) {
      return { status: 'interface-mismatch', baselineWidth: [oldCircuit.nIn, oldCircuit.nOut], candidateWidth: [newCircuit.nIn, newCircuit.nOut], dependencies };
    }
    const { nIn, nOut } = oldCircuit;
    if (nIn > 8) throw new Error('Exhaustive comparisons support up to eight input bits');
    let firstMismatch;
    let mismatches = 0;
    for (let input = 0; input < 2 ** nIn; input++) {
      const bits = Array.from({ length: nIn }, (_, index) => (input >> index) & 1);
      const oldBits = evaluate(oldCircuit, bits);
      const newBits = evaluate(newCircuit, bits);
      const changedBits = oldBits.flatMap((bit, index) => bit === newBits[index] ? [] : [index]);
      if (changedBits.length) {
        mismatches++;
        firstMismatch ??= { input, packedInput: pack(bits), baselineOutput: pack(oldBits), candidateOutput: pack(newBits), changedBits };
      }
    }
    return { status: mismatches ? 'behavior-changed' : 'compatible', nIn, nOut, checked: 2 ** nIn, mismatches, firstMismatch, dependencies };
  } catch (error) {
    return { status: 'inconclusive', reason: error.message };
  }
}

function evaluate(circuit, inputs) {
  const signals = [0, 1, ...inputs];
  for (const { child, inputs: indices } of circuit.records) {
    if (child) signals.push(...evaluate(child, indices.map(index => signals[index])));
    else signals.push(1 - (signals[indices[0]] & signals[indices[1]]));
  }
  return signals.slice(-circuit.nOut);
}

function pack(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => { bytes[index >> 3] |= bit << (index & 7); });
  return '0x' + hex(bytes);
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
