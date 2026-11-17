// Landing page behavior. Everything shown is computed from recorded data in /examples.
import { decode, outputsOf, bitsOf, pack } from './circuit.mjs';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
document.documentElement.classList.add('js');

const data = Promise.all([
  fetch('/examples/netlists.json').then(r => r.json()),
  fetch('/examples/orderguard-1-to-11.json').then(r => r.json()),
  fetch('/examples/neon-reliquary-5-vs-7.json').then(r => r.json()),
]).then(([netlists, orderguard, neon]) => ({ netlists: netlists.circuits, orderguard, neon }));

// Headline: words rise in sequence.
for (const heading of $$('h1.split')) {
  const words = heading.textContent.trim().split(/\s+/);
  heading.setAttribute('aria-label', heading.textContent.trim());
  heading.replaceChildren(...words.flatMap((word, i) => {
    const span = document.createElement('span');
    span.className = 'word';
    span.setAttribute('aria-hidden', 'true');
    span.style.setProperty('--i', i);
    span.textContent = word;
    return i ? [' ', span] : [span];
  }));
}

// Reveal on scroll.
const revealer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('in'); revealer.unobserve(entry.target); }
}, { rootMargin: '0px 0px -8% 0px' });
$$('[data-reveal]').forEach(el => revealer.observe(el));

// Nav gains a border once the page scrolls.
const nav = $('[data-nav]');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Numbers count up once visible.
const counter = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    counter.unobserve(entry.target);
    const target = Number(entry.target.dataset.count);
    if (reduce || target < 10) continue;
    const start = performance.now(), duration = 1400;
    const tick = now => {
      const p = Math.min(1, (now - start) / duration), eased = 1 - (1 - p) ** 4;
      entry.target.textContent = Math.round(target * eased).toLocaleString('en-US');
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}, { threshold: 0.6 });
$$('[data-count]').forEach(el => counter.observe(el));

// Terminal lines print in order.
const terminal = $('[data-terminal]');
if (terminal) {
  const lines = $$('li', terminal);
  if (reduce) lines.forEach(li => li.classList.add('on'));
  else new IntersectionObserver(([entry], observer) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    lines.forEach((li, i) => setTimeout(() => li.classList.add('on'), 250 + i * 420));
  }, { threshold: 0.4 }).observe(terminal);
}

// Story: the step nearest the middle of the viewport drives the sticky visual.
const steps = $$('[data-step]'), panels = $$('[data-panel]');
const activate = index => {
  steps.forEach(step => step.classList.toggle('active', Number(step.dataset.step) === index));
  panels.forEach(panel => panel.classList.toggle('active', Number(panel.dataset.panel) === index));
};
activate(0);
const storyObserver = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) activate(Number(entry.target.dataset.step));
}, { rootMargin: '-45% 0px -45% 0px' });
steps.forEach(step => { storyObserver.observe(step); step.addEventListener('click', () => activate(Number(step.dataset.step))); });

// Install tabs with arrow-key navigation.
const tabs = $$('[role="tab"]');
const select = tab => {
  tabs.forEach(t => {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $('#' + t.getAttribute('aria-controls')).hidden = !on;
  });
};
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => select(tab));
  tab.addEventListener('keydown', event => {
    const move = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i }[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const next = tabs[(i + move + tabs.length) % tabs.length];
    select(next);
    next.focus();
  });
});

// Copy buttons.
async function copyText(button, text) {
  const label = button.getAttribute('aria-label');
  try { await navigator.clipboard.writeText(text); } catch { window.prompt('Copy this:', text); return; }
  button.classList.add('copied');
  if (label) button.setAttribute('aria-label', 'Copied');
  else { button.dataset.label = button.textContent; button.textContent = 'Copied'; }
  setTimeout(() => {
    button.classList.remove('copied');
    if (label) button.setAttribute('aria-label', label); else button.textContent = button.dataset.label;
  }, 1500);
}
$$('[data-copy-text]').forEach(b => b.addEventListener('click', () => copyText(b, b.dataset.copyText)));
$$('[data-copy-from]').forEach(b => b.addEventListener('click', () => copyText(b, $('#' + b.dataset.copyFrom + ' code').textContent)));

// Mount a heavy section shortly before it scrolls into view.
function whenNear(element, mount) {
  if (!element) return;
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    mount().catch(error => { element.dataset.failed = 'true'; console.error(error); });
  }, { rootMargin: '300px 0px' });
  observer.observe(element);
}

data.then(({ netlists, orderguard, neon }) => {
  // Story step 2: the real truth table of #1 and #11.
  const keyA = orderguard.baseline.address + ':' + orderguard.baseline.id, keyB = orderguard.candidate.address + ':' + orderguard.candidate.id;
  const a = decode(netlists[keyA].netlist, 2, 1), b = decode(netlists[keyB].netlist, 2, 1);
  $('[data-truth] tbody').replaceChildren(...[0, 1, 2, 3].map(value => {
    const bits = bitsOf(value, 2), oa = pack(outputsOf(a, bits)), ob = pack(outputsOf(b, bits));
    const row = document.createElement('tr');
    if (oa !== ob) row.className = 'diff';
    row.style.setProperty('--i', value);
    for (const text of [pack(bits), oa, ob]) { const td = document.createElement('td'); td.textContent = text; row.append(td); }
    return row;
  }));
  whenNear($('[data-stage]'), async () => (await import('./scene.mjs')).mountScene($('[data-stage]'), { netlists, report: orderguard }));
  whenNear($('[data-space]'), async () => (await import('./inputspace.mjs')).mountInputSpace($('[data-space]'), { netlists, report: neon }));
});

// Drag a saved report onto the workbench.
const zone = $('[data-dropzone]');
if (zone) {
  const input = $('#open-report');
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add('dragging'); });
  for (const type of ['dragleave', 'drop']) zone.addEventListener(type, () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', event => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });
}
