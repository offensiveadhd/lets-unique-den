/**
 * pulse — app.js
 *
 * A full-screen mood dial. The human drags an SVG ring (stroke-dasharray) to
 * set a value 0–100 and picks a mode chip; the companion reacts via LIP.
 * Speaks LIP through /sdk/lets-client.js and mounts the shell
 * (companion, chat, components) through /sdk/lets-shell.js.
 * Plain ES module; no build step; no network beyond the loopback LIP host.
 */
import { Lets } from '/sdk/lets-client.js';
import { Shell } from '/sdk/lets-shell.js';

// ---- state -----------------------------------------------------------------
let value = 50;                 // 0–100, the dial
let mode = 'focused';           // 'calm' | 'focused' | 'wild'

const R = 104;                  // ring radius (matches the SVG)
const C = 2 * Math.PI * R;      // ring circumference
const CENTER = 130;

// ---- LIP + shell -----------------------------------------------------------
const lets = Lets.connect({ unique: 'pulse', version: '0.1.0', caps: ['entity', 'chat', 'components'] });
const shell = Shell.mount(lets, {
  root: document.body,
  context: () => ({ value, mode }),
  quickSuggestions: (ctx) => [{ id: 'explain', label: 'What does this value mean?' }],
});

// ---- ring rendering --------------------------------------------------------
const svg = document.getElementById('dial');
const arc = document.getElementById('arc');
const knob = document.getElementById('knob');
const valueText = document.getElementById('valueText');
const chips = Array.from(document.querySelectorAll('.chip'));
const modeText = { calm: 'calm', focused: 'focused', wild: 'wild' };

arc.style.strokeDasharray = C;

function render() {
  const frac = Math.min(100, Math.max(0, value)) / 100;
  arc.style.strokeDashoffset = C * (1 - frac);
  const a = frac * 2 * Math.PI - Math.PI / 2;   // start at 12 o'clock
  knob.setAttribute('cx', (CENTER + R * Math.cos(a)).toFixed(2));
  knob.setAttribute('cy', (CENTER + R * Math.sin(a)).toFixed(2));
  valueText.textContent = String(Math.round(value));
  svg.setAttribute('aria-valuenow', String(Math.round(value)));
}

/** Animate the dial to `to` over `ms` (ease-out cubic), then render. */
let animTimer = null;
function animateTo(to, ms = 300) {
  const from = value;
  const t0 = performance.now();
  clearInterval(animTimer);
  animTimer = setInterval(() => {
    const t = Math.min(1, (performance.now() - t0) / ms);
    value = from + (to - from) * (1 - Math.pow(1 - t, 3));
    render();
    if (t >= 1) clearInterval(animTimer);
  }, 16);
}

// ---- pointer drag ----------------------------------------------------------
function angleFromEvent(e) {
  const r = svg.getBoundingClientRect();
  const scale = 260 / r.width;
  const x = (e.clientX - r.left) * scale - CENTER;
  const y = (e.clientY - r.top) * scale - CENTER;
  let a = Math.atan2(y, x) + Math.PI / 2;   // 0 at 12 o'clock, clockwise
  if (a < 0) a += 2 * Math.PI;
  return a;
}

let dragging = false;

svg.addEventListener('pointerdown', (e) => {
  dragging = true;
  svg.setPointerCapture(e.pointerId);
  applyDrag(e);
});
svg.addEventListener('pointermove', (e) => { if (dragging) applyDrag(e); });
svg.addEventListener('pointerup', () => { dragging = false; });
svg.addEventListener('pointercancel', () => { dragging = false; });
svg.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setValue(value - 5, true); }
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setValue(value + 5, true); }
});

function applyDrag(e) {
  const a = angleFromEvent(e);
  setValue(Math.round((a / (2 * Math.PI)) * 100), false);
}

// ---- value changes (debounced 200 ms) ---------------------------------------
let emitTimer = null;
function setValue(v, animate) {
  const clamped = Math.min(100, Math.max(0, v));
  if (clamped === value) return;
  if (animate) animateTo(clamped, 300);
  else { value = clamped; render(); }
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => lets.emit('pulse.value', { value: Math.round(value) }), 200);
}

// ---- mode chips -------------------------------------------------------------
for (const chip of chips) {
  chip.addEventListener('click', () => setMode(chip.dataset.mode));
}
function setMode(m) {
  if (!modeText[m] || m === mode) return;
  mode = m;
  for (const c of chips) c.classList.toggle('active', c.dataset.mode === mode);
  lets.emit('pulse.mode', { mode });
}

// ---- commands from Claude ----------------------------------------------------
lets.on('pulse.set', (data) => {
  const v = Number(data && data.value);
  if (Number.isFinite(v)) setValue(Math.min(100, Math.max(0, v)), true);
});
lets.on('pulse.glow', (data) => {
  const color = data && data.color ? String(data.color) : 'var(--lets-accent)';
  const ttl = Number(data && data.ttl) || 1200;
  glow(color, ttl);
});

/** Temporarily recolor the ring arc + knob glow, then restore. */
let glowTimer = null;
function glow(color, ttl) {
  svg.style.setProperty('--glow-color', color);
  svg.classList.add('glowing');
  clearTimeout(glowTimer);
  glowTimer = setTimeout(() => svg.classList.remove('glowing'), ttl);
}

// ---- boot ---------------------------------------------------------------------
render();
