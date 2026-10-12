/**
 * den.js — Doto's home (the `den` unique for lets).
 *
 * Shows what the companion learned about the human (persona, traits, likes,
 * dislikes, nicknames, memory lines, special skills, secret moves, interaction
 * profile) and lets them edit or forget any of it by pointing. Nothing is
 * stored here: the truth is on the host (`GET /lip/entity`). Every edit is
 * optimistic: the row updates at once, is marked pending, and a `den.*` event
 * asks Claude to apply it with the `entity` tool; Claude then sends
 * `den.refresh` (or `den.load`) and the pending mark clears. Contract:
 * CONTRACT.md. Everything non-den (companion, chat, toasts) is the shell's job
 * (/sdk/lets-shell.js); this file only plugs into it.
 *
 *   1. constants & helpers        6. edits, pending marks, undo
 *   2. boot                       7. outgoing events (ask, send)
 *   3. model (normalise, merge)   8. incoming commands
 *   4. data in (fetch, refresh)   9. companion hooks
 *   5. rendering                 10. chrome, keyboard, start-up
 */

import { Lets } from '/sdk/lets-client.js';

// ───────────────────────────── 1. constants & helpers ─────────────────────────────

const VERSION = '0.1.0';
const CAPS = ['entity', 'chat', 'components'];
const SECTIONS = ['persona', 'traits', 'likes', 'dislikes', 'nicknames', 'memory', 'skills', 'secrets', 'profile'];
const FORGETTABLE = new Set(['likes', 'dislikes', 'nicknames', 'memory', 'skills']);
/** [trait, low end, high end] — the two-word meaning of each slider. */
const TRAITS = [
  ['speed', 'calm', 'snappy'],
  ['distance', 'close', 'far'],
  ['chatty', 'quiet', 'talks'],
  ['playful', 'still', 'bouncy'],
  ['formality', 'casual', 'formal'],
  ['curiosity', 'assumes', 'asks'],
];
const TRAIT_KEYS = TRAITS.map((t) => t[0]);
const SWATCHES = [['#a66bff', 'violet'], ['#ff6bd6', 'magenta'], ['#6bf0ff', 'cyan'], ['#5ef2a6', 'mint'], ['#ffd166', 'gold'], ['#ff6b8b', 'coral']];
const KINDS = ['note', 'preference', 'habit', 'request', 'style', 'secret', 'skill'];
const SECRETS_FALLBACK = ['spin', 'dance', 'disco', 'dizzy', 'nightcap', 'boop', 'wheee'];
const DEFAULTS = {
  name: 'Doto', tagline: 'a dot that does', color: '#a66bff',
  traits: { speed: 0.6, distance: 0.45, chatty: 0.4, playful: 0.7, formality: 0.15, curiosity: 0.6 },
};
const NAME_MAX = 24;
const TAGLINE_MAX = 120;
const CHIP_MAX = 60;
const NICK_KEY_MAX = 60;
const NICK_VALUE_MAX = 120;
const MEM_MAX = 60;
const UNDO_MAX = 20;
const AWAY_EVERY = 30000;
const TRAIT_DEBOUNCE = 250;
const HL_TTL = 4000;
const PREFS_KEY = 'lets.den';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const numOr = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(+v) ? null : +v);
const strOr = (v) => (typeof v === 'string' ? v : v == null ? null : String(v));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const preview = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sameText = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
const hasText = (list, t) => list.some((x) => sameText(x, t));
const validColor = (c) => typeof c === 'string' && c.length < 64 && CSS.supports('color', c);
const isEditable = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
  || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset|file|color|image)$/i.test(el.type)));
const fmt2 = (v) => (v == null ? '—' : v.toFixed(2));

/** Distinct, trimmed, non-empty strings. */
function strList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string' && typeof x !== 'number') continue;
    const t = String(x).trim();
    if (t && !hasText(out, t)) out.push(t);
  }
  return out;
}

/** Creates an element. attrs: class, text, style (object), on<event> functions; anything else is an attribute. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && isObj(v)) for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false && kid !== '') el.append(kid);
  return el;
}

/** Trailing debounce with `.flush()`. */
function debounce(fn, ms) {
  let t = 0;
  const d = () => { clearTimeout(t); t = setTimeout(() => { t = 0; fn(); }, ms); };
  d.flush = () => { if (t) { clearTimeout(t); t = 0; fn(); } };
  return d;
}

/** "3 d ago" for an epoch-ms timestamp; "—" when unknown. */
function rel(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)} d ago`;
  if (s < 86400 * 365) return `${Math.round(s / (86400 * 30))} mo ago`;
  return `${(s / (86400 * 365)).toFixed(1)} y ago`;
}
const isoMs = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };
const fullTime = (ms) => (ms == null ? '' : new Date(ms).toLocaleString());

// Static icons (no user content ever goes through innerHTML).
const ICON = {
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.5v9h-3v-9z"/><path d="M7.5 10.5 11.6 3.6c1.3 0 2.2 1.2 1.9 2.5l-.7 3.2h5.4c1.3 0 2.2 1.2 1.9 2.4l-1.6 6.4c-.2.9-1 1.4-1.9 1.4H7.5"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(180 12 12)"><path d="M7.5 10.5v9h-3v-9z"/><path d="M7.5 10.5 11.6 3.6c1.3 0 2.2 1.2 1.9 2.5l-.7 3.2h5.4c1.3 0 2.2 1.2 1.9 2.4l-1.6 6.4c-.2.9-1 1.4-1.9 1.4H7.5"/></g></svg>',
};

// ───────────────────────────── 2. boot ─────────────────────────────

// The shell is loaded before connecting so its command handlers exist before
// the first SSE message arrives. Without it the den still works (no companion).
let ShellApi = null;
try {
  const mod = await import('/sdk/lets-shell.js');
  ShellApi = mod.Shell || mod.default || null;
} catch (err) {
  console.warn('[den] /sdk/lets-shell.js unavailable — running without the shell:', err?.message || err);
}

const lets = Lets.connect({ unique: 'den', version: VERSION, caps: CAPS });
const bootAt = performance.now();

const app = $('app');
const home = $('home');
const topbar = $('topbar');
const toolbar = $('toolbar');
const statusDot = $('status-dot');
const btnSend = $('btn-send');
const btnAsk = $('btn-ask');
const btnUndo = $('btn-undo');
const btnHelp = $('btn-help');
const askForm = $('ask');
const askInput = $('ask-input');
const askAboutRow = $('ask-about-row');
const askAboutEl = $('ask-about');
const helpEl = $('help');
const pName = $('p-name');
const pTagline = $('p-tagline');
const pMeta = $('p-meta');
const pOrb = $('p-orb');
const swatchesEl = $('swatches');
const btnReset = $('btn-reset');
const resetConfirm = $('reset-confirm');
const traitsEl = $('traits');
const filtersEl = $('mem-filters');

// ───────────────────────────── 3. model ─────────────────────────────

/**
 * @typedef {{name:string|null, tagline:string|null, born:string|null, color:string|null, mood:string|null,
 *   sessions:number|null, traits:Record<string, number|null>, likes:string[], dislikes:string[],
 *   nicknames:Record<string, string>}} Persona
 * @typedef {{pace:number|null, clickRate:number|null, dwell:number|null, idleMs:number|null,
 *   regions:Record<string, number>|null, sessionsSeen:number|null, summons:number|null, picks:number|null,
 *   dismisses:number|null, lastSeen:number|null, secrets:string[]|null}} Profile
 * @typedef {{name:string, title:string, triggers:string[], confidence:number|null, uses:number|null,
 *   unique:string|null, learned:string|null, updated:string|null, body:string}} Skill
 * @typedef {{ts:number, kind:string, text:string, weight:number|null}} MemLine
 * @typedef {{persona:Persona, profile:Profile, skills:Skill[], memory:MemLine[], secretsAll:string[],
 *   defaults:{name:string, tagline:string, color:string, traits:Record<string, number>}, at:number|null}} Entity
 * @typedef {{type:string, data:object, meta:object, at:number}} Edit   one emitted event still waiting for Claude
 */

/**
 * Turns any payload (the §1.1 shape, possibly partial or with nulls) into a
 * complete Entity. Never throws; unknown or broken fields become empty values.
 * @param {any} raw
 * @returns {Entity}
 */
function normalize(raw) {
  const r = isObj(raw) ? raw : {};
  const p = isObj(r.persona) ? r.persona : {};
  const f = isObj(r.profile) ? r.profile : {};
  const dz = isObj(r.defaults) ? r.defaults : {};
  const pt = isObj(p.traits) ? p.traits : {};
  const dzt = isObj(dz.traits) ? dz.traits : {};
  const traits = {};
  const defTraits = {};
  for (const k of TRAIT_KEYS) {
    const v = numOr(pt[k]);
    traits[k] = v == null ? null : clamp(v, 0, 1);
    const d = numOr(dzt[k]);
    defTraits[k] = d == null ? DEFAULTS.traits[k] : clamp(d, 0, 1);
  }
  const nicknames = {};
  if (isObj(p.nicknames)) {
    for (const [k, v] of Object.entries(p.nicknames)) {
      const key = String(k).trim();
      if (key && v != null) nicknames[key] = String(v);
    }
  }
  const regions = isObj(f.regions)
    ? Object.fromEntries(['tl', 'tr', 'bl', 'br', 'c'].map((k) => [k, Math.max(0, numOr(f.regions[k]) ?? 0)]))
    : null;
  const skills = (Array.isArray(r.skills) ? r.skills : []).filter((s) => isObj(s) && s.name != null && String(s.name).trim())
    .map((s) => ({
      name: String(s.name).trim(),
      title: strOr(s.title)?.trim() || String(s.name).trim(),
      triggers: strList(s.triggers),
      confidence: numOr(s.confidence) == null ? null : clamp(+s.confidence, 0, 1),
      uses: numOr(s.uses),
      unique: strOr(s.unique),
      learned: strOr(s.learned),
      updated: strOr(s.updated),
      body: strOr(s.body) || '',
    }));
  const memory = (Array.isArray(r.memory) ? r.memory : []).filter((m) => isObj(m) && numOr(m.ts) != null)
    .map((m) => ({ ts: +m.ts, kind: (strOr(m.kind) || 'note').toLowerCase().slice(0, 24), text: strOr(m.text) || '', weight: numOr(m.weight) }))
    .slice(-MEM_MAX);
  const secretsAll = strList(r.secretsAll);
  return {
    persona: {
      name: strOr(p.name)?.trim() || null,
      tagline: strOr(p.tagline),
      born: strOr(p.born),
      color: validColor(p.color) ? p.color : null,
      mood: strOr(p.mood),
      sessions: numOr(p.sessions),
      traits,
      likes: strList(p.likes),
      dislikes: strList(p.dislikes),
      nicknames,
    },
    profile: {
      pace: numOr(f.pace), clickRate: numOr(f.clickRate), dwell: numOr(f.dwell), idleMs: numOr(f.idleMs), regions,
      sessionsSeen: numOr(f.sessionsSeen), summons: numOr(f.summons), picks: numOr(f.picks), dismisses: numOr(f.dismisses),
      lastSeen: numOr(f.lastSeen), secrets: Array.isArray(f.secrets) ? strList(f.secrets) : null,
    },
    skills,
    memory,
    secretsAll: secretsAll.length ? secretsAll : [...SECRETS_FALLBACK],
    defaults: {
      name: strOr(dz.name)?.trim() || DEFAULTS.name,
      tagline: strOr(dz.tagline) ?? DEFAULTS.tagline,
      color: validColor(dz.color) ? dz.color : DEFAULTS.color,
      traits: defTraits,
    },
    at: numOr(r.at),
  };
}

/**
 * `den.load {merge:true}`: patch only the sections present. Persona and
 * profile merge field by field (traits key by key); lists replace.
 * @param {Entity} cur
 * @param {object} patch
 * @returns {Entity}
 */
function mergeEntity(cur, patch) {
  const raw = { ...cur };
  if (isObj(patch.persona)) {
    raw.persona = { ...cur.persona, ...patch.persona, traits: isObj(patch.persona.traits) ? { ...cur.persona.traits, ...patch.persona.traits } : cur.persona.traits };
  }
  if (isObj(patch.profile)) raw.profile = { ...cur.profile, ...patch.profile };
  for (const k of ['skills', 'memory', 'secretsAll', 'defaults', 'at']) if (k in patch) raw[k] = patch[k];
  return normalize(raw);
}

/**
 * Secret moves found, in order of discovery: `profile.secrets` (lets 0.6.0),
 * plus any older find that only a "secret" memory line records (profiles from
 * before 0.6.0 start with an empty list). Both are on disk; nothing is guessed.
 */
function foundSecrets(e) {
  const all = e.secretsAll;
  const fromMemory = e.memory.filter((m) => m.kind === 'secret')
    .map((m) => /secret move "([^"]+)"/i.exec(m.text)?.[1] || '').filter(Boolean);
  const out = [];
  for (const n of [...(e.profile.secrets || []), ...fromMemory]) if (all.includes(n) && !out.includes(n)) out.push(n);
  return out;
}

/** @type {Entity} the host's truth, as last fetched or loaded */
let D = normalize({});
/** @type {Entity} what is on screen: D with the pending edits applied */
let V = D;
/** @type {Map<string, string>} row key → pending op ('add' | 'forget' | 'set' | 'up' | 'down') */
let marks = new Map();
/** @type {Edit[]} */
let edits = [];
/** @type {{edit:Edit, inverse:{type:string, data:object}|null, noUndo?:string}[]} */
const undoStack = [];
let state = 'loading'; // 'loading' | 'ready' | 'missing' (engine < 0.6.0) | 'offline'
let userActed = false;

// ───────────────────────────── 4. data in ─────────────────────────────

let needWarned = false;
let retryT = 0;
let retryMs = 20000;
let fetching = null;

/**
 * Fetches `GET /lip/entity` into D. On a 404 (engine < 0.6.0) it falls back to
 * `/lip/persona` for the name and traits, toasts once and retries quietly.
 * @param {{quiet?:boolean}} [o]
 * @returns {Promise<boolean>} true when the full payload arrived
 */
function fetchEntity({ quiet = false } = {}) {
  if (fetching) return fetching;
  fetching = (async () => {
    try {
      const data = await lets.get('/lip/entity');
      setTruth(normalize(data));
      state = 'ready';
      clearTimeout(retryT);
      retryMs = 20000;
      return true;
    } catch (err) {
      const code = Number(/: (\d{3})$/.exec(String(err?.message || ''))?.[1] || 0);
      if (code === 404) {
        if (!needWarned) { needWarned = true; toast('This den needs lets 0.6.0.', 'warn', 6000); }
        if (state !== 'ready') {
          state = 'missing';
          try { setTruth(normalize({ persona: await lets.get('/lip/persona') })); } catch { /* nothing to show */ }
        }
        clearTimeout(retryT);
        retryT = setTimeout(() => { fetchEntity({ quiet: true }).then((ok) => { if (ok) { pruneEdits(); render(); } }); }, retryMs);
        retryMs = Math.min(retryMs * 1.5, 120000);
      } else {
        if (state === 'loading') state = 'offline';
        if (!quiet) toast(code === 401 ? 'This window has no key. Open den from Claude Code.' : "Can't reach the host. Showing what I had.", 'warn', 5000);
      }
      return false;
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

let pendingReaction = '';

/** Replaces the truth; notes a sparkle when the last secret just got found. */
function setTruth(next) {
  const total = next.secretsAll.length;
  const before = state === 'ready' ? foundSecrets(D).length : total;
  D = next;
  if (before < total && foundSecrets(D).length >= total) pendingReaction = 'sparkle';
  applyPersonaToShell(D.persona);
}

/**
 * Re-fetch and render. `clear` drops every pending mark (Claude's den.refresh);
 * otherwise only the edits the host now reflects are dropped (toolbar Refresh).
 * @param {{clear?:boolean, source?:'claude'|'human'}} [o]
 */
async function refresh({ clear = false, source = 'human' } = {}) {
  const had = edits.length;
  const ok = await fetchEntity({ quiet: source === 'claude' });
  if (clear) edits = [];
  else pruneEdits();
  render();
  if (source === 'claude') {
    if (had && !edits.length) pendingReaction ||= 'nod';
    if (!ok) throw new Error('could not fetch /lip/entity');
  } else if (ok) {
    toast(`Fresh. ${countLine(V)}.`, 'ok', 2600);
  }
  playPending();
}

/** "5 likes, 3 dislikes, 8 memory lines, 1 skill" — Doto counts things. */
function countLine(e) {
  const parts = [plural(e.persona.likes.length, 'like'), plural(e.persona.dislikes.length, 'dislike'), plural(e.memory.length, 'memory line'), plural(e.skills.length, 'skill')];
  const n = Object.keys(e.persona.nicknames).length;
  if (n) parts.splice(2, 0, plural(n, 'nickname'));
  return parts.join(', ');
}

// ───────────────────────────── 5. rendering ─────────────────────────────

/** @type {Record<string, Set<string>>} row keys rendered last time, per section (for the enter animation) */
const known = {};
const HL = new Map(); // key ('likes' or 'likes:text') → {color, timer}
let openSkills = new Set();
let confirmSkill = null;
let editingNick = null;
let prefs = loadPrefs();

/** Applies the pending edits on top of D. */
function computeView() {
  const v = structuredClone(D);
  const m = new Map();
  for (const e of edits) applyEdit(v, m, e);
  V = v;
  marks = m;
}

/**
 * One pending edit on the view: adds show at once, forgets stay visible
 * (struck through) until Claude confirms, sets show the new value.
 */
function applyEdit(v, m, e) {
  const d = e.data;
  switch (e.type) {
    case 'den.like.add': case 'den.dislike.add': {
      const sec = e.type === 'den.like.add' ? 'likes' : 'dislikes';
      const list = v.persona[sec];
      const hit = list.find((x) => sameText(x, d.text));
      if (!hit) list.push(d.text);
      m.set(`${sec}:${hit || d.text}`, 'add');
      break;
    }
    case 'den.like.forget': case 'den.dislike.forget': {
      const sec = e.type === 'den.like.forget' ? 'likes' : 'dislikes';
      const hit = v.persona[sec].find((x) => sameText(x, d.text));
      if (hit) m.set(`${sec}:${hit}`, 'forget');
      break;
    }
    case 'den.nickname.set':
      m.set(`nicknames:${d.key}`, d.key in v.persona.nicknames ? 'set' : 'add');
      v.persona.nicknames[d.key] = d.value;
      break;
    case 'den.nickname.forget':
      if (d.key in v.persona.nicknames) m.set(`nicknames:${d.key}`, 'forget');
      break;
    case 'den.memory.forget':
      m.set(`memory:${d.ts}`, 'forget');
      break;
    case 'den.skill.forget':
      m.set(`skills:${d.name}`, 'forget');
      break;
    case 'den.skill.rate':
      m.set(`skills:${d.name}`, d.ok ? 'up' : 'down');
      break;
    case 'den.persona.set':
      for (const f of ['name', 'tagline', 'color']) if (f in d) { v.persona[f] = d[f]; m.set(`persona:${f}`, 'set'); }
      if (isObj(d.traits)) for (const [k, val] of Object.entries(d.traits)) { v.persona.traits[k] = val; m.set(`traits:${k}`, 'set'); }
      break;
    case 'den.persona.reset':
      v.persona.name = v.defaults.name; v.persona.tagline = v.defaults.tagline; v.persona.color = v.defaults.color;
      for (const f of ['name', 'tagline', 'color']) m.set(`persona:${f}`, 'set');
      for (const k of TRAIT_KEYS) { v.persona.traits[k] = v.defaults.traits[k]; m.set(`traits:${k}`, 'set'); }
      break;
    default: break;
  }
}

/** Whether the host truth D already reflects an edit (then its pending mark can go). */
function satisfied(e) {
  const d = e.data;
  const p = D.persona;
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.006;
  switch (e.type) {
    case 'den.like.add': return hasText(p.likes, d.text);
    case 'den.dislike.add': return hasText(p.dislikes, d.text);
    case 'den.like.forget': return !hasText(p.likes, d.text);
    case 'den.dislike.forget': return !hasText(p.dislikes, d.text);
    case 'den.nickname.set': return p.nicknames[d.key] === d.value;
    case 'den.nickname.forget': return !(d.key in p.nicknames);
    case 'den.memory.forget': return !D.memory.some((x) => x.ts === d.ts);
    case 'den.skill.forget': return !D.skills.some((x) => x.name === d.name);
    case 'den.skill.rate': {
      const s = D.skills.find((x) => x.name === d.name);
      return !s || s.confidence !== e.meta.confidence || s.uses !== e.meta.uses;
    }
    case 'den.persona.set':
      return ['name', 'tagline', 'color'].every((f) => !(f in d) || p[f] === d[f])
        && (!isObj(d.traits) || Object.entries(d.traits).every(([k, val]) => near(p.traits[k], val)));
    case 'den.persona.reset':
      return p.name === D.defaults.name && p.tagline === D.defaults.tagline && p.color === D.defaults.color
        && TRAIT_KEYS.every((k) => near(p.traits[k], D.defaults.traits[k]));
    default: return true;
  }
}

/** Drops the edits the host already reflects. @returns {number} how many cleared */
function pruneEdits() {
  const n = edits.length;
  edits = edits.filter((e) => !satisfied(e));
  return n - edits.length;
}

/** Marks a row pending (dimmed, pulsing dot, "waiting for Claude") or clears it. */
function pend(el, mark) {
  if (!el) return;
  if (mark) {
    el.dataset.pending = 'true';
    el.dataset.op = mark;
    el.title = mark === 'forget' ? 'waiting for Claude to forget it · Ctrl+Z keeps it' : 'waiting for Claude';
  } else if (el.dataset.pending) {
    delete el.dataset.pending;
    delete el.dataset.op;
    el.removeAttribute('title');
  }
}

/** Renders everything from D + edits. Keeps keyboard focus on the same control. */
function render() {
  const fk = focusKey();
  computeView();
  app.dataset.state = state;
  renderPersona();
  renderTraits();
  renderChips('likes');
  renderChips('dislikes');
  if (!editingNick) renderNicks();
  renderMemory();
  renderSkills();
  renderSecrets();
  renderProfile();
  renderCounts();
  paintHighlights();
  restoreFocus(fk);
  syncUndo();
}

function focusKey() {
  const a = document.activeElement;
  return a instanceof HTMLElement && home.contains(a) ? a.dataset.fk || null : null;
}

function restoreFocus(fk) {
  if (!fk) return;
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  const el = home.querySelector(`[data-fk="${CSS.escape(fk)}"]`)
    || home.querySelector(`#h-${CSS.escape(fk.split(':')[0])} button`);
  el?.focus({ preventScroll: true });
}

function renderPersona() {
  const p = V.persona;
  const name = p.name || '—';
  pName.textContent = name;
  pName.setAttribute('aria-label', `Name: ${name}. Press Enter to rename.`);
  pend(pName.parentElement, marks.get('persona:name'));
  const tag = (p.tagline || '').trim();
  pTagline.textContent = tag || 'no tagline yet';
  pTagline.classList.toggle('is-empty', !tag);
  pTagline.setAttribute('aria-label', `Tagline: ${tag || 'none'}. Press Enter to edit.`);
  pend(pTagline.parentElement, marks.get('persona:tagline'));
  const born = isoMs(p.born);
  const bits = [];
  if (born != null) bits.push(`born ${new Date(born).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`);
  if (p.sessions != null) bits.push(plural(Math.round(p.sessions), 'session'));
  if (p.mood) bits.push(`mood ${p.mood}`);
  pMeta.textContent = bits.length ? bits.join(' · ') : '—';
  pMeta.title = born != null ? fullTime(born) : '';
  const color = p.color || V.defaults.color;
  pOrb.style.setProperty('--doto', color);
  for (const b of swatchesEl.querySelectorAll('button')) {
    const c = b.dataset.color === 'default' ? V.defaults.color : b.dataset.color;
    b.setAttribute('aria-pressed', String(!!p.color && sameText(c, p.color)));
    if (b.dataset.color === 'default') b.style.setProperty('--sw', V.defaults.color);
  }
  pend(swatchesEl.parentElement, marks.get('persona:color'));
  const resetMark = edits.some((e) => e.type === 'den.persona.reset');
  btnReset.disabled = resetMark;
}

/** Trait rows are built once (so a drag is never interrupted) and updated in place. */
const traitEls = new Map();
const settled = { traits: {}, prev: {} };

function buildTraits() {
  for (const [k, lo, hi] of TRAITS) {
    const id = `tr-${k}`;
    const out = h('output', { class: 'tr-val', for: id, text: '—' });
    const input = h('input', { id, class: 'lets-range', type: 'range', min: '0', max: '1', step: '0.01', 'data-fk': `traits:${k}` });
    const tick = h('span', { class: 'tr-tick', 'aria-hidden': 'true' });
    const row = h('div', { class: 'trait', 'data-row': `traits:${k}` },
      h('div', { class: 'tr-head' }, h('label', { for: id, class: 'tr-name', text: k }), out),
      h('div', { class: 'tr-track' }, input, tick),
      h('div', { class: 'tr-ends', 'aria-hidden': 'true' }, h('span', { text: lo }), h('span', { text: hi })));
    input.addEventListener('pointerdown', () => { input.dataset.dragging = '1'; });
    input.addEventListener('input', () => {
      const val = +input.value;
      out.textContent = fmt2(val);
      input.setAttribute('aria-valuetext', `${fmt2(val)}, ${lo} to ${hi}`);
    });
    input.addEventListener('change', () => {
      delete input.dataset.dragging;
      const val = Math.round(+input.value * 100) / 100;
      if (!(k in settled.prev)) settled.prev[k] = V.persona.traits[k];
      settled.traits[k] = val;
      flushTraitsSoon();
    });
    traitsEl.append(row);
    traitEls.set(k, { row, input, out, tick, lo, hi });
  }
}

function renderTraits() {
  for (const [k, el] of traitEls) {
    const v = V.persona.traits[k];
    const def = V.defaults.traits[k];
    const busy = el.input.dataset.dragging === '1' || k in settled.traits;
    if (!busy) {
      el.input.value = String(v ?? def);
      el.out.textContent = fmt2(v);
      el.input.setAttribute('aria-valuetext', v == null ? `not measured, ${el.lo} to ${el.hi}` : `${fmt2(v)}, ${el.lo} to ${el.hi}`);
    }
    el.tick.style.setProperty('--at', String(def));
    el.tick.title = `default ${fmt2(def)}`;
    pend(el.row, marks.get(`traits:${k}`));
  }
}

const flushTraitsSoon = debounce(flushTraits, TRAIT_DEBOUNCE);

/** One `den.persona.set {traits}` for every slider that settled in the last 250 ms. */
function flushTraits() {
  const traits = {};
  const prev = {};
  for (const [k, val] of Object.entries(settled.traits)) {
    const before = settled.prev[k];
    if (before != null && Math.abs(before - val) < 0.005) continue;
    traits[k] = val;
    prev[k] = before ?? V.defaults.traits[k];
  }
  settled.traits = {};
  settled.prev = {};
  if (!Object.keys(traits).length) { render(); return; }
  commit('den.persona.set', { traits }, { inverse: { type: 'den.persona.set', data: { traits: prev } } });
  applyPersonaToShell({ traits });
}

/** Builds an × button; Delete/Backspace on it does the same (global keydown). */
function xBtn(label, fk, onForget, waiting) {
  return h('button', {
    type: 'button', class: 'x', 'data-x': '', 'data-fk': fk,
    'aria-label': waiting ? `Waiting for Claude: ${label}` : label,
    'aria-disabled': waiting ? 'true' : null,
    onclick: () => { if (!waiting) onForget(); },
  }, '×');
}

/** Rows that were not there last render fade in (300 ms); the first render does not animate. */
function entering(sec, key) {
  return known[sec] && !known[sec].has(key);
}

function renderChips(sec) {
  const list = V.persona[sec];
  const ul = $(`list-${sec}`);
  const next = new Set();
  const items = list.map((text) => {
    const key = `${sec}:${text}`;
    next.add(key);
    const mark = marks.get(key);
    const li = h('li', { class: `chip${entering(sec, key) ? ' enter' : ''}`, 'data-row': key },
      h('span', { class: 'chip-text', text }),
      xBtn(`Forget “${preview(text, 60)}”`, `${key}:x`, () => forgetChip(sec, text), mark === 'forget'));
    pend(li, mark);
    return li;
  });
  ul.replaceChildren(...items);
  ul.hidden = !list.length;
  $(`empty-${sec}`).hidden = !!list.length || state === 'loading';
  if (state !== 'loading') known[sec] = next;
}

function renderNicks() {
  const entries = Object.entries(V.persona.nicknames);
  const ul = $('list-nicknames');
  const next = new Set();
  ul.replaceChildren(...entries.map(([k, val]) => {
    const key = `nicknames:${k}`;
    next.add(key);
    const mark = marks.get(key);
    const valBtn = h('button', {
      type: 'button', class: 'nick-val editable', 'data-fk': `${key}:val`, text: val || '—',
      'aria-label': `“${k}” means “${val}”. Press Enter to edit.`,
      onclick: () => editNick(k, valBtn),
    });
    const li = h('li', { class: `nick${entering('nicknames', key) ? ' enter' : ''}`, 'data-row': key },
      h('span', { class: 'nick-key', text: k }),
      h('span', { class: 'nick-arrow', 'aria-hidden': 'true', text: '→' }),
      valBtn,
      xBtn(`Forget the nickname “${preview(k, 40)}”`, `${key}:x`, () => forgetNick(k), mark === 'forget'));
    pend(li, mark);
    return li;
  }));
  ul.hidden = !entries.length;
  $('empty-nicknames').hidden = !!entries.length || state === 'loading';
  if (state !== 'loading') known.nicknames = next;
}

function renderMemory() {
  const lines = [...V.memory].reverse();
  const present = KINDS.filter((k) => lines.some((m) => m.kind === k));
  for (const m of lines) if (!present.includes(m.kind)) present.push(m.kind);
  const filter = prefs.filter !== 'all' && present.includes(prefs.filter) ? prefs.filter : 'all';
  filtersEl.replaceChildren(...['all', ...present].map((k) => h('button', {
    type: 'button', class: `filter${k === 'all' ? '' : ` k-${k}`}`, 'data-fk': `memory:filter:${k}`,
    'aria-pressed': String(filter === k),
    text: k === 'all' ? `all ${lines.length}` : `${k} ${lines.filter((m) => m.kind === k).length}`,
    onclick: () => { prefs.filter = k; savePrefs(); render(); },
  })));
  filtersEl.hidden = lines.length < 2 || present.length < 2;
  const shown = filter === 'all' ? lines : lines.filter((m) => m.kind === filter);
  const ol = $('list-memory');
  const next = new Set();
  ol.replaceChildren(...shown.map((m) => {
    const key = `memory:${m.ts}`;
    next.add(key);
    const mark = marks.get(key);
    const li = h('li', { class: `mem-row${entering('memory', key) ? ' enter' : ''}`, 'data-row': key, 'data-kind': m.kind },
      h('div', { class: 'mem-meta' },
        h('span', { class: `badge k-${KINDS.includes(m.kind) ? m.kind : 'other'}`, text: m.kind }),
        h('time', { datetime: new Date(m.ts).toISOString(), title: fullTime(m.ts), 'data-ts': String(m.ts), text: rel(m.ts) })),
      h('p', { class: 'mem-text', text: m.text || '—' }),
      xBtn(`Forget this memory line: ${preview(m.text, 50)}`, `${key}:x`, () => forgetMemory(m), mark === 'forget'));
    pend(li, mark);
    return li;
  }));
  ol.hidden = !shown.length;
  $('empty-memory').hidden = !!lines.length || state === 'loading';
  if (state !== 'loading') known.memory = next;
}

function renderSkills() {
  const box = $('list-skills');
  const next = new Set();
  box.replaceChildren(...V.skills.map((s) => {
    const key = `skills:${s.name}`;
    next.add(key);
    const mark = marks.get(key);
    const conf = s.confidence;
    const learned = isoMs(s.learned);
    const details = h('details', { class: 'skill-body', open: openSkills.has(s.name) },
      h('summary', { 'data-fk': `${key}:sum`, text: 'Playbook' }),
      s.body.trim() ? h('pre', { class: 'lets-pre', text: s.body }) : h('p', { class: 'lets-dim', text: 'No playbook text.' }));
    details.addEventListener('toggle', () => { if (details.open) openSkills.add(s.name); else openSkills.delete(s.name); });
    const up = h('button', { type: 'button', class: 'icon-btn thumb', 'data-fk': `${key}:up`, 'aria-pressed': String(mark === 'up'), 'aria-label': `Good skill: ${s.title}`, title: 'Good skill', onclick: () => rateSkill(s, true) });
    const down = h('button', { type: 'button', class: 'icon-btn thumb', 'data-fk': `${key}:down`, 'aria-pressed': String(mark === 'down'), 'aria-label': `Bad skill: ${s.title}`, title: 'Bad skill', onclick: () => rateSkill(s, false) });
    up.innerHTML = ICON.up;
    down.innerHTML = ICON.down;
    const forgetting = mark === 'forget';
    if (forgetting) { up.disabled = true; down.disabled = true; }
    const actions = confirmSkill === s.name && !forgetting
      ? h('div', { class: 'skill-actions confirm', role: 'group', 'aria-label': `Forget ${s.title}?` },
        h('span', { text: 'Forget it? No undo.' }),
        h('button', { type: 'button', class: 'lets-btn lets-btn-sm lets-btn-primary', 'data-fk': `${key}:yes`, text: 'Forget', onclick: () => forgetSkill(s) }),
        h('button', { type: 'button', class: 'lets-btn lets-btn-sm lets-btn-ghost', 'data-fk': `${key}:no`, text: 'Keep', onclick: () => { confirmSkill = null; render(); focusFk(`${key}:x`); } }))
      : h('div', { class: 'skill-actions' }, up, down,
        xBtn(`Forget the skill “${s.title}”`, `${key}:x`, () => { confirmSkill = s.name; render(); focusFk(`${key}:no`); }, forgetting));
    const card = h('article', { class: `skill${entering('skills', key) ? ' enter' : ''}`, 'data-row': key, 'aria-label': s.title },
      h('div', { class: 'skill-head' },
        h('h3', { class: 'skill-title', text: s.title }),
        h('code', { class: 'skill-name', text: s.name }),
        s.unique ? h('span', { class: 'badge u', title: `learned in ${s.unique}`, text: s.unique }) : null),
      s.triggers.length ? h('ul', { class: 'triggers', 'aria-label': 'Triggers' }, s.triggers.map((t) => h('li', { class: 'trig', text: t }))) : null,
      h('div', { class: 'skill-meta' },
        h('span', { class: 'conf' },
          h('span', { class: 'lets-bar', role: 'meter', 'aria-label': 'Confidence', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': conf == null ? null : String(Math.round(conf * 100)) },
            h('span', { class: 'lets-bar-fill', style: { transform: `scaleX(${conf ?? 0})` } })),
          h('span', { text: conf == null ? '—' : `${Math.round(conf * 100)}%` })),
        h('span', { text: s.uses == null ? '— uses' : plural(Math.round(s.uses), 'use') }),
        learned != null ? h('span', { title: fullTime(learned), text: `learned ${rel(learned)}` }) : null),
      details,
      actions);
    pend(card, mark);
    return card;
  }));
  box.hidden = !V.skills.length;
  $('empty-skills').hidden = !!V.skills.length || state === 'loading';
  if (state !== 'loading') known.skills = next;
}

function renderSecrets() {
  const found = foundSecrets(V);
  const ol = $('list-secrets');
  ol.replaceChildren(...V.secretsAll.map((name, i) => {
    const got = found.includes(name);
    const key = got ? `secrets:${name}` : `secrets:#${i + 1}`;
    return h('li', { class: 'secret', 'data-row': key, 'data-found': String(got), tabindex: '0', 'data-fk': key, 'aria-label': got ? `${name}: found` : 'Not found yet' },
      h('span', { class: 's-dot', 'aria-hidden': 'true', text: got ? '' : '?' }),
      h('span', { class: 's-name', 'aria-hidden': 'true', text: got ? name : '' }));
  }));
}

function renderProfile() {
  const f = V.profile;
  const n0 = (v) => (v == null ? '—' : String(Math.round(v)));
  const tiles = [
    ['pace', n0(f.pace), 'px/s', 'pace'],
    ['clickRate', f.clickRate == null ? '—' : f.clickRate.toFixed(1), '/min', 'clicks'],
    ['dwell', f.dwell == null ? '—' : (f.dwell / 1000).toFixed(1), 's', 'dwell'],
    ['idle', f.idleMs == null ? '—' : String(Math.round(f.idleMs / 1000)), 's', 'idle'],
    ['menu', [f.summons, f.picks, f.dismisses].every((x) => x == null) ? '—' : [f.summons, f.picks, f.dismisses].map(n0).join(' · '), '', 'summons · picks · dismisses'],
    ['sessionsSeen', n0(f.sessionsSeen), '', 'sessions seen'],
    ['lastSeen', rel(f.lastSeen), '', 'last seen'],
  ];
  const els = tiles.map(([id, val, unit, label]) => h('div', {
    class: 'tile', 'data-row': `profile:${id}`, tabindex: '0', 'data-fk': `profile:${id}`, 'aria-label': `${label}: ${val}${unit && val !== '—' ? ` ${unit}` : ''}`,
    title: id === 'lastSeen' ? fullTime(f.lastSeen) : id === 'idle' && f.idleMs != null ? `${(f.idleMs / 60000).toFixed(1)} min` : null,
  },
  h('span', { class: 'tile-val', 'aria-hidden': 'true', 'data-ts': id === 'lastSeen' && f.lastSeen != null ? String(f.lastSeen) : null }, val, unit && val !== '—' ? h('small', { text: ` ${unit}` }) : null),
  h('span', { class: 'tile-label', 'aria-hidden': 'true', text: label })));
  // favourite regions: corners and centre of a 3×3 grid, shaded by fraction
  const r = f.regions;
  const sum = r ? Object.values(r).reduce((a, b) => a + b, 0) : 0;
  const cells = ['tl', '', 'tr', '', 'c', '', 'bl', '', 'br'];
  const names = { tl: 'top left', tr: 'top right', bl: 'bottom left', br: 'bottom right', c: 'centre' };
  const desc = r && sum > 0 ? Object.entries(r).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${names[k]} ${Math.round((v / sum) * 100)}%`).join(', ') : 'nothing measured yet';
  els.push(h('div', { class: 'tile tile-regions', 'data-row': 'profile:regions', tabindex: '0', 'data-fk': 'profile:regions', 'aria-label': `favourite regions: ${desc}` },
    h('span', { class: 'regions', 'aria-hidden': 'true' }, cells.map((k) => {
      const frac = k && r && sum > 0 ? r[k] / sum : 0;
      return h('i', { 'data-cell': k || null, style: k ? { '--f': frac.toFixed(3) } : null, title: k ? `${names[k]} ${Math.round(frac * 100)}%` : null });
    })),
    h('span', { class: 'tile-label', 'aria-hidden': 'true', text: 'regions' })));
  $('tiles').replaceChildren(...els);
}

function renderCounts() {
  const loading = state === 'loading';
  const set = (sec, text) => { $(`count-${sec}`).textContent = loading ? '' : text; };
  set('likes', String(V.persona.likes.length));
  set('dislikes', String(V.persona.dislikes.length));
  set('nicknames', String(Object.keys(V.persona.nicknames).length));
  set('memory', String(V.memory.length));
  set('skills', String(V.skills.length));
  set('secrets', `${foundSecrets(V).length} of ${V.secretsAll.length}`);
  set('persona', '');
  set('profile', '');
  set('traits', '');
}

/** Keeps the relative dates honest without a full re-render. */
function tickTimes() {
  for (const el of home.querySelectorAll('[data-ts]')) {
    const ts = Number(el.dataset.ts);
    if (Number.isFinite(ts)) el.firstChild ? (el.firstChild.textContent = rel(ts)) : (el.textContent = rel(ts));
  }
}

// ───────────────────────────── 6. edits, pending marks, undo ─────────────────────────────

let lastAway = 0;

/**
 * Optimistic edit: record it as pending, emit the event, re-render.
 * @param {string} type den.* event type
 * @param {object} data
 * @param {{inverse?:{type:string, data:object}|null, noUndo?:string, meta?:object}} [o]
 */
function commit(type, data, { inverse = null, noUndo = '', meta = {} } = {}) {
  userActed = true;
  const edit = { type, data, meta, at: Date.now() };
  edits.push(edit);
  undoStack.push({ edit, inverse, noUndo });
  while (undoStack.length > UNDO_MAX) undoStack.shift();
  lets.emit(type, data);
  awayHint('applies');
  render();
}

/** "Doto is away" once per 30 s when Claude is not listening right now. */
function awayHint(verb) {
  if (!hasShell || shell.listening !== false) return false;
  if (Date.now() - lastAway < AWAY_EVERY) return false;
  lastAway = Date.now();
  toast(`${D.persona.name || DEFAULTS.name} is away. Claude ${verb} this with your next message in Claude Code.`, 'info', 5000);
  return true;
}

/** Ctrl+Z: emit the inverse event of the last local edit (Claude treats it as a "no"). */
function undo() {
  const u = undoStack.pop();
  syncUndo();
  if (!u) { toast('Nothing to undo.', 'info', 1800); return; }
  if (!u.inverse) { toast(u.noUndo || "Can't undo that one.", 'warn', 3500); return; }
  userActed = true;
  const i = edits.indexOf(u.edit);
  if (i >= 0) edits.splice(i, 1);                   // still pending: the view falls back to the truth
  else edits.push({ type: u.inverse.type, data: u.inverse.data, meta: {}, at: Date.now() });
  lets.emit(u.inverse.type, u.inverse.data);
  if (u.inverse.type === 'den.persona.set') applyPersonaToShell(u.inverse.data);
  announce('Undone. Claude gets the change.');
  awayHint('applies');
  render();
}

function syncUndo() { btnUndo.disabled = !undoStack.length; }

function forgetChip(sec, text) {
  const one = sec === 'likes' ? 'like' : 'dislike';
  commit(`den.${one}.forget`, { text }, { inverse: { type: `den.${one}.add`, data: { text } } });
  react('wink');
  announce(`Forgot “${text}”. Waiting for Claude.`);
}

function addChip(sec, raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, CHIP_MAX);
  if (!text) return false;
  const one = sec === 'likes' ? 'like' : 'dislike';
  const hit = V.persona[sec].find((x) => sameText(x, text));
  if (hit && marks.get(`${sec}:${hit}`) !== 'forget') {
    toast('Already there.', 'info', 1800);
    highlight(sec, hit, '', 1600);
    return false;
  }
  commit(`den.${one}.add`, { text }, { inverse: { type: `den.${one}.forget`, data: { text } } });
  announce(`Added “${text}”. Waiting for Claude.`);
  return true;
}

function setNick(key, value) {
  const k = String(key || '').replace(/\s+/g, ' ').trim().slice(0, NICK_KEY_MAX);
  const v = String(value || '').replace(/\s+/g, ' ').trim().slice(0, NICK_VALUE_MAX);
  if (!k || !v) { toast('Fill in both sides.', 'info', 2000); return false; }
  const had = Object.hasOwn(V.persona.nicknames, k);
  const prev = had ? V.persona.nicknames[k] : null;
  if (had && prev === v && marks.get(`nicknames:${k}`) !== 'forget') return true;
  commit('den.nickname.set', { key: k, value: v }, {
    inverse: had ? { type: 'den.nickname.set', data: { key: k, value: prev } } : { type: 'den.nickname.forget', data: { key: k } },
  });
  announce(`“${k}” means “${v}”. Waiting for Claude.`);
  return true;
}

function forgetNick(key) {
  const prev = V.persona.nicknames[key] ?? '';
  commit('den.nickname.forget', { key }, { inverse: { type: 'den.nickname.set', data: { key, value: prev } } });
  react('wink');
  announce(`Forgot the nickname “${key}”. Waiting for Claude.`);
}

function forgetMemory(m) {
  commit('den.memory.forget', { ts: m.ts, text: preview(m.text, 80) }, { noUndo: 'No undo for a memory line. Ask Claude to note it again.' });
  react('wink');
  announce('Forgot that memory line. Waiting for Claude.');
}

function forgetSkill(s) {
  confirmSkill = null;
  commit('den.skill.forget', { name: s.name }, { noUndo: 'No undo for a skill. He learns it again when it comes up.' });
  react('wink');
  announce(`Forgot the skill “${s.title}”. Waiting for Claude.`);
  focusFk(`skills:${s.name}:x`);
}

function rateSkill(s, ok) {
  if (marks.get(`skills:${s.name}`) === (ok ? 'up' : 'down')) return;
  const truth = D.skills.find((x) => x.name === s.name);
  commit('den.skill.rate', { name: s.name, ok }, {
    inverse: { type: 'den.skill.rate', data: { name: s.name, ok: !ok } },
    meta: { confidence: truth?.confidence ?? null, uses: truth?.uses ?? null },
  });
  announce(ok ? `Thumbs up on “${s.title}”.` : `Thumbs down on “${s.title}”.`);
}

/** Name, tagline or colour: one field of `den.persona.set`. */
function setPersonaField(field, value) {
  const prev = V.persona[field];
  if (prev === value) return;
  const back = prev ?? (field === 'color' ? V.defaults.color : field === 'tagline' ? '' : V.defaults.name);
  commit('den.persona.set', { [field]: value }, { inverse: { type: 'den.persona.set', data: { [field]: back } } });
  applyPersonaToShell({ [field]: value });
  if (field === 'name' || field === 'tagline') react('blush');
}

function resetPersona() {
  const p = V.persona;
  const prev = { traits: {} };
  for (const f of ['name', 'tagline', 'color']) if (p[f] != null) prev[f] = p[f];
  for (const k of TRAIT_KEYS) if (p.traits[k] != null) prev.traits[k] = p.traits[k];
  if (!Object.keys(prev.traits).length) delete prev.traits;
  commit('den.persona.reset', {}, { inverse: Object.keys(prev).length ? { type: 'den.persona.set', data: prev } : null, noUndo: 'Nothing to put back.' });
  applyPersonaToShell({ name: V.defaults.name, tagline: V.defaults.tagline, color: V.defaults.color, traits: V.defaults.traits });
  announce('Reset to defaults. Waiting for Claude.');
}

/** Forget whatever row `key` is (Doto's "Forget this"). @returns {boolean} */
function forgetRow(key) {
  const info = rowInfo(key);
  if (!info || !FORGETTABLE.has(info.section) || marks.get(key) === 'forget') return false;
  const id = String(info.id);
  if (info.section === 'likes' || info.section === 'dislikes') { if (!hasText(V.persona[info.section], id)) return false; forgetChip(info.section, id); }
  else if (info.section === 'nicknames') { if (!Object.hasOwn(V.persona.nicknames, id)) return false; forgetNick(id); }
  else if (info.section === 'memory') { const m = V.memory.find((x) => String(x.ts) === id); if (!m) return false; forgetMemory(m); }
  else if (info.section === 'skills') { const s = V.skills.find((x) => x.name === id); if (!s) return false; forgetSkill(s); }
  return true;
}

/** The companion mirrors local persona edits at once (the engine broadcasts the truth later). */
function applyPersonaToShell(p) {
  if (!hasShell || !p) return;
  const out = {};
  if (typeof p.name === 'string' && p.name.trim()) out.name = p.name;
  if (typeof p.tagline === 'string') out.tagline = p.tagline;
  if (typeof p.color === 'string' && validColor(p.color)) out.color = p.color;
  if (isObj(p.traits)) { out.traits = {}; for (const [k, v] of Object.entries(p.traits)) if (v != null) out.traits[k] = v; }
  if (!Object.keys(out).length) return;
  try { shell.entity?.persona?.(out); } catch { /* optional */ }
}

// inline editors (name, tagline, nickname value)

/**
 * Swaps a button for a text input. Enter saves, Esc cancels, blur saves.
 * @param {HTMLElement} btn
 * @param {{value:string, max:number, min:number, label:string, onSave:(v:string)=>void, tooShort?:string, onClose?:()=>void}} o
 */
function inlineEdit(btn, o) {
  if (btn.hidden) return;
  const input = h('input', { type: 'text', class: `inline-edit ${btn.classList.contains('p-name') ? 'big' : ''}`, maxlength: String(o.max), 'aria-label': o.label, 'data-fk': btn.dataset.fk || null });
  input.value = o.value;
  btn.hidden = true;
  btn.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const val = input.value.replace(/\s+/g, ' ').trim();
    const refocus = document.activeElement === input;
    input.remove();
    btn.hidden = false;
    o.onClose?.();
    if (save && val !== o.value.trim()) {
      if (val.length < o.min) toast(o.tooShort || 'Too short.', 'info', 2200);
      else o.onSave(val);
    }
    if (refocus) (btn.isConnected ? btn : home.querySelector(`[data-fk="${CSS.escape(btn.dataset.fk || '')}"]`))?.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function editNick(key, btn) {
  editingNick = key;
  inlineEdit(btn, {
    value: V.persona.nicknames[key] ?? '', max: NICK_VALUE_MAX, min: 1, label: `What “${key}” means`,
    tooShort: 'Say what it means, or press × to forget it.',
    onSave: (v) => { editingNick = null; setNick(key, v); },
    onClose: () => { editingNick = null; queueMicrotask(render); },
  });
}

// ───────────────────────────── 7. outgoing events ─────────────────────────────

/** The current payload (host truth) plus the edits still waiting for Claude. */
function exportPayload() {
  const p = D?.persona || {};
  const label = `${p.name || 'Doto'} · ${(p.likes || []).length} likes · ${(p.dislikes || []).length} dislikes · ${(D?.skills || []).length} skills`;
  const out = { label, entity: structuredClone(D) };   // `label` gives the saved session its summary
  if (edits.length) out.pending = edits.map((e) => ({ type: e.type, data: e.data }));
  return out;
}

/** `den.ask`: question + what the human was looking at + the payload; mirrored in chat. */
function emitAsk(question, about) {
  flushTraitsSoon.flush();
  const a = about && SECTIONS.includes(about.section) ? about : { section: '' };
  const clean = { section: a.section };
  if (a.id != null && a.id !== '') clean.id = a.id;
  if (a.text) clean.text = preview(a.text, 200);
  lets.emitNow('den.ask', { question, about: clean, entity: structuredClone(D) });
  try { shell.chat?.open?.(); shell.chat?.append?.('you', clean.text ? `${question}  ·  ${preview(clean.text, 80)}` : question); } catch { /* chat optional */ }
  if (!hasShell) toast('Asked. Claude answers in chat.', 'ok');
  else awayHint('reads');
}

/** Send to Claude: the handoff (the engine saves it as a session and closes the window). */
function sendToClaude() {
  flushTraitsSoon.flush();
  lets.emitNow('den.export', exportPayload());
  btnSend.classList.remove('sent');
  void btnSend.getBoundingClientRect();
  btnSend.classList.add('sent');
  react('cheer');
  toast(`Sent. ${countLine(D)}. Continue in Claude Code.`, 'ok', 4000);
  awayHint('reads');
}

// ───────────────────────────── 8. incoming commands ─────────────────────────────

const COMMANDS = {
  'den.load': cmdLoad,
  'den.refresh': () => refresh({ clear: true, source: 'claude' }),
  'den.highlight': cmdHighlight,
  'den.focus': (d) => { const s = String(d.section ?? ''); if (!SECTIONS.includes(s)) throw new Error(`unknown section "${s}"`); focusSection(s); },
  'den.snapshot': (d, msg) => lets.emitNow('den.snapshot', exportPayload(), msg?.id ? { re: msg.id } : undefined),
};

/** Runs a command; errors become lip.ack{ok:false} (if acked) or lip.error. */
function runCommand(type, fn, data, msg) {
  const fail = (err) => {
    if (msg?.ack) throw err;
    const message = `${type}: ${err?.message || err}`;
    console.warn('[den]', message);
    lets.emit('lip.error', { code: 'bad_request', message, re: msg?.id });
    return undefined;
  };
  try {
    const r = fn(isObj(data) ? data : {}, msg);
    return r && typeof r.then === 'function' ? r.catch(fail) : r;
  } catch (err) {
    return fail(err);
  }
}

/**
 * `den.load {entity, merge?}`. A load that arrives right after boot, before
 * the human did anything, is the restore of a resumed session: it renders,
 * then the live state is fetched (a resumed den shows the live state).
 */
function cmdLoad(d) {
  if (!isObj(d.entity)) throw new Error('needs {entity}');
  // lets 0.6.0 marks a resume with `session: {id, resumed: true}` on the restore command; the timing rule is the fallback
  const restoring = !d.merge && (d.session?.resumed === true || (!userActed && performance.now() - bootAt < 8000));
  setTruth(d.merge ? mergeEntity(D, d.entity) : normalize(d.entity));
  if (state !== 'ready') state = 'ready';
  const had = edits.length;
  pruneEdits();
  if (had && !edits.length) pendingReaction ||= 'nod';
  render();
  playPending();
  if (restoring) return fetchEntity({ quiet: true }).then((ok) => { if (ok) { pruneEdits(); render(); } });
  return undefined;
}

/** Row key for a section + id as Claude names it (secrets by name, memory by ts…). */
function rowKeyFor(section, id) {
  if (section === 'secrets') {
    const i = V.secretsAll.indexOf(id);
    if (i < 0) return null;
    return foundSecrets(V).includes(id) ? `secrets:${id}` : `secrets:#${i + 1}`;
  }
  if (section === 'likes' || section === 'dislikes') {
    const hit = V.persona[section].find((x) => sameText(x, id));
    return hit ? `${section}:${hit}` : null;
  }
  return `${section}:${id}`;
}

function rowEl(key) {
  return home.querySelector(`[data-row="${CSS.escape(key)}"]`);
}

/** `den.highlight {section, id?, color?, ttl?}` */
function cmdHighlight(d) {
  const section = String(d.section ?? '');
  if (!section) { clearHighlights(); return; }
  if (!SECTIONS.includes(section)) throw new Error(`unknown section "${section}"`);
  const id = d.id == null || d.id === '' ? null : String(d.id);
  if (!highlight(section, id, d.color, d.ttl, true)) throw new Error(`no row "${id}" in ${section}`);
}

/**
 * Glows a section or one row; scrolls it into view when it is off-screen.
 * @returns {boolean} false when the row does not exist
 */
function highlight(section, id, color, ttl, scroll = false) {
  if (section === 'memory' && id != null && prefs.filter !== 'all') {
    const m = V.memory.find((x) => String(x.ts) === id);
    if (m && m.kind !== prefs.filter) { prefs.filter = 'all'; savePrefs(); render(); }
  }
  const key = id == null ? section : rowKeyFor(section, id);
  if (!key) return false;
  expand(section);
  const el = id == null ? $(`sec-${section}`) : rowEl(key);
  if (!el) return false;
  const life = ttl === 0 ? 0 : clamp(numOr(ttl) ?? HL_TTL, 300, 120000);
  const prev = HL.get(key);
  if (prev) clearTimeout(prev.timer);
  HL.set(key, { color: validColor(color) ? color : '', timer: life ? setTimeout(() => { HL.delete(key); paintHighlights(); }, life) : 0 });
  paintHighlights();
  if (scroll) scrollIntoViewIfNeeded(el);
  return true;
}

function clearHighlights() {
  for (const v of HL.values()) clearTimeout(v.timer);
  HL.clear();
  paintHighlights();
}

function paintHighlights() {
  for (const el of home.querySelectorAll('.hl')) { el.classList.remove('hl'); el.style.removeProperty('--hl'); }
  for (const [key, v] of HL) {
    const el = key.includes(':') ? rowEl(key) : $(`sec-${key}`);
    if (!el) continue;
    el.classList.add('hl');
    if (v.color) el.style.setProperty('--hl', v.color);
  }
}

function scrollIntoViewIfNeeded(el) {
  const r = el.getBoundingClientRect();
  const top = topbar.getBoundingClientRect().bottom + 8;
  if (r.top >= top && r.bottom <= innerHeight - 8) return;
  glide(el, r.height > innerHeight - top ? 'start' : 'center');
}

let scrollCheck = 0;
/**
 * Smooth scroll (instant under reduced motion). A page that is not painting
 * (a hidden pane) never advances a smooth scroll; then it jumps instead, so
 * the command still lands.
 */
function glide(el, block) {
  if (!el) return;
  if (REDUCED.matches) { el.scrollIntoView({ behavior: 'auto', block }); return; }
  const before = home.scrollTop;
  el.scrollIntoView({ behavior: 'smooth', block });
  clearTimeout(scrollCheck);
  scrollCheck = setTimeout(() => { if (home.scrollTop === before) el.scrollIntoView({ behavior: 'auto', block }); }, 450);
}

/** `den.focus`: open the card and scroll it to the top (smooth; instant under reduced motion). */
function focusSection(section) {
  expand(section);
  glide($(`sec-${section}`), 'start');
}

// ───────────────────────────── 9. companion hooks ─────────────────────────────

let hoverKey = null;     // row under the pointer (kept while the pointer is over the companion)
let hoverSection = null;
let lastRowKey = null;   // last row hovered or focused (what Ask is about)

/** What the human is looking at, for `den.ask {about}` and the companion. */
function rowInfo(key) {
  if (!key) return null;
  const i = key.indexOf(':');
  const section = key.slice(0, i);
  const id = key.slice(i + 1);
  const p = V.persona;
  let text = '';
  switch (section) {
    case 'persona': text = id === 'name' ? p.name : id === 'tagline' ? p.tagline : id === 'color' ? p.color || V.defaults.color : ''; break;
    case 'traits': text = `${id} ${fmt2(p.traits[id])}`; break;
    case 'likes': case 'dislikes': text = id; break;
    case 'nicknames': text = `${id} → ${p.nicknames[id] ?? ''}`; break;
    case 'memory': text = V.memory.find((m) => String(m.ts) === id)?.text || ''; break;
    case 'skills': { const s = V.skills.find((x) => x.name === id); text = s ? `${s.title} (${s.name})` : id; break; }
    case 'secrets': text = id.startsWith('#') ? 'a secret move not found yet' : `secret move ${id}`; break;
    case 'profile': text = rowEl(key)?.getAttribute('aria-label') || id; break;
    default: return null;
  }
  return { section, id: section === 'memory' ? Number(id) : id, text: preview(text, 200) };
}

function counts() {
  return {
    likes: V.persona.likes.length, dislikes: V.persona.dislikes.length, nicknames: Object.keys(V.persona.nicknames).length,
    memory: V.memory.length, skills: V.skills.length, secrets: foundSecrets(V).length,
  };
}

/**
 * Shell `context()`: the row under the cursor (or under the right-click), and the counts.
 * @returns {{section:string|null, id:string|number|null, text:string|null, counts:object}}
 */
function entityContext(info) {
  const t = info?.target instanceof Element ? info.target : null;
  const row = t?.closest?.('[data-row]');
  const key = row && home.contains(row) ? row.dataset.row : hoverKey;
  const r = rowInfo(key);
  const section = r?.section || (t && home.contains(t) ? t.closest('[data-section]')?.dataset.section : hoverSection) || null;
  return { section, id: r?.id ?? null, text: r?.text ?? null, counts: counts() };
}

let suggestCtx = null;

/** Doto's click menu: what he knows, why this row, forget this row, chat. */
function quickSuggestions(ctx) {
  suggestCtx = isObj(ctx) ? ctx : entityContext();
  const run = (item, c) => { if (isObj(c)) suggestCtx = c; runPick(item?.id); };
  const items = [{ id: 'den.ask-all', label: 'What do you know about me?', hint: 'a short honest summary, with counts', run }];
  if (suggestCtx.id != null && suggestCtx.section) {
    const what = preview(suggestCtx.text || String(suggestCtx.id), 44);
    items.push({ id: 'den.ask-why', label: 'Why this?', hint: what, run });
    const key = rowKeyFor(suggestCtx.section, String(suggestCtx.id)) || `${suggestCtx.section}:${suggestCtx.id}`;
    if (FORGETTABLE.has(suggestCtx.section) && marks.get(key) !== 'forget') items.push({ id: 'den.forget-this', label: 'Forget this', hint: what, run });
  }
  items.push({ id: 'den.open-chat', label: 'Open chat', hint: 'type to Claude', run });
  return items;
}

const PICKS = {
  'den.ask-all': () => emitAsk('What do you know about me?', { section: '' }),
  'den.ask-why': () => {
    const c = suggestCtx;
    if (c?.section && c.id != null) emitAsk('Why this?', { section: c.section, id: c.id, text: c.text || '' });
  },
  'den.forget-this': () => {
    const c = suggestCtx;
    if (!c?.section || c.id == null) return;
    const key = rowKeyFor(c.section, String(c.id)) || `${c.section}:${c.id}`;
    if (!forgetRow(key)) toast('Nothing to forget there.', 'info', 1800);
  },
  'den.open-chat': () => { try { shell.chat?.open?.(); } catch { /* optional */ } },
};
let lastPick = { id: '', t: 0 };

/** Runs a menu pick once (the shell calls `run` and `onPick`; dedupe). */
function runPick(id) {
  if (!Object.hasOwn(PICKS, id) || (lastPick.id === id && performance.now() - lastPick.t < 400)) return;
  lastPick = { id, t: performance.now() };
  try { PICKS[id](); } catch (err) { console.warn('[den] suggestion failed', err); }
}

/** One of the companion's short expressions, if the shell has them. */
function react(name) {
  try { shell.entity?.react?.(name); } catch { /* optional */ }
}

function playPending() {
  if (!pendingReaction) return;
  react(pendingReaction);
  pendingReaction = '';
}

function toggleEntity() {
  const e = shell.entity;
  if (!e) { toast('The companion is not here. Open den from Claude Code.', 'warn'); return; }
  try {
    if (typeof e.toggle === 'function') e.toggle();
    else if (e.state?.visible) e.hide?.(); else e.show?.();
  } catch (err) { console.warn('[den] companion toggle failed', err); }
}

// ───────────────────────────── 10. chrome, keyboard, start-up ─────────────────────────────

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    return {
      collapsed: Array.isArray(p?.collapsed) ? p.collapsed.filter((s) => SECTIONS.includes(s)) : [],
      filter: typeof p?.filter === 'string' ? p.filter : 'all',
    };
  } catch {
    return { collapsed: [], filter: 'all' };
  }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage off */ }
}

function setCollapsed(section, on) {
  const sec = $(`sec-${section}`);
  if (!sec) return;
  sec.dataset.collapsed = String(on);
  $(`body-${section}`).hidden = on;
  sec.querySelector('.card-toggle')?.setAttribute('aria-expanded', String(!on));
  const set = new Set(prefs.collapsed);
  if (on) set.add(section); else set.delete(section);
  prefs.collapsed = [...set];
  savePrefs();
}

function expand(section) {
  if ($(`sec-${section}`)?.dataset.collapsed === 'true') setCollapsed(section, false);
}

function focusFk(fk) {
  setTimeout(() => home.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true }), 0);
}

/** Shell toast, or a local one when running without the shell. */
function toast(text, level = 'info', ttl = 3500) {
  if (hasShell && typeof shell.toast === 'function') {
    try { shell.toast(text, level, ttl); return; } catch { /* fall through */ }
  }
  const el = h('div', { class: level, text });
  $('d-toast').append(el);
  setTimeout(() => el.remove(), ttl);
}

function announce(text) { $('sr-live').textContent = text; }

function toggleHelp(force) {
  const show = typeof force === 'boolean' ? force : helpEl.hidden;
  helpEl.hidden = !show;
  btnHelp.setAttribute('aria-expanded', String(show));
  if (show) closeAsk();
}

function openAsk() {
  toggleHelp(false);
  const r = rowInfo(lastRowKey);
  askAboutRow.hidden = !r;
  askAboutEl.textContent = r ? `${r.section} · ${preview(r.text, 60)}` : '';
  askForm.dataset.about = lastRowKey || '';
  askInput.placeholder = r ? 'Ask Claude about this line…' : 'Ask Claude about what he knows…';
  askForm.hidden = false;
  btnAsk.setAttribute('aria-expanded', 'true');
  askInput.focus();
}

function closeAsk() {
  if (askForm.hidden) return;
  const had = askForm.contains(document.activeElement);
  askForm.hidden = true;
  btnAsk.setAttribute('aria-expanded', 'false');
  if (had) btnAsk.focus({ preventScroll: true });
}

function showReset(on) {
  btnReset.hidden = on;
  resetConfirm.hidden = !on;
  if (on) $('btn-reset-no').focus({ preventScroll: true });
}

/** Esc: closes the innermost open thing. @returns {boolean} whether something closed */
function closeOverlays() {
  if (!helpEl.hidden) { toggleHelp(false); btnHelp.focus({ preventScroll: true }); return true; }
  if (!askForm.hidden) { closeAsk(); return true; }
  if (!resetConfirm.hidden) { showReset(false); btnReset.focus({ preventScroll: true }); return true; }
  if (confirmSkill) { const k = `skills:${confirmSkill}:x`; confirmSkill = null; render(); focusFk(k); return true; }
  return false;
}

function showStatus(s) {
  statusDot.dataset.status = s;
  const text = s === 'open' ? 'Connected to Claude' : s === 'closed' ? 'Offline — showing what I had' : 'Connecting to Claude…';
  statusDot.setAttribute('aria-label', text);
  statusDot.parentElement.title = `den · ${text}`;
}

function onKeyDown(e) {
  if (e.defaultPrevented || e.isComposing) return;
  const t = e.target instanceof Element ? e.target : null;
  if (e.key === 'Escape') { if (closeOverlays()) e.preventDefault(); return; }
  if (isEditable(t)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (mod || e.altKey) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && t?.matches('[data-x]')) { e.preventDefault(); t.click(); return; }
  if ((e.key === 'Enter' || e.key === 'F2') && t?.matches('.editable')) return; // a button: Enter clicks it
  if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
  if (/^[1-9]$/.test(e.key) && !t?.matches('input')) {
    const s = SECTIONS[Number(e.key) - 1];
    e.preventDefault();
    focusSection(s);
    $(`sec-${s}`)?.querySelector('.card-toggle')?.focus({ preventScroll: true });
  }
}

// ── start-up ──

function buildSwatches() {
  for (const [c, name] of SWATCHES) {
    swatchesEl.append(h('button', {
      type: 'button', class: 'swatch', 'data-color': c, 'aria-pressed': 'false', 'aria-label': `Colour ${name}`, title: name, style: { '--sw': c },
      onclick: () => setPersonaField('color', c),
    }));
  }
  swatchesEl.append(h('button', {
    type: 'button', class: 'swatch swatch-default', 'data-color': 'default', 'aria-pressed': 'false', 'aria-label': 'Default colour', title: 'default',
    onclick: () => setPersonaField('color', V.defaults.color),
  }, h('span', { class: 'sw-dot', 'aria-hidden': 'true' }), 'default'));
}

let shell = { entity: null, chat: null, toast: null, listening: null };
let hasShell = false;
if (ShellApi && typeof ShellApi.mount === 'function') {
  try {
    shell = ShellApi.mount(lets, { root: document.body, entity: { name: 'Doto' }, context: entityContext, quickSuggestions }) || shell;
    hasShell = true;
  } catch (err) {
    console.warn('[den] Shell.mount failed — running without the shell:', err?.message || err);
  }
}
if (hasShell) {
  // Shells without run() on suggestions: entity.onPick fires too (runPick dedupes).
  try { shell.entity?.onPick?.((it) => runPick(it?.id)); } catch (err) { console.warn('[den] onPick', err); }
}

for (const [type, fn] of Object.entries(COMMANDS)) lets.on(type, (data, msg) => runCommand(type, fn, data, msg));
let wasClosed = false;
lets.onStatus((s) => {
  showStatus(s);
  if (s === 'closed') wasClosed = true;
  else if (s === 'open' && wasClosed) {
    wasClosed = false;
    fetchEntity({ quiet: true }).then((ok) => { if (ok) { pruneEdits(); render(); } });
  }
});
showStatus(lets.status);

buildTraits();
buildSwatches();
for (const s of prefs.collapsed) setCollapsed(s, true);

toolbar.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('[data-act]') : null;
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === 'refresh') refresh({ source: 'human' });
  else if (act === 'ask') { if (askForm.hidden) openAsk(); else closeAsk(); }
  else if (act === 'send') sendToClaude();
  else if (act === 'undo') undo();
  else if (act === 'chat') { try { shell.chat?.toggle?.(); } catch { /* optional */ } if (!hasShell) toast('Chat needs the lets shell.', 'warn'); }
  else if (act === 'entity') toggleEntity();
  else if (act === 'help') toggleHelp();
});

askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = askInput.value.trim();
  const r = rowInfo(askForm.dataset.about || '');
  askInput.value = '';
  closeAsk();
  if (q) emitAsk(q, r || { section: '' });
});
askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); askInput.value = ''; closeAsk(); }
});
$('ask-about-x').addEventListener('click', () => {
  askForm.dataset.about = '';
  askAboutRow.hidden = true;
  askInput.placeholder = 'Ask Claude about what he knows…';
  askInput.focus();
});

for (const sec of SECTIONS) {
  $(`sec-${sec}`).querySelector('.card-toggle').addEventListener('click', () => setCollapsed(sec, $(`sec-${sec}`).dataset.collapsed !== 'true'));
}

pName.addEventListener('click', () => inlineEdit(pName, {
  value: V.persona.name || '', max: NAME_MAX, min: 1, label: 'His name, 1 to 24 characters',
  tooShort: 'Keep a name. 1 to 24 characters.',
  onSave: (v) => setPersonaField('name', v.slice(0, NAME_MAX)),
}));
pTagline.addEventListener('click', () => inlineEdit(pTagline, {
  value: V.persona.tagline || '', max: TAGLINE_MAX, min: 0, label: 'His tagline, up to 120 characters',
  onSave: (v) => setPersonaField('tagline', v.slice(0, TAGLINE_MAX)),
}));

btnReset.addEventListener('click', () => showReset(true));
$('btn-reset-no').addEventListener('click', () => { showReset(false); btnReset.focus({ preventScroll: true }); });
$('btn-reset-yes').addEventListener('click', () => { showReset(false); resetPersona(); btnReset.focus({ preventScroll: true }); });

for (const form of home.querySelectorAll('form.add-form')) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const sec = form.dataset.add;
    if (sec === 'nicknames') {
      const k = $('add-nick-key');
      const v = $('add-nick-value');
      if (setNick(k.value, v.value)) { k.value = ''; v.value = ''; k.focus(); }
      else if (!k.value.trim()) k.focus(); else v.focus();
    } else {
      const input = form.querySelector('input');
      if (addChip(sec, input.value)) input.value = '';
    }
  });
}

const track = (t, hover) => {
  const row = t instanceof Element ? t.closest('[data-row]') : null;
  const key = row?.dataset.row || null;
  if (hover) {
    hoverKey = key;
    hoverSection = t instanceof Element ? t.closest('[data-section]')?.dataset.section || null : null;
  }
  if (key) lastRowKey = key;
};
home.addEventListener('pointerover', (e) => track(e.target, true));
home.addEventListener('focusin', (e) => track(e.target, false));
home.addEventListener('contextmenu', (e) => track(e.target, true), true);
addEventListener('keydown', onKeyDown);
new ResizeObserver(() => app.style.setProperty('--topbar-h', `${Math.round(topbar.getBoundingClientRect().height)}px`)).observe(topbar);
setInterval(tickTimes, 60000);

render();
fetchEntity().then(() => { pruneEdits(); render(); playPending(); });
