// Hero: the two real OrderGuard netlists from pull request #1, rendered with three.js (WebGPU, or WebGL 2
// as a fallback). Both circuits share their inputs; wires and pulses carry each signal's live value.
import { decode, levels, signals, bitsOf, pack } from './circuit.mjs';

const DX = 1.55, ROW = 1.9;

function layout(circuit, yOffset, depth) {
  const lv = levels(circuit);
  const pos = {};
  const byLevel = {};
  circuit.gates.forEach((_, k) => (byLevel[lv[circuit.base + k]] ??= []).push(circuit.base + k));
  for (const [level, ids] of Object.entries(byLevel)) {
    ids.forEach((id, i) => {
      const spread = (i - (ids.length - 1) / 2) * 0.95;
      pos[id] = [Number(level) * DX, yOffset + spread, (i % 2 ? -1 : 1) * depth * (ids.length > 1 ? 1 : 0.4)];
    });
  }
  return { pos, maxLevel: Math.max(0, ...circuit.gates.map((_, k) => lv[circuit.base + k])) };
}

export async function mountScene(stage, { netlists, report }) {
  const keyA = report.baseline.address + ':' + report.baseline.id;
  const keyB = report.candidate.address + ':' + report.candidate.id;
  const A = decode(netlists[keyA].netlist, netlists[keyA].nIn, netlists[keyA].nOut);
  const B = decode(netlists[keyB].netlist, netlists[keyB].nIn, netlists[keyB].nOut);
  const nIn = A.nIn;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const compact = matchMedia('(max-width: 720px)').matches;

  // Shared nodes: constants (only if referenced) and inputs.
  const shared = {};
  const used = new Set([...A.gates.flat(), ...B.gates.flat()]);
  for (let i = 0; i < nIn; i++) shared[2 + i] = [0, (nIn === 1 ? 0 : (0.5 - i / (nIn - 1)) * 1.5), 0];
  if (used.has(1)) shared[1] = [0.55, 0, -0.8];
  if (used.has(0)) shared[0] = [0.55, 0, 0.8];
  const la = layout(A, ROW, 0.45), lb = layout(B, -ROW, 0.45);
  const outX = (Math.max(la.maxLevel, lb.maxLevel) + 1) * DX;
  const circuits = [
    { c: A, pos: { ...shared, ...la.pos }, out: [outX, ROW, 0], id: report.baseline.id },
    { c: B, pos: { ...shared, ...lb.pos }, out: [outX, -ROW, 0], id: report.candidate.id },
  ];
  const centerX = outX / 2;

  // Edges: [circuit index, source signal, destination position, kind]
  const edges = [];
  circuits.forEach((entry, ci) => {
    entry.c.gates.forEach(([x, y], k) => {
      for (const src of new Set([x, y])) edges.push({ ci, src, from: entry.pos[src], to: entry.pos[entry.c.base + k] });
    });
    entry.c.outputs.forEach(o => edges.push({ ci, src: o, from: entry.pos[o], to: entry.out, output: true }));
  });

  let bits = bitsOf(Number.parseInt(report.comparison.firstMismatch?.packedInput ?? '0x00', 16), nIn);
  let values = circuits.map(entry => signals(entry.c, bits));
  const pins = [...stage.querySelectorAll('[data-pin]')];
  const outs = [...stage.querySelectorAll('[data-out]')];
  const onChange = new Set();
  const refreshDom = () => {
    pins.forEach((pin, i) => { pin.setAttribute('aria-pressed', String(!!bits[i])); pin.querySelector('[data-v]').textContent = bits[i]; });
    const outputs = circuits.map((entry, ci) => entry.c.outputs.map(o => values[ci][o]));
    outs.forEach((el, ci) => { el.querySelector('[data-v]').textContent = pack(outputs[ci]); });
    const differs = outputs[0].some((v, i) => v !== outputs[1][i]);
    stage.dataset.differs = String(differs);
    stage.querySelector('[data-input]').textContent = pack(bits);
    onChange.forEach(fn => fn());
  };
  const setBits = next => { bits = next; values = circuits.map(entry => signals(entry.c, bits)); refreshDom(); };
  let autoplay = !reduce;
  pins.forEach((pin, i) => pin.addEventListener('click', () => { autoplay = false; const next = [...bits]; next[i] ^= 1; setBits(next); }));
  refreshDom();

  const placeLabels = project => {
    pins.forEach((pin, i) => place(pin, project(shared[2 + i])));
    outs.forEach((el, ci) => place(el, project(circuits[ci].out)));
  };
  // Labels follow their nodes but never leave the stage. Pins sit left of their node, outputs right.
  const place = (el, [x, y]) => {
    const W = stage.clientWidth, H = stage.clientHeight, w = el.offsetWidth, margin = 10;
    let px = x * W;
    if (el.dataset.pin !== undefined) px = Math.max(margin + 1.15 * w, px);
    else px = Math.min(W - margin - 1.18 * w, px);
    const py = Math.max(margin + el.offsetHeight / 2, Math.min(H - 64, y * H));
    el.style.left = px.toFixed(1) + 'px';
    el.style.top = py.toFixed(1) + 'px';
  };

  try {
    await mountThree();
  } catch (error) {
    console.warn('3D renderer unavailable, drawing in 2D:', error.message);
    mount2d();
  }
  stage.dataset.ready = 'true';

  // Cycle through every input until the visitor takes over.
  if (autoplay) {
    let value = bits.reduce((acc, bit, i) => acc + bit * 2 ** i, 0);
    const timer = setInterval(() => {
      if (!autoplay) return clearInterval(timer);
      if (!stage.isConnected) return clearInterval(timer);
      value = (value + 1) % 2 ** nIn;
      setBits(bitsOf(value, nIn));
    }, 2600);
  }

  async function mountThree() {
    const THREE = await import('/vendor/three.mjs');
    const canvas = stage.querySelector('canvas');
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
    await renderer.init();
    stage.dataset.renderer = renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
    renderer.setPixelRatio(Math.min(devicePixelRatio, compact ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);

    const css = getComputedStyle(document.documentElement);
    const color = name => new THREE.Color(css.getPropertyValue(name).trim());
    const ON = color('--signal-on'), OFF = color('--signal-off'), BAD = color('--bad'), INK = color('--ink');

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(compact ? 42 : 32, 1, 0.1, 100);
    const group = new THREE.Group();
    group.position.x = -centerX + 0.35;  // leave room for the output labels on the right
    const pivot = new THREE.Group();
    pivot.add(group);
    scene.add(pivot);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 6, 8);
    scene.add(key);

    const v3 = p => new THREE.Vector3(...p);
    const gateGeo = new THREE.BoxGeometry(0.46, 0.46, 0.46);
    const pinGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    const outGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
    const nodeMat = () => new THREE.MeshStandardNodeMaterial({ color: 0x1b1f25, roughness: 0.35, metalness: 0.6, emissive: OFF.clone() });
    const nodes = [];
    const addNode = (geo, p, ci, signal) => {
      const mesh = new THREE.Mesh(geo, nodeMat());
      mesh.position.copy(v3(p));
      group.add(mesh);
      nodes.push({ mesh, ci, signal });
      return mesh;
    };
    for (const [signal, p] of Object.entries(shared)) addNode(pinGeo, p, 0, Number(signal));
    circuits.forEach((entry, ci) => {
      entry.c.gates.forEach((_, k) => addNode(gateGeo, entry.pos[entry.c.base + k], ci, entry.c.base + k));
      const out = addNode(outGeo, entry.out, ci, entry.c.outputs[0]);
      out.userData.output = true;
    });

    // Wires as tubes along horizontal-tangent bezier curves.
    const wires = edges.map(edge => {
      const [p0, p3] = [v3(edge.from), v3(edge.to)];
      const bend = Math.max(0.35, (p3.x - p0.x) * 0.5);
      const curve = new THREE.CubicBezierCurve3(p0, p0.clone().add(new THREE.Vector3(bend, 0, 0)), p3.clone().add(new THREE.Vector3(-bend, 0, 0)), p3);
      const material = new THREE.MeshBasicNodeMaterial({ color: OFF.clone() });
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.022, 6, false), material);
      group.add(mesh);
      return { ...edge, curve, material };
    });

    // Pulses travelling along every wire.
    const perWire = compact ? 2 : 3;
    const pulses = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 12, 8), new THREE.MeshBasicNodeMaterial(), wires.length * perWire);
    pulses.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(pulses);

    const floor = new THREE.GridHelper(40, 40, 0x24282e, 0x16191d);
    floor.position.y = -3.6;
    scene.add(floor);

    const paint = () => {
      const outputs = circuits.map((entry, ci) => entry.c.outputs.map(o => values[ci][o]));
      const differs = outputs[0].some((v, i) => v !== outputs[1][i]);
      for (const wire of wires) wire.material.color.copy(values[wire.ci][wire.src] ? ON : OFF);
      for (const node of nodes) {
        const on = values[node.ci][node.signal];
        const target = node.mesh.userData.output && node.ci === 1 && differs ? BAD : on ? ON : OFF;
        node.mesh.material.emissive.copy(target).multiplyScalar(node.mesh.userData.output ? 1.4 : on ? 0.9 : 0.25);
      }
      const tmp = new THREE.Color();
      wires.forEach((wire, w) => {
        tmp.copy(values[wire.ci][wire.src] ? ON : INK).multiplyScalar(values[wire.ci][wire.src] ? 1.6 : 0.35);
        for (let k = 0; k < perWire; k++) pulses.setColorAt(w * perWire + k, tmp);
      });
      pulses.instanceColor.needsUpdate = true;
    };
    pulses.setColorAt(0, ON);
    onChange.add(paint);
    paint();

    // Post-processing glow on larger screens.
    let pipeline = null;
    if (!compact) {
      const Pipeline = THREE.RenderPipeline ?? THREE.PostProcessing;
      pipeline = new Pipeline(renderer);
      const scenePass = THREE.TSL.pass(scene, camera);
      const color = scenePass.getTextureNode('output');
      pipeline.outputNode = color.add(THREE.bloom(color, 0.85, 0.35, 0.12));
    }

    // Drag to rotate, with inertia and a slow idle sway.
    let yaw = -0.32, pitch = 0.16, vy = 0, vp = 0, dragging = false, lastX = 0, lastY = 0, idle = 0, swayPhase = 0;
    canvas.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); stage.dataset.dragging = 'true'; });
    canvas.addEventListener('pointermove', e => {
      if (!dragging) return;
      vy = (e.clientX - lastX) * 0.006; vp = (e.clientY - lastY) * 0.004;
      lastX = e.clientX; lastY = e.clientY; idle = 0;
    });
    const end = () => { dragging = false; delete stage.dataset.dragging; };
    // Hold still while the visitor is pointing at or focused inside the stage, so the pins are easy to hit.
    let holding = false;
    stage.addEventListener('pointerenter', () => { holding = true; });
    stage.addEventListener('pointerleave', () => { holding = false; });
    stage.addEventListener('focusin', () => { holding = true; });
    stage.addEventListener('focusout', () => { holding = false; });
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    const resize = () => {
      const { width, height } = stage.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      const halfFov = Math.tan((camera.fov * Math.PI / 180) / 2);
      const fitWidth = (outX + 3.6) / (2 * halfFov * camera.aspect), fitHeight = (2 * ROW + 2.6) / (2 * halfFov);
      camera.position.set(0, 0.5, Math.max(fitWidth, fitHeight) + 1.2);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(stage);
    resize();

    const project = p => {
      const v = v3(p).applyMatrix4(group.matrixWorld).project(camera);
      return [(v.x + 1) / 2, (1 - v.y) / 2];
    };
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
    let visible = true;
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(stage);
    const timer = new THREE.Timer();
    const frame = () => {
      if (!visible || document.hidden) return;
      timer.update();
      const t = timer.getElapsed(), dt = Math.min(timer.getDelta(), 0.05);
      if (!dragging) { vy *= 0.92; vp *= 0.92; idle = holding ? 0 : idle + dt; }
      yaw = Math.max(-1.1, Math.min(1.1, yaw + vy));
      pitch = Math.max(-0.5, Math.min(0.6, pitch + vp));
      swayPhase += holding || reduce ? 0 : dt * 0.35;
      const sway = reduce ? 0 : Math.sin(swayPhase) * 0.12 * Math.min(1, idle / 3);
      pivot.rotation.set(pitch, yaw + sway, 0);
      wires.forEach((wire, w) => {
        for (let k = 0; k < perWire; k++) {
          const u = reduce ? (k + 0.5) / perWire : ((t * 0.32 + k / perWire + w * 0.137) % 1);
          wire.curve.getPointAt(u, position);
          matrix.makeTranslation(position.x, position.y, position.z);
          pulses.setMatrixAt(w * perWire + k, matrix);
        }
      });
      pulses.instanceMatrix.needsUpdate = true;
      scene.updateMatrixWorld();
      placeLabels(project);
      if (pipeline) pipeline.render(); else renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(frame);
  }

  // No GPU path at all: draw the same layout flat, without depth or glow.
  function mount2d() {
    stage.dataset.renderer = '2d';
    const canvas = stage.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const minY = -ROW - 1.2, maxY = ROW + 1.2, minX = -0.6, maxX = outX + 0.8;
    const project = ([x, y]) => [(x - minX) / (maxX - minX), (maxY - y) / (maxY - minY)];
    const draw = () => {
      const { width, height } = stage.getBoundingClientRect();
      canvas.width = width * devicePixelRatio; canvas.height = height * devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const at = p => { const [u, v] = project(p); return [u * width, v * height]; };
      for (const edge of edges) {
        const [x0, y0] = at(edge.from), [x1, y1] = at(edge.to);
        ctx.strokeStyle = css.getPropertyValue(values[edge.ci][edge.src] ? '--signal-on' : '--signal-off');
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.bezierCurveTo((x0 + x1) / 2, y0, (x0 + x1) / 2, y1, x1, y1); ctx.stroke();
      }
      ctx.fillStyle = css.getPropertyValue('--surface-2');
      for (const entry of circuits) for (const id of Object.keys(entry.pos)) { const [x, y] = at(entry.pos[id]); ctx.fillRect(x - 9, y - 9, 18, 18); }
      placeLabels(project);
    };
    onChange.add(draw);
    new ResizeObserver(draw).observe(stage);
    draw();
  }
}
