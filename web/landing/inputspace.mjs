// Draws the full input space of two circuits: one cell per input, lit where the outputs differ.
// The map is computed on the GPU with TypeGPU when WebGPU is available, otherwise on the CPU,
// and its count is checked against the recorded PinCheck report.
import { decode, diffWordsCpu, popcount, gpuProgram, DIFF_WGSL, fitsGpu, outputsOf, bitsOf, pack } from './circuit.mjs';

async function diffWordsGpu(a, b) {
  if (!('gpu' in navigator) || !fitsGpu(a, b)) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const { tgpu, d } = await import('/vendor/typegpu.mjs');
  const device = await adapter.requestDevice();
  const root = tgpu.initFromDevice({ device });
  try {
    const program = gpuProgram(a, b);
    const words = program[0];
    const programBuffer = root.createReadonly(d.arrayOf(d.u32, program.length), Array.from(program));
    const diffBuffer = root.createMutable(d.arrayOf(d.u32, words));
    const main = tgpu.computeFn({ in: { gid: d.builtin.globalInvocationId }, workgroupSize: [64] })(DIFF_WGSL)
      .$uses({ program: programBuffer, diff: diffBuffer });
    const pipeline = root.createComputePipeline({ compute: main });
    const started = performance.now();
    pipeline.dispatchWorkgroups(Math.ceil(words / 64));
    const result = Uint32Array.from(await diffBuffer.read());
    return { words: result, ms: performance.now() - started, engine: 'WebGPU' };
  } finally {
    root.destroy();
    device.destroy();
  }
}

// Z-order layout: x takes the even input bits and y the odd ones, so inputs that share high bits sit together.
function toXY(input) {
  let x = 0, y = 0;
  for (let bit = 0; bit < 16; bit++) { x |= ((input >>> (2 * bit)) & 1) << bit; y |= ((input >>> (2 * bit + 1)) & 1) << bit; }
  return [x, y];
}
function toInput(x, y) {
  let input = 0;
  for (let bit = 0; bit < 16; bit++) input += (((x >>> bit) & 1) * 2 ** (2 * bit)) + (((y >>> bit) & 1) * 2 ** (2 * bit + 1));
  return input;
}

export async function mountInputSpace(section, { netlists, report }) {
  const canvas = section.querySelector('canvas');
  const [keyA, keyB] = [report.baseline, report.candidate].map(r => r.address + ':' + r.id);
  const a = decode(netlists[keyA].netlist, netlists[keyA].nIn, netlists[keyA].nOut);
  const b = decode(netlists[keyB].netlist, netlists[keyB].nIn, netlists[keyB].nOut);
  const set = (name, value) => { const el = section.querySelector('[data-stat="' + name + '"]'); if (el) el.textContent = value; };
  const total = 2 ** a.nIn;
  const side = 2 ** Math.ceil(a.nIn / 2);
  const rows = total / side;  // with an odd bit count the extra bit goes to x
  canvas.width = side;
  canvas.height = rows;

  let result = null;
  try { result = await diffWordsGpu(a, b); } catch (error) { console.warn('WebGPU compute unavailable:', error.message); }
  if (!result) {
    const started = performance.now();
    result = { words: diffWordsCpu(a, b), ms: performance.now() - started, engine: 'CPU' };
  }
  const differ = popcount(result.words);
  const matches = differ === report.comparison.mismatches;
  section.dataset.engine = result.engine;
  section.dataset.verified = String(matches);
  set('engine', result.engine === 'WebGPU' ? 'WebGPU' : 'CPU');
  set('time', result.ms < 1 ? '<1 ms' : Math.round(result.ms).toLocaleString('en-US') + ' ms');
  set('verified', matches ? 'Matches report' : 'Mismatch');

  // Scanline reveal of the map, counting inputs as they are drawn.
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(side, rows);
  const px = new Uint32Array(image.data.buffer);
  const style = getComputedStyle(document.documentElement);
  const abgr = name => {
    const [r, g, bl] = style.getPropertyValue(name).trim().match(/\w\w/g).map(h => Number.parseInt(h, 16));
    return (255 << 24 | bl << 16 | g << 8 | r) >>> 0;
  };
  const hit = abgr('--map-hit'), miss = abgr('--map-miss');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isSet = input => (result.words[input >>> 5] >>> (input & 31)) & 1;
  let drawnRows = 0, counted = 0;
  const step = () => {
    const target = reduce ? rows : Math.min(rows, drawnRows + Math.ceil(rows / 45));
    for (let y = drawnRows; y < target; y++) {
      for (let x = 0; x < side; x++) {
        const on = isSet(toInput(x, y));
        counted += on;
        px[y * side + x] = on ? hit : miss;
      }
    }
    drawnRows = target;
    ctx.putImageData(image, 0, 0);
    set('checked', (drawnRows * side).toLocaleString('en-US'));
    set('differ', counted.toLocaleString('en-US'));
    if (drawnRows < rows) requestAnimationFrame(step);
    else section.dataset.done = 'true';
  };
  step();

  // Inspect any input: pointer over the map, or arrow keys when it has focus.
  const probe = section.querySelector('[data-probe]');
  let cursor = 0;
  const show = input => {
    cursor = Math.max(0, Math.min(total - 1, input));
    const bits = bitsOf(cursor, a.nIn);
    const [oa, ob] = [outputsOf(a, bits), outputsOf(b, bits)];
    const differs = oa.some((v, i) => v !== ob[i]);
    probe.hidden = false;
    probe.dataset.differs = String(differs);
    probe.querySelector('[data-k="input"]').textContent = pack(bits);
    probe.querySelector('[data-k="a"]').textContent = pack(oa);
    probe.querySelector('[data-k="b"]').textContent = pack(ob);
    const [x, y] = toXY(cursor);
    probe.dataset.side = x > side * 0.6 ? 'left' : 'right';
    probe.dataset.vside = y > rows * 0.75 ? 'up' : 'down';
    probe.style.setProperty('--x', (x / side * 100) + '%');
    probe.style.setProperty('--y', (y / rows * 100) + '%');
  };
  canvas.addEventListener('pointermove', event => {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - r.left) / r.width * side), y = Math.floor((event.clientY - r.top) / r.height * rows);
    if (x >= 0 && y >= 0 && x < side && y < rows) show(toInput(x, y));
  });
  canvas.addEventListener('pointerleave', () => { if (document.activeElement !== canvas) probe.hidden = true; });
  canvas.addEventListener('focus', () => show(cursor || report.comparison.firstMismatch?.input || 0));
  canvas.addEventListener('blur', () => { probe.hidden = true; });
  canvas.addEventListener('keydown', event => {
    const step = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[event.key];
    if (!step && event.key !== 'n') return;
    event.preventDefault();
    if (event.key === 'n') {  // jump to the next differing input, in input order
      for (let i = cursor + 1; i < total; i++) if (isSet(i)) return show(i);
      return;
    }
    const [x, y] = toXY(cursor);
    const nx = Math.max(0, Math.min(side - 1, x + step[0])), ny = Math.max(0, Math.min(rows - 1, y + step[1]));
    show(toInput(nx, ny));
  });
  return { engine: result.engine, differ, matches };
}
