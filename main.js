'use strict';

// Studiolo: one Markdown note per day with a task board, a timer, unfinished tasks from
// earlier days and notes left for later. All task data stays in the notes themselves.

const obsidian = require('obsidian');
const {
  Plugin,
  Notice,
  Modal,
  Menu,
  Setting,
  PluginSettingTab,
  MarkdownRenderChild,
  MarkdownRenderer,
  MarkdownView,
  TFile,
  TFolder,
  normalizePath,
  setIcon,
} = obsidian;
const moment = obsidian.moment;

// Constants

const DATE_FMT = 'YYYY-MM-DD';

const BLOCK = {
  nav: 'studiolo-nav',
  timer: 'studiolo-timer',
  board: 'studiolo-board',
  carryover: 'studiolo-carryover',
  previous: 'studiolo-previous',
  notes: 'studiolo-notes',
  catchup: 'studiolo-catchup',
};

// `theme` is the color a lane uses until the user picks one in settings.
const LANES = [
  { id: 'todo', label: 'To do', char: ' ', theme: '--color-blue' },
  { id: 'doing', label: 'Doing', char: '/', theme: '--color-orange' },
  { id: 'done', label: 'Done', char: 'x', theme: '--color-green' },
];

const NEXT_DAYS_RE = /notes for next days/i;
const TODAY_NOTES_RE = /notes for today/i;
const DRAG_MIME = 'application/x-studiolo';

const DEFAULT_SETTINGS = {
  folder: 'Journal',
  templatePath: '',
  openOnStartup: true,
  autoCreate: true,
  categories: ['Work', 'Study', 'Personal'],
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
  autoStartNext: false,
  sound: true,
  systemNotification: true,
  // Hex colors; empty means the theme color from LANES.
  laneColors: { todo: '', doing: '', done: '' },
};

// Pure helpers, no Obsidian or DOM. Exported for the tests.

/** Status character to lane id. */
function laneOf(ch) {
  if (ch === ' ') return 'todo';
  if (ch === '/') return 'doing';
  if (ch === 'x' || ch === 'X') return 'done';
  if (ch === '-') return 'archived';
  if (ch === '>') return 'moved';
  return 'todo';
}

/** Lane id to status character. Keeps `prev` if it already maps to that lane. */
function laneChar(lane, prev) {
  if (prev != null && laneOf(prev) === lane) return prev;
  if (lane === 'archived') return '-';
  if (lane === 'moved') return '>';
  const l = LANES.find((x) => x.id === lane);
  return l ? l.char : ' ';
}

function isOpen(ch) {
  const l = laneOf(ch);
  return l === 'todo' || l === 'doing';
}

function isVisible(ch) {
  const l = laneOf(ch);
  return l === 'todo' || l === 'doing' || l === 'done';
}

/** Splits "Call the dentist (since 2026-10-16)" into { text, since }. */
function splitSince(s) {
  const m = /\s*\(since (\d{4}-\d{2}-\d{2})\)\s*$/.exec(s);
  if (!m) return { text: s.trim(), since: null };
  return { text: s.slice(0, m.index).trim(), since: m[1] };
}

function cardLine(c) {
  return `- [${c.status}] ${c.text}${c.since ? ` (since ${c.since})` : ''}`;
}

function cardKey(c) {
  return `${c.category}\u0000${cardLine(c)}`;
}

/**
 * Board format (inside the ```studiolo-board block):
 *
 *   ## Work
 *   - [ ] To do task
 *   - [/] Doing task
 *   - [x] Done task
 *   - [-] Archived task
 *   - [>] Task moved to a later day
 *
 *   ## Study
 *   - [ ] Chapter 3 (since 2026-10-16)
 */
function parseBoard(text) {
  // Lines that are neither headings nor cards (hand-written notes, say) are kept in `extra`
  // under their category, or under '' before the first heading, so writing the board back
  // never drops them.
  const board = { categories: [], cards: [], extra: {} };
  let cat = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const hd = /^\s*#{1,6}\s+(.+)$/.exec(line);
    if (hd) {
      cat = hd[1].trim();
      if (!board.categories.includes(cat)) board.categories.push(cat);
      continue;
    }
    const m = /^\s*[-*+]\s+\[(.)\]\s?(.*)$/.exec(line);
    const { text: t, since } = m ? splitSince(m[2]) : { text: '' };
    if (!t) {
      const k = cat === null ? '' : cat;
      (board.extra[k] = board.extra[k] || []).push(line);
      continue;
    }
    if (cat === null) {
      cat = 'General';
      if (!board.categories.includes(cat)) board.categories.push(cat);
    }
    board.cards.push({ status: m[1], text: t, since, category: cat });
  }
  return board;
}

function serializeBoard(board) {
  const extra = board.extra || {};
  const cats = board.categories.slice();
  for (const c of board.cards) if (!cats.includes(c.category)) cats.push(c.category);
  for (const k of Object.keys(extra)) if (k && !cats.includes(k)) cats.push(k);
  const out = (extra[''] || []).slice();
  cats.forEach((cat) => {
    if (out.length) out.push('');
    out.push(`## ${cat}`);
    for (const c of board.cards) if (c.category === cat) out.push(cardLine(c));
    out.push(...(extra[cat] || []));
  });
  return out.join('\n');
}

/** Categories to draw: empty ones (just added), ones with visible cards, and `keep`. */
function visibleCategories(board, keep = []) {
  const cats = board.categories.slice();
  for (const c of board.cards) if (!cats.includes(c.category)) cats.push(c.category);
  return cats.filter((cat) => {
    if (keep.includes(cat)) return true;
    const cards = board.cards.filter((c) => c.category === cat);
    return cards.length === 0 || cards.some((c) => isVisible(c.status));
  });
}

/** For each line: true if it's inside (or is) a fenced code block line. */
function fenceMask(lines) {
  const mask = [];
  let fence = null;
  for (const l of lines) {
    const m = /^\s*(`{3,}|~{3,})/.exec(l);
    if (fence) {
      mask.push(true);
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(l);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else if (m) {
      mask.push(true);
      fence = m[1];
    } else {
      mask.push(false);
    }
  }
  return mask;
}

function findBlock(lines, lang) {
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*([\w-]+)\s*$/.exec(lines[i]);
    if (!open || open[2] !== lang) continue;
    const fence = open[1];
    for (let j = i + 1; j < lines.length; j++) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[j]);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        return { start: i, end: j, closed: true };
      }
    }
    return { start: i, end: lines.length, closed: false };
  }
  return null;
}

function getBlockBody(content, lang) {
  const lines = String(content).split('\n');
  const b = findBlock(lines, lang);
  return b ? lines.slice(b.start + 1, b.end).join('\n') : null;
}

/** Returns the new content, or null if the block isn't there. */
function replaceBlockBody(content, lang, body) {
  const lines = String(content).split('\n');
  const b = findBlock(lines, lang);
  if (!b) return null;
  const bodyLines = body ? body.split('\n') : [];
  const tail = b.closed ? lines.slice(b.end) : ['```'];
  return [...lines.slice(0, b.start + 1), ...bodyLines, ...tail].join('\n');
}

function headingAt(line) {
  const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  return m ? { level: m[1].length, text: m[2] } : null;
}

/** "> [!studiolo-note] Notes for today" to { type, title }. */
function calloutAt(line) {
  const m = /^>\s*\[!([^\]\s]+)\][+-]?\s*(.*?)\s*$/.exec(line);
  return m ? { type: m[1].toLowerCase(), title: m[2] } : null;
}

/**
 * The section starting at line `i`, if any. A heading runs to the next heading of the same or a
 * higher level; a callout runs over its quoted lines. Callout lines carry a "> " prefix (`quoted`).
 */
function sectionAt(lines, i, mask) {
  if (mask[i]) return null;
  const hd = headingAt(lines[i]);
  if (hd) {
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (mask[j]) continue;
      const n = headingAt(lines[j]);
      if (n && n.level <= hd.level) break;
    }
    return { title: hd.text, type: null, start: i, end: j, quoted: false };
  }
  const co = calloutAt(lines[i]);
  if (co) {
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith('>')) j++;
    return { title: co.title, type: co.type, start: i, end: j, quoted: true };
  }
  return null;
}

/** First section (outside code blocks) whose title matches `re`. */
function findSection(lines, re) {
  const mask = fenceMask(lines);
  for (let i = 0; i < lines.length; i++) {
    const sec = sectionAt(lines, i, mask);
    if (sec && re.test(sec.title)) return Object.assign(sec, { mask });
  }
  return null;
}

/** A section line without its callout prefix. */
function bodyOf(line, quoted) {
  return quoted ? line.replace(/^>\s?/, '') : line;
}

/** Pending top-level bullets under "Notes for next days". */
function pendingNotes(content) {
  const lines = String(content).split('\n');
  const sec = findSection(lines, NEXT_DAYS_RE);
  if (!sec) return [];
  const out = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (sec.mask[i]) continue;
    const m = /^([-*+])\s+(?:\[(.)\]\s*)?(.*)$/.exec(bodyOf(lines[i], sec.quoted));
    if (!m) continue;
    const text = m[3].trim();
    if (!text) continue;
    if (m[2] !== undefined && m[2] !== ' ') continue;
    out.push({ line: i, raw: lines[i], text });
  }
  return out;
}

/** Ticks a pending note: "- note" and "- [ ] note" both become "- [x] note", inside a callout too. */
function resolveLine(raw) {
  const m = /^((?:>\s?)?\s*)([-*+])\s+(?:\[.\]\s*)?(.*)$/.exec(raw);
  return m ? `${m[1]}${m[2]} [x] ${m[3]}` : raw;
}

/**
 * Puts `newLine` at the end of the section matching `re`. A section that is still empty (blank
 * lines or a bare "- ") gets its placeholder replaced. Returns null if there is no such section.
 */
function insertIntoSection(content, re, newLine) {
  const lines = String(content).split('\n');
  const sec = findSection(lines, re);
  if (!sec) return null;
  const line = (sec.quoted ? '> ' : '') + newLine;
  const body = [];
  for (let k = sec.start + 1; k < sec.end; k++) if (!sec.mask[k]) body.push(k);
  const text = (k) => bodyOf(lines[k], sec.quoted).trim();
  if (body.every((k) => /^([-*+])?$/.test(text(k)))) {
    const placeholder = sec.quoted ? body[0] : body.find((k) => /^[-*+]$/.test(text(k)));
    if (placeholder != null) lines[placeholder] = line;
    else lines.splice(sec.start + 1, 0, line);
    return lines.join('\n');
  }
  let last = sec.start;
  for (const k of body) if (text(k)) last = k;
  lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

/** Kinds of note section, in page order. Custom ones ('other') go before "Notes for next days". */
const NOTE_KINDS = [
  { id: 'brainstorm', title: 'Brainstorm', type: 'studiolo-brainstorm', re: /brainstorm/i },
  { id: 'today', title: 'Notes for today', type: 'studiolo-note', re: TODAY_NOTES_RE },
  { id: 'evening', title: 'End of day', type: 'studiolo-evening', re: /end of day|results of today|what i learned/i },
  { id: 'next', title: 'Notes for next days', type: 'studiolo-next', re: NEXT_DAYS_RE },
];
const NOTE_ORDER = ['brainstorm', 'today', 'evening', 'other', 'next'];

/** Note sections of a page, as { kind, start, end }: callouts, or headings on hand-made pages. */
function noteSections(content) {
  const lines = String(content).split('\n');
  const mask = fenceMask(lines);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const sec = sectionAt(lines, i, mask);
    if (!sec) continue;
    const kind = NOTE_KINDS.find((k) => k.re.test(sec.title));
    if (kind) out.push({ kind: kind.id, start: sec.start, end: sec.end });
    else if (sec.type && sec.type.startsWith('studiolo-')) out.push({ kind: 'other', start: sec.start, end: sec.end });
  }
  return out;
}

/**
 * Adds an empty note callout where it belongs: a brainstorm right above the task board, the others
 * after the notes block in NOTE_ORDER. A kind that is already there isn't added twice.
 * Returns the new content and the index of the callout's first body line.
 */
function addNoteSection(content, kindId, customTitle) {
  const lines = String(content).split('\n');
  const kind = NOTE_KINDS.find((k) => k.id === kindId);
  const existing = noteSections(content);
  const same = kind && existing.find((s) => s.kind === kindId);
  if (same) return { content: String(content), line: same.start + 1 };

  const order = NOTE_ORDER.indexOf(kind ? kind.id : 'other');
  const below = existing.filter((s) => s.kind !== 'brainstorm');
  let at = null;
  if (kindId === 'brainstorm') {
    const board = findBlock(lines, BLOCK.board);
    if (board) at = board.start;
    else if (below.length) at = below[0].start;
  } else {
    const later = below.find((s) => NOTE_ORDER.indexOf(s.kind) > order);
    const earlier = below.filter((s) => NOTE_ORDER.indexOf(s.kind) <= order).pop();
    const anchor = findBlock(lines, BLOCK.notes) || findBlock(lines, BLOCK.board);
    if (later) at = later.start;
    else if (earlier) at = earlier.end;
    else if (anchor) at = anchor.end + 1;
  }
  if (at == null || at > lines.length) at = lines.length;
  // Keep the file's final newline after the new callout.
  if (at === lines.length && lines[at - 1] === '') at -= 1;

  const block = [`> [!${kind ? kind.type : 'studiolo-note'}] ${kind ? kind.title : customTitle}`, '> '];
  // Callouts need blank lines around them, or they merge with the neighbouring quote or paragraph.
  const before = at > 0 && lines[at - 1].trim() ? [''] : [];
  const after = at < lines.length && lines[at].trim() ? [''] : [];
  lines.splice(at, 0, ...before, ...block, ...after);
  return { content: lines.join('\n'), line: at + before.length + 1 };
}

/** The callout section with this type and title, as sectionAt() returns it, or null. */
function findCallout(lines, type, title) {
  const mask = fenceMask(lines);
  for (let i = 0; i < lines.length; i++) {
    const co = mask[i] ? null : calloutAt(lines[i]);
    if (co && co.type === type && co.title === title) return sectionAt(lines, i, mask);
  }
  return null;
}

/** True if a section holds nothing but blank lines or bare "- " placeholders. */
function sectionIsEmpty(lines, sec) {
  for (let k = sec.start + 1; k < sec.end; k++) {
    if (!/^([-*+])?$/.test(bodyOf(lines[k], sec.quoted).trim())) return false;
  }
  return true;
}

/** Removes lines [sec.start, sec.end) and one of the blank lines around them. */
function removeSection(content, sec) {
  const lines = String(content).split('\n');
  let { start, end } = sec;
  if (end < lines.length && !lines[end].trim()) end++;
  else if (start > 0 && !lines[start - 1].trim()) start--;
  lines.splice(start, end - start);
  return lines.join('\n');
}

function buildDailyNote(m) {
  const block = (name) => ['```' + name, '```'];
  return [
    '---',
    `studiolo: ${m.format(DATE_FMT)}`,
    // Lets styles.css separate the page's sections without touching other notes.
    'cssclasses:',
    '  - studiolo',
    '---',
    `# ${m.format('dddd D MMMM YYYY')}`,
    '',
    ...block(BLOCK.nav),
    '',
    ...block(BLOCK.timer),
    '',
    // Draws its own "Catch up" title, so the whole section can disappear when there's nothing.
    ...block(BLOCK.catchup),
    '',
    '## Plan',
    ...block(BLOCK.board),
    '',
    '## Notes',
    ...block(BLOCK.notes),
    '',
  ].join('\n');
}

function hueOf(name) {
  let x = 0;
  for (const ch of String(name)) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return x % 360;
}

function catColor(name) {
  return `hsl(${hueOf(name)}, 62%, 55%)`;
}

function urgencyLevel(age) {
  if (age <= 1) return 1;
  if (age <= 3) return 2;
  if (age <= 6) return 3;
  return 4;
}

function fmtDuration(ms, roundUp) {
  const total = Math.max(0, roundUp ? Math.ceil(ms / 1000) : Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

/** "rgb(80, 120, 200)" (what getComputedStyle returns) to "#5078c8". */
function cssColorToHex(css) {
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(String(css));
  if (!m) return null;
  return '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

function todayStr() {
  return moment().format(DATE_FMT);
}

// DOM helpers

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** `opts.title` becomes the aria-label, which Obsidian also shows as the tooltip. */
function button(label, opts = {}) {
  const b = h('button', ['sl-btn', opts.cls].filter(Boolean).join(' '));
  b.type = 'button';
  if (opts.icon) {
    const icon = h('span', 'sl-btn-icon');
    setIcon(icon, opts.icon);
    b.appendChild(icon);
  }
  if (label != null) b.appendChild(document.createTextNode(label));
  if (opts.title) b.setAttribute('aria-label', opts.title);
  if (opts.disabled) b.disabled = true;
  if (opts.onClick) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      opts.onClick(e);
    });
  }
  return b;
}

function ageBadge(age, title) {
  const b = h('span', `sl-age sl-urgency-${urgencyLevel(age)}`, `${age}d`);
  if (title) b.title = title;
  return b;
}

// Timer

class StudioloTimer {
  constructor(plugin, saved) {
    this.p = plugin;
    this.s = Object.assign(
      {
        mode: 'pomodoro', // pomodoro | countdown | stopwatch
        running: false,
        endAt: 0,
        remaining: null,
        elapsed: 0,
        startedAt: 0,
        phase: 'focus', // focus | short | long
        round: 0, // completed focus sessions in the current cycle
        countdownMin: 10,
        today: { date: '', n: 0 },
      },
      saved || {}
    );
    if (this.s.remaining == null) this.s.remaining = this.fullDuration();
  }

  cfg() {
    return this.p.settings;
  }

  phaseMs(phase) {
    const c = this.cfg();
    const min = phase === 'focus' ? c.focusMin : phase === 'short' ? c.shortMin : c.longMin;
    return Math.max(1, Number(min) || 1) * 60000;
  }

  fullDuration() {
    if (this.s.mode === 'countdown') return Math.max(1, this.s.countdownMin) * 60000;
    if (this.s.mode === 'pomodoro') return this.phaseMs(this.s.phase);
    return 0;
  }

  remaining() {
    return this.s.running ? Math.max(0, this.s.endAt - Date.now()) : this.s.remaining;
  }

  elapsed() {
    return this.s.running ? this.s.elapsed + (Date.now() - this.s.startedAt) : this.s.elapsed;
  }

  displayMs() {
    return this.s.mode === 'stopwatch' ? this.elapsed() : this.remaining();
  }

  progress() {
    if (this.s.mode === 'stopwatch') return 0;
    const full = this.fullDuration();
    return full ? Math.min(1, Math.max(0, 1 - this.remaining() / full)) : 0;
  }

  isIdle() {
    if (this.s.running) return false;
    if (this.s.mode === 'stopwatch') return this.s.elapsed === 0;
    return this.s.remaining === this.fullDuration();
  }

  todayCount() {
    return this.s.today && this.s.today.date === todayStr() ? this.s.today.n : 0;
  }

  start() {
    if (this.s.running) return;
    const now = Date.now();
    if (this.s.mode === 'stopwatch') {
      this.s.startedAt = now;
    } else {
      if (!(this.s.remaining > 0)) this.s.remaining = this.fullDuration();
      this.s.endAt = now + this.s.remaining;
    }
    this.s.running = true;
    this.p.askNotificationPermission();
    this.changed();
  }

  pause() {
    if (!this.s.running) return;
    const now = Date.now();
    if (this.s.mode === 'stopwatch') this.s.elapsed += now - this.s.startedAt;
    else this.s.remaining = Math.max(0, this.s.endAt - now);
    this.s.running = false;
    this.changed();
  }

  toggle() {
    if (this.s.running) this.pause();
    else this.start();
  }

  reset() {
    this.s.running = false;
    if (this.s.mode === 'stopwatch') this.s.elapsed = 0;
    else this.s.remaining = this.fullDuration();
    this.changed();
  }

  /** Back to the first focus session, from a break or any round. Other modes just reset. */
  restartCycle() {
    if (this.s.mode === 'pomodoro') {
      this.s.phase = 'focus';
      this.s.round = 0;
    }
    this.reset();
  }

  setMode(mode) {
    if (mode === this.s.mode) return;
    this.s.running = false;
    this.s.mode = mode;
    this.s.elapsed = 0;
    this.s.remaining = this.fullDuration();
    this.changed();
  }

  setCountdown(min) {
    const v = Math.min(24 * 60, Math.max(1, Math.round(Number(min) || 0)));
    this.s.countdownMin = v;
    if (this.s.mode === 'countdown' && !this.s.running) this.s.remaining = this.fullDuration();
    this.changed();
  }

  /** Called when the settings change. */
  settingsChanged() {
    if (this.s.mode === 'pomodoro' && !this.s.running) this.s.remaining = this.fullDuration();
    this.changed();
  }

  skip() {
    if (this.s.mode !== 'pomodoro') return;
    this.advance(false);
  }

  advance(completed) {
    const s = this.s;
    const every = Math.max(1, Number(this.cfg().longEvery) || 4);
    if (s.phase === 'focus') {
      if (completed) {
        this.bumpToday();
        s.round += 1;
      }
      s.phase = completed && s.round % every === 0 ? 'long' : 'short';
    } else {
      if (s.phase === 'long') s.round = 0;
      s.phase = 'focus';
    }
    s.running = false;
    s.remaining = this.phaseMs(s.phase);
    if (completed && this.cfg().autoStartNext) this.start();
    else this.changed();
  }

  bumpToday() {
    const d = todayStr();
    if (!this.s.today || this.s.today.date !== d) this.s.today = { date: d, n: 0 };
    this.s.today.n += 1;
  }

  tick() {
    if (!this.s.running || this.s.mode === 'stopwatch') return;
    if (Date.now() >= this.s.endAt) this.complete();
  }

  complete() {
    if (this.s.mode === 'countdown') {
      this.s.running = false;
      this.s.remaining = this.fullDuration();
      this.p.notify('Time is up', `Your ${this.s.countdownMin}-minute timer has finished.`);
      this.changed();
      return;
    }
    const wasFocus = this.s.phase === 'focus';
    this.p.notify(
      wasFocus ? 'Focus session done' : 'Break is over',
      wasFocus ? 'Time for a break.' : 'Back to focus.'
    );
    this.advance(true);
  }

  phaseLabel() {
    const s = this.s;
    if (s.mode === 'countdown') return `Timer, ${s.countdownMin} min`;
    if (s.mode === 'stopwatch') return 'Stopwatch';
    const every = Math.max(1, Number(this.cfg().longEvery) || 4);
    if (s.phase === 'focus') return `Focus, round ${(s.round % every) + 1} of ${every}`;
    return s.phase === 'long' ? 'Long break' : 'Short break';
  }

  statusText() {
    if (this.isIdle()) return '';
    const s = this.s;
    const name = s.mode === 'stopwatch' ? 'Stopwatch' : s.mode === 'countdown' ? 'Timer' : s.phase === 'focus' ? 'Focus' : 'Break';
    const t = fmtDuration(this.displayMs(), s.mode !== 'stopwatch');
    return `${name} ${t}${s.running ? '' : ' (paused)'}`;
  }

  changed() {
    this.p.persist();
    this.p.updateTimerViews();
  }
}

// Single-line prompt

class PromptModal extends Modal {
  constructor(app, title, value, onSubmit) {
    super(app);
    this.title = title;
    this.value = value || '';
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.titleEl.textContent = this.title;
    const input = h('input', 'sl-prompt-input');
    input.type = 'text';
    input.value = this.value;
    this.contentEl.appendChild(input);
    const row = h('div', 'sl-prompt-buttons');
    const cancel = h('button', '', 'Cancel');
    const ok = h('button', 'mod-cta', 'Save');
    row.append(cancel, ok);
    this.contentEl.appendChild(row);
    const submit = () => {
      const v = input.value.replace(/\s*\n\s*/g, ' ').trim();
      this.close();
      if (v) this.onSubmit(v);
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => this.close());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  onClose() {
    this.contentEl.replaceChildren();
  }
}

// Confirmation for destructive actions. (ConfirmationModal only exists from Obsidian 1.13.)

class ConfirmModal extends Modal {
  constructor(app, title, message, action, onConfirm) {
    super(app);
    this.title = title;
    this.message = message;
    this.action = action;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    this.titleEl.textContent = this.title;
    this.contentEl.appendChild(h('p', null, this.message));
    const row = h('div', 'sl-prompt-buttons');
    const cancel = h('button', '', 'Cancel');
    const ok = h('button', 'mod-warning', this.action);
    row.append(cancel, ok);
    this.contentEl.appendChild(row);
    cancel.addEventListener('click', () => this.close());
    ok.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
    window.setTimeout(() => cancel.focus(), 0);
  }

  onClose() {
    this.contentEl.replaceChildren();
  }
}

// Plugin

class StudioloPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.initState();

    this.registerMarkdownCodeBlockProcessor(BLOCK.nav, (src, el, ctx) => this.renderNav(el, ctx));
    this.registerMarkdownCodeBlockProcessor(BLOCK.timer, (src, el, ctx) => this.renderTimer(el, ctx));
    this.registerMarkdownCodeBlockProcessor(BLOCK.board, (src, el, ctx) => this.renderBoard(src, el, ctx));
    this.registerMarkdownCodeBlockProcessor(BLOCK.carryover, (src, el, ctx) => this.renderLive(el, ctx, 'carryover'));
    this.registerMarkdownCodeBlockProcessor(BLOCK.previous, (src, el, ctx) => this.renderLive(el, ctx, 'previous'));
    this.registerMarkdownCodeBlockProcessor(BLOCK.notes, (src, el, ctx) => this.renderNotesBar(el, ctx));
    this.registerMarkdownCodeBlockProcessor(BLOCK.catchup, (src, el, ctx) => this.renderCatchup(el, ctx));
    // Runs on callouts in Reading view and, through the callout widget, in Live Preview.
    this.registerMarkdownPostProcessor((el, ctx) => this.decorateCallouts(el, ctx));

    this.addRibbonIcon('calendar-check', "Open today's page", () => this.openToday());
    this.addCommand({ id: 'open-today', name: 'Open today', callback: () => this.openToday() });
    this.addCommand({ id: 'toggle-timer', name: 'Start / pause timer', callback: () => this.timer.toggle() });
    this.addCommand({ id: 'reset-timer', name: 'Reset timer', callback: () => this.timer.reset() });
    this.addCommand({ id: 'restart-cycle', name: 'Restart pomodoro cycle', callback: () => this.timer.restartCycle() });
    this.addSettingTab(new StudioloSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.classList.add('sl-status');
    this.registerDomEvent(this.statusEl, 'click', () => this.timer.toggle());

    this.registerInterval(window.setInterval(() => this.onTick(), 500));
    this.registerInterval(window.setInterval(() => this.checkDayChange(), 60 * 1000));

    const onChange = (file) => {
      if (file && this.isJournalPath(file.path)) this.scheduleRefresh(file.path);
    };
    this.registerEvent(this.app.vault.on('modify', onChange));
    this.registerEvent(this.app.vault.on('create', onChange));
    this.registerEvent(this.app.vault.on('delete', onChange));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.isJournalPath(oldPath)) this.scheduleRefresh(oldPath);
        if (this.isJournalPath(file.path)) this.scheduleRefresh(file.path);
      })
    );

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.openOnStartup) await this.openToday();
      else if (this.settings.autoCreate) await this.ensureNote(moment());
    });
  }

  onunload() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
  }

  initState() {
    this.liveViews = new Set();
    this.timerViews = new Set();
    this.boardViews = new Set();
    this.collapsed = new Set();
    // Categories picked on a board that only hold archived or moved cards. Kept visible for
    // this session so the user gets an input to add to them.
    this.forceShown = new Set();
    this.drag = null;
    this.refocus = null;
    this.currentDay = todayStr();
    this.timer = new StudioloTimer(this, this.timerState);
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    this.settings.laneColors = Object.assign({}, DEFAULT_SETTINGS.laneColors, this.settings.laneColors);
    if (!Array.isArray(this.settings.categories)) this.settings.categories = DEFAULT_SETTINGS.categories.slice();
    this.timerState = data.timer || null;
  }

  async persist() {
    try {
      await this.saveData({ settings: this.settings, timer: this.timer ? this.timer.s : this.timerState });
    } catch (e) {
      console.error('Studiolo: could not save data', e);
    }
  }

  // paths & daily notes

  folder() {
    const f = String(this.settings.folder || '').trim();
    if (!f) return '';
    const n = normalizePath(f);
    return n === '/' ? '' : n.replace(/^\/+|\/+$/g, '');
  }

  inFolder(path) {
    const f = this.folder();
    return f === '' || path.startsWith(`${f}/`);
  }

  dateOfPath(path) {
    if (!path) return null;
    const base = path.split('/').pop().replace(/\.md$/i, '');
    const m = moment(base, DATE_FMT, true);
    return m.isValid() ? m : null;
  }

  isJournalPath(path) {
    return !!path && /\.md$/i.test(path) && this.inFolder(path) && !!this.dateOfPath(path);
  }

  notePath(m) {
    const f = this.folder();
    const name = `${m.format(DATE_FMT)}.md`;
    return f ? `${f}/${name}` : name;
  }

  getFile(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  /** All daily notes, oldest first. Only the journal folder is walked, not the whole vault. */
  dailyNotes() {
    const f = this.folder();
    const root = f ? this.app.vault.getAbstractFileByPath(f) : this.app.vault.getRoot();
    const out = [];
    const walk = (folder) => {
      for (const c of folder.children) {
        if (c instanceof TFolder) walk(c);
        else if (c instanceof TFile && this.isJournalPath(c.path)) out.push({ f: c, d: this.dateOfPath(c.path) });
      }
    };
    if (root instanceof TFolder) walk(root);
    return out.sort((a, b) => a.d.valueOf() - b.d.valueOf());
  }

  async ensureFolder() {
    const f = this.folder();
    if (!f) return;
    let acc = '';
    for (const part of f.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(acc)) {
        try {
          await this.app.vault.createFolder(acc);
        } catch {
          // created meanwhile
        }
      }
    }
  }

  async buildNote(m) {
    const tp = String(this.settings.templatePath || '').trim();
    if (tp) {
      const file = this.getFile(normalizePath(tp.endsWith('.md') ? tp : `${tp}.md`));
      if (file) {
        const raw = await this.app.vault.read(file);
        return raw
          .replace(/\{\{date\}\}/g, m.format(DATE_FMT))
          .replace(/\{\{title\}\}/g, m.format('dddd D MMMM YYYY'));
      }
      new Notice(`Template "${tp}" not found. Using the default page.`);
    }
    return buildDailyNote(m);
  }

  async ensureNote(m) {
    const path = this.notePath(m);
    const existing = this.getFile(path);
    if (existing) return existing;
    await this.ensureFolder();
    const content = await this.buildNote(m);
    try {
      return await this.app.vault.create(path, content);
    } catch (e) {
      const f = this.getFile(path);
      if (f) return f;
      console.error(e);
      new Notice(`Could not create ${path}.`);
      return null;
    }
  }

  async openToday() {
    const file = await this.ensureNote(moment());
    if (file) await this.openFile(file);
  }

  async openFile(file) {
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.view && leaf.view.file && leaf.view.file.path === file.path) found = leaf;
    });
    if (found) {
      this.app.workspace.setActiveLeaf(found, { focus: true });
      if (this.app.workspace.revealLeaf) await this.app.workspace.revealLeaf(found);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async openPath(path) {
    const f = this.getFile(path);
    if (f) await this.openFile(f);
  }

  checkDayChange() {
    const d = todayStr();
    if (d === this.currentDay) return;
    this.currentDay = d;
    if (this.settings.autoCreate) this.ensureNote(moment());
    // "Today" moved: update banners and button labels on pages that are already open.
    this.refreshLive(true);
  }

  // writing

  /** Runs `fn(board)` on the board block of `path`. `fn` returns false to abort. */
  async editBoard(path, fn) {
    const file = this.getFile(path);
    if (!file) return false;
    let ok = true;
    let missing = false;
    await this.app.vault.process(file, (content) => {
      const body = getBlockBody(content, BLOCK.board);
      if (body == null) {
        ok = false;
        missing = true;
        return content;
      }
      const board = parseBoard(body);
      if (fn(board) === false) {
        ok = false;
        return content;
      }
      return replaceBlockBody(content, BLOCK.board, serializeBoard(board));
    });
    if (missing) new Notice(`No task board found in ${file.basename}.`);
    else if (!ok) new Notice('The board changed elsewhere, so nothing was saved. Try again.');
    return ok;
  }

  checkCard(board, idx, key) {
    const c = board.cards[idx];
    return c && cardKey(c) === key ? c : null;
  }

  moveCard(path, idx, key, { lane, category, before }) {
    return this.editBoard(path, (b) => {
      const c = this.checkCard(b, idx, key);
      if (!c) return false;
      c.status = laneChar(lane, c.status);
      c.category = category;
      if (!b.categories.includes(category)) b.categories.push(category);
      if (before === idx) return true;
      b.cards.splice(idx, 1);
      const at = before == null ? b.cards.length : before > idx ? before - 1 : before;
      b.cards.splice(at, 0, c);
      return true;
    });
  }

  setCardStatus(path, idx, key, ch) {
    return this.editBoard(path, (b) => {
      const c = this.checkCard(b, idx, key);
      if (!c) return false;
      c.status = ch;
      return true;
    });
  }

  addCard(path, category, text, since) {
    return this.editBoard(path, (b) => {
      if (!b.categories.includes(category)) b.categories.push(category);
      b.cards.push({ status: ' ', text, since: since || null, category });
      return true;
    });
  }

  async addCategory(path, name) {
    this.refocus = { path, cat: name };
    this.forceShown.add(`${path}::${name}`);
    let existed = false;
    const ok = await this.editBoard(path, (b) => {
      existed = b.categories.includes(name);
      if (!existed) b.categories.push(name);
      return true;
    });
    // An existing category leaves the file unchanged, so Obsidian won't re-render the block.
    if (ok && existed) await this.redrawBoards(path);
    return ok;
  }

  async redrawBoards(path) {
    const f = this.getFile(path);
    const body = f ? getBlockBody(await this.app.vault.cachedRead(f), BLOCK.board) : null;
    if (body == null) return;
    for (const v of this.boardViews) if (v.path === path && v.root.isConnected) v.draw(body);
  }

  async modifyLine(path, idx, expected, replacement) {
    const file = this.getFile(path);
    if (!file) return false;
    let ok = true;
    await this.app.vault.process(file, (content) => {
      const lines = content.split('\n');
      let k = idx;
      if (lines[k] !== expected) {
        // The line moved. Follow it only if its text is unique; never pick between copies.
        const hits = lines.flatMap((l, i) => (l === expected ? [i] : []));
        k = hits.length === 1 ? hits[0] : -1;
      }
      if (k < 0) {
        ok = false;
        return content;
      }
      lines[k] = replacement;
      return lines.join('\n');
    });
    if (!ok) new Notice('That note changed elsewhere, so nothing was saved. Try again.');
    return ok;
  }

  // reading

  async collectLeftBehind(date) {
    const out = [];
    for (const { f, d } of this.dailyNotes()) {
      if (!d.isBefore(date, 'day')) continue;
      const body = getBlockBody(await this.app.vault.cachedRead(f), BLOCK.board);
      if (body == null) continue;
      parseBoard(body).cards.forEach((c, i) => {
        if (!isOpen(c.status)) return;
        const origin = c.since || d.format(DATE_FMT);
        const age = Math.max(1, date.clone().startOf('day').diff(moment(origin, DATE_FMT), 'days'));
        out.push({ path: f.path, date: d, idx: i, key: cardKey(c), card: c, origin, age });
      });
    }
    return out;
  }

  async collectPending(date) {
    const out = [];
    for (const { f, d } of this.dailyNotes()) {
      if (!d.isBefore(date, 'day')) continue;
      for (const it of pendingNotes(await this.app.vault.cachedRead(f))) {
        out.push(Object.assign(it, { path: f.path, date: d }));
      }
    }
    return out;
  }

  async boardCategories(path) {
    const f = this.getFile(path);
    const body = f ? getBlockBody(await this.app.vault.cachedRead(f), BLOCK.board) : null;
    const own = body != null ? visibleCategories(parseBoard(body)) : [];
    return [...new Set([...own, ...this.settings.categories])];
  }

  // actions on previous days

  async carryTo(targetPath, it) {
    const ok = await this.editBoard(targetPath, (b) => {
      const cat = it.card.category;
      if (!b.categories.includes(cat)) b.categories.push(cat);
      b.cards.push({
        status: laneOf(it.card.status) === 'doing' ? '/' : ' ',
        text: it.card.text,
        since: it.origin,
        category: cat,
      });
      return true;
    });
    if (!ok) return false;
    return this.setCardStatus(it.path, it.idx, it.key, '>');
  }

  resolvePending(it) {
    return this.modifyLine(it.path, it.line, it.raw, resolveLine(it.raw));
  }

  async pendingToNotes(targetPath, it) {
    const file = this.getFile(targetPath);
    if (!file) return false;
    const line = `- ${it.text}`;
    await this.app.vault.process(
      file,
      (c) =>
        insertIntoSection(c, TODAY_NOTES_RE, line) ||
        insertIntoSection(addNoteSection(c, 'today').content, TODAY_NOTES_RE, line)
    );
    return this.resolvePending(it);
  }

  /** Adds a note section (see addNoteSection) and puts the cursor in it. */
  async addNote(path, kindId, title) {
    const file = this.getFile(path);
    if (!file) return;
    let line = 0;
    await this.app.vault.process(file, (c) => {
      const r = addNoteSection(c, kindId, title);
      line = r.line;
      return r.content;
    });
    this.focusLine(path, line);
  }

  focusLine(path, line) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file || view.file.path !== path || view.getMode() !== 'source') return;
    // Give the editor a moment to pick up the change from process() first.
    window.setTimeout(() => {
      if (line >= view.editor.lineCount()) return;
      view.editor.setCursor({ line, ch: view.editor.getLine(line).length });
      view.editor.focus();
    }, 50);
  }

  laneColorProps() {
    const props = {};
    for (const l of LANES) props[`--sl-${l.id}`] = this.settings.laneColors[l.id] || '';
    return props;
  }

  applyLaneColors() {
    for (const v of this.boardViews) v.root.setCssProps(this.laneColorProps());
  }

  async pendingToTask(targetPath, it, category) {
    const ok = await this.addCard(targetPath, category, it.text, null);
    if (!ok) return false;
    return this.resolvePending(it);
  }

  // live refresh

  /** `path` is the daily note that changed. Live blocks only read earlier days, so views of
   * that day or before are skipped: typing in today's note doesn't rescan the whole journal. */
  scheduleRefresh(path) {
    const d = this.dateOfPath(path);
    if (d && (!this.changedFrom || d.isBefore(this.changedFrom))) this.changedFrom = d;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      const from = this.changedFrom;
      this.changedFrom = null;
      this.refreshLive(false, from);
    }, 400);
  }

  refreshLive(force, changedFrom) {
    for (const v of this.liveViews) {
      if (!v.root.isConnected) continue;
      if (changedFrom && v.date && !v.date.isAfter(changedFrom, 'day')) continue;
      v.refresh(force);
    }
  }

  // misc UI

  wireLinks(root, sourcePath) {
    root.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a.internal-link') : null;
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const target = a.getAttribute('data-href') || a.getAttribute('href');
      if (target) this.app.workspace.openLinkText(target, sourcePath, e.ctrlKey || e.metaKey);
    });
  }

  renderMd(text, el, sourcePath, comp) {
    el.classList.add('sl-md');
    MarkdownRenderer.render(this.app, text, el, sourcePath, comp).catch((e) => {
      console.error('Studiolo: could not render card text', e);
      el.textContent = text;
    });
  }

  categoryPicker(evt, options, onPick) {
    const menu = new Menu();
    for (const c of options) menu.addItem((i) => i.setTitle(c).onClick(() => onPick(c)));
    if (options.length) menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle('New category...').onClick(() => new PromptModal(this.app, 'New category', '', onPick).open())
    );
    menu.showAtMouseEvent(evt);
  }

  askNotificationPermission() {
    try {
      if (
        this.settings.systemNotification &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'default'
      ) {
        Notification.requestPermission();
      }
    } catch {
      // not available on this platform
    }
  }

  notify(title, body) {
    new Notice(`${title}\n${body}`, 10000);
    if (this.settings.sound) this.beep();
    try {
      if (
        this.settings.systemNotification &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        new Notification(title, { body });
      }
    } catch {
      // not available on this platform
    }
  }

  beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      [0, 0.35, 0.7].forEach((t) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.3);
      });
      window.setTimeout(() => ctx.close(), 1500);
    } catch {
      // audio not available
    }
  }

  onTick() {
    this.timer.tick();
    this.updateTimerViews();
  }

  updateTimerViews() {
    for (const v of this.timerViews) if (v.root.isConnected) v.update();
    if (this.statusEl) this.statusEl.textContent = this.timer.statusText();
  }

  // Renderers

  // navigation

  renderNav(el, ctx) {
    const path = ctx.sourcePath;
    const date = this.dateOfPath(path);
    const root = h('div', 'sl-nav');
    el.appendChild(root);
    if (!date) {
      root.appendChild(h('span', 'sl-muted', 'Name this note by date, for example 2026-10-19, to use it as a daily page.'));
      return;
    }
    const comp = new MarkdownRenderChild(root);
    ctx.addChild(comp);
    // No `date` on the view: neighbours can change whenever any daily note is created or deleted.
    const view = {
      root,
      sig: null,
      refresh: () => {
        const notes = this.dailyNotes();
        const prev = notes.filter((n) => n.d.isBefore(date, 'day')).pop();
        const next = notes.find((n) => n.d.isAfter(date, 'day'));
        const isToday = date.isSame(moment(), 'day');
        const sig = [prev && prev.f.path, next && next.f.path, isToday].join('|');
        if (sig === view.sig) return;
        view.sig = sig;
        this.drawNav(root, date, prev, next, isToday);
      },
    };
    this.liveViews.add(view);
    comp.register(() => this.liveViews.delete(view));
    view.refresh();
  }

  drawNav(root, date, prev, next, isToday) {
    root.replaceChildren();
    const row = h('div', 'sl-nav-row');
    row.appendChild(
      button(prev ? `← ${prev.d.format('ddd D MMM')}` : 'No earlier days', {
        cls: 'sl-small',
        disabled: !prev,
        onClick: () => prev && this.openFile(prev.f),
      })
    );
    row.appendChild(button('Today', { cls: 'sl-small mod-cta', onClick: () => this.openToday() }));
    row.appendChild(
      button(next ? `${next.d.format('ddd D MMM')} →` : 'No later days', {
        cls: 'sl-small',
        disabled: !next,
        onClick: () => next && this.openFile(next.f),
      })
    );
    root.appendChild(row);

    if (!isToday) {
      const banner = h('div', 'sl-banner');
      banner.appendChild(h('span', null, `You're looking at ${date.format('dddd D MMMM YYYY')}.`));
      banner.appendChild(button('Go to today', { cls: 'sl-small', onClick: () => this.openToday() }));
      root.appendChild(banner);
    }
  }

  // timer

  renderTimer(el, ctx) {
    const t = this.timer;
    const root = h('div', 'sl-timer');
    el.appendChild(root);
    const comp = new MarkdownRenderChild(root);
    ctx.addChild(comp);

    const tabs = h('div', 'sl-tabs');
    const modes = [
      ['pomodoro', 'Pomodoro'],
      ['countdown', 'Timer'],
      ['stopwatch', 'Stopwatch'],
    ];
    const tabBtns = modes.map(([m, label]) => {
      const b = button(label, { cls: 'sl-tab', onClick: () => t.setMode(m) });
      tabs.appendChild(b);
      return [m, b];
    });
    root.appendChild(tabs);

    const main = h('div', 'sl-timer-main');
    const readout = h('div', 'sl-timer-readout');
    const label = h('div', 'sl-timer-label');
    const time = h('div', 'sl-timer-time');
    readout.append(label, time);
    const controls = h('div', 'sl-timer-controls');
    const startBtn = button(null, { cls: 'mod-cta sl-start', icon: 'play', title: 'Start', onClick: () => t.toggle() });
    const resetBtn = button(null, { cls: 'sl-icon', icon: 'rotate-ccw', title: 'Reset', onClick: () => t.reset() });
    const skipBtn = button(null, { cls: 'sl-icon', icon: 'skip-forward', title: 'Skip to the next phase', onClick: () => t.skip() });
    const restartBtn = button(null, {
      cls: 'sl-icon',
      icon: 'timer-reset',
      title: 'Restart the cycle from the first focus session',
      onClick: () => t.restartCycle(),
    });
    controls.append(startBtn, resetBtn, skipBtn, restartBtn);
    main.append(readout, controls);
    root.appendChild(main);

    const bar = h('div', 'sl-progress');
    const fill = h('div', 'sl-progress-fill');
    bar.appendChild(fill);
    root.appendChild(bar);

    const setter = h('div', 'sl-timer-setter');
    const input = h('input', 'sl-minutes');
    input.type = 'number';
    input.min = '1';
    input.max = '1440';
    input.addEventListener('change', () => t.setCountdown(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        t.setCountdown(input.value);
        t.start();
      }
    });
    setter.append(input, h('span', 'sl-muted', 'min'));
    for (const p of [5, 10, 15, 25, 45, 60]) {
      setter.appendChild(button(`${p}`, { cls: 'sl-chip', onClick: () => t.setCountdown(p) }));
    }
    root.appendChild(setter);

    const foot = h('div', 'sl-timer-foot sl-muted');
    root.appendChild(foot);

    let shownIcon = 'play';
    const view = {
      root,
      update: () => {
        const s = t.s;
        const icon = s.running ? 'pause' : 'play';
        if (icon !== shownIcon) {
          setIcon(startBtn.firstChild, icon);
          shownIcon = icon;
        }
        startBtn.setAttribute('aria-label', s.running ? 'Pause' : t.isIdle() ? 'Start' : 'Resume');
        resetBtn.setAttribute('aria-label', s.mode === 'pomodoro' ? 'Restart this phase' : 'Reset');
        root.dataset.mode = s.mode;
        root.dataset.phase = s.mode === 'pomodoro' ? s.phase : s.mode;
        root.classList.toggle('is-running', s.running);
        for (const [m, b] of tabBtns) b.classList.toggle('is-active', m === s.mode);
        label.textContent = t.phaseLabel();
        time.textContent = fmtDuration(t.displayMs(), s.mode !== 'stopwatch');
        bar.classList.toggle('sl-hidden', s.mode === 'stopwatch');
        fill.setCssProps({ '--sl-progress': `${Math.round(t.progress() * 1000) / 10}%` });
        setter.classList.toggle('sl-hidden', s.mode !== 'countdown' || s.running);
        if (input.ownerDocument.activeElement !== input) input.value = String(s.countdownMin);
        skipBtn.classList.toggle('sl-hidden', s.mode !== 'pomodoro');
        restartBtn.classList.toggle('sl-hidden', s.mode !== 'pomodoro');
        const n = t.todayCount();
        foot.textContent = n ? `${n} pomodoro${n === 1 ? '' : 's'} today` : '';
      },
    };
    this.timerViews.add(view);
    comp.register(() => this.timerViews.delete(view));
    view.update();
  }

  // board

  renderBoard(source, el, ctx) {
    const path = ctx.sourcePath;
    const planBar = h('div', 'sl-plan-bar');
    const root = h('div', 'sl-board');
    root.setCssProps(this.laneColorProps());
    el.append(planBar, root);
    const comp = new MarkdownRenderChild(root);
    ctx.addChild(comp);
    this.wireLinks(root, path);
    if (this.dateOfPath(path)) this.watchNoteKinds(planBar, path, comp, (missing) => this.drawPlanBar(planBar, path, missing));
    const view = {
      root,
      path,
      dc: null,
      draw: (src) => {
        if (view.dc) comp.removeChild(view.dc);
        view.dc = comp.addChild(new MarkdownRenderChild(root));
        root.replaceChildren();
        this.drawBoard(root, src, path, view.dc);
      },
    };
    this.boardViews.add(view);
    comp.register(() => this.boardViews.delete(view));
    view.draw(source);
  }

  drawBoard(root, source, path, comp) {
    const noteDate = this.dateOfPath(path);
    const board = parseBoard(source);
    const forced = board.categories.filter((c) => this.forceShown.has(`${path}::${c}`));
    const cats = visibleCategories(board, forced);

    if (!cats.length) {
      const empty = h('div', 'sl-empty');
      empty.appendChild(h('div', null, 'No tasks yet. Pick a category to start.'));
      const row = h('div', 'sl-chip-row');
      for (const cat of this.settings.categories) {
        row.appendChild(button(cat, { cls: 'sl-chip', onClick: () => this.addCategory(path, cat) }));
      }
      row.appendChild(
        button('Other...', {
          cls: 'sl-chip',
          onClick: () =>
            new PromptModal(this.app, 'New category', '', (name) => this.addCategory(path, name)).open(),
        })
      );
      empty.appendChild(row);
      root.appendChild(empty);
    } else {
      for (const cat of cats) root.appendChild(this.renderCategory(board, cats, cat, path, noteDate, comp));
    }

    const foot = h('div', 'sl-board-foot');
    if (cats.length) {
      foot.appendChild(
        button('Add category', {
          cls: 'sl-small',
          onClick: (e) =>
            this.categoryPicker(
              e,
              this.settings.categories.filter((c) => !cats.includes(c)),
              (name) => this.addCategory(path, name)
            ),
        })
      );
    }
    const archived = board.cards.filter((c) => laneOf(c.status) === 'archived').length;
    if (archived) foot.appendChild(h('span', 'sl-muted', `${archived} archived`));
    if (foot.childNodes.length) root.appendChild(foot);

    if (this.refocus && this.refocus.path === path) {
      const wanted = this.refocus.cat;
      this.refocus = null;
      const inp = Array.from(root.querySelectorAll('input.sl-add')).find((i) => i.dataset.cat === wanted);
      if (inp) window.setTimeout(() => inp.focus(), 0);
    }
  }

  renderCategory(board, cats, cat, path, noteDate, comp) {
    const key = `${path}::${cat}`;
    const entries = board.cards.map((c, i) => ({ c, i })).filter((x) => x.c.category === cat);
    const open = entries.filter((x) => isOpen(x.c.status)).length;
    const done = entries.filter((x) => laneOf(x.c.status) === 'done').length;

    const row = h('div', 'sl-cat');
    row.setCssProps({ '--sl-cat': catColor(cat) });
    if (this.collapsed.has(key)) row.classList.add('is-collapsed');

    const head = h('div', 'sl-cat-head');
    const toggle = button(null, {
      cls: 'sl-icon',
      title: 'Collapse or expand',
      icon: row.classList.contains('is-collapsed') ? 'chevron-right' : 'chevron-down',
      onClick: () => {
        const c = row.classList.toggle('is-collapsed');
        if (c) this.collapsed.add(key);
        else this.collapsed.delete(key);
        setIcon(toggle.firstChild, c ? 'chevron-right' : 'chevron-down');
      },
    });
    head.append(toggle, h('span', 'sl-dot'), h('span', 'sl-cat-name', cat));
    head.appendChild(h('span', 'sl-muted', `${open} open, ${done} done`));
    head.appendChild(h('span', 'sl-spacer'));
    head.appendChild(
      button(null, {
        cls: 'sl-icon',
        icon: 'more-horizontal',
        title: 'Category actions',
        onClick: (e) => this.categoryMenu(e, path, cat, entries, !!board.extra[cat]),
      })
    );
    row.appendChild(head);

    const lanes = h('div', 'sl-lanes');
    for (const lane of LANES) {
      const inLane = entries.filter((x) => laneOf(x.c.status) === lane.id);
      lanes.appendChild(this.renderLane(lane, cat, cats, inLane, path, noteDate, comp));
    }
    row.appendChild(lanes);
    return row;
  }

  renderLane(lane, cat, cats, entries, path, noteDate, comp) {
    const laneEl = h('div', `sl-lane sl-lane-${lane.id}`);
    const head = h('div', 'sl-lane-head', lane.label);
    if (entries.length) head.appendChild(h('span', 'sl-lane-count', String(entries.length)));
    laneEl.appendChild(head);
    const list = h('div', 'sl-lane-list');
    for (const { c, i } of entries) list.appendChild(this.renderCard(c, i, cats, path, noteDate, comp));
    laneEl.appendChild(list);

    if (lane.id === 'todo') {
      const inp = h('input', 'sl-add');
      inp.type = 'text';
      inp.placeholder = 'Add a task';
      inp.dataset.cat = cat;
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        const v = inp.value.replace(/\s*\n\s*/g, ' ').trim();
        if (!v) return;
        inp.value = '';
        this.refocus = { path, cat };
        this.addCard(path, cat, v, null);
      });
      laneEl.appendChild(inp);
    }

    const clearMarks = () => {
      laneEl.classList.remove('sl-over');
      laneEl.querySelectorAll('.sl-drop-before').forEach((n) => n.classList.remove('sl-drop-before'));
    };
    laneEl.addEventListener('dragover', (e) => {
      if (!this.drag || this.drag.path !== path) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      laneEl.classList.add('sl-over');
      laneEl.querySelectorAll('.sl-drop-before').forEach((n) => n.classList.remove('sl-drop-before'));
      const target = e.target && e.target.closest ? e.target.closest('.sl-card') : null;
      if (target && laneEl.contains(target)) target.classList.add('sl-drop-before');
    });
    laneEl.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !laneEl.contains(e.relatedTarget)) clearMarks();
    });
    laneEl.addEventListener('drop', (e) => {
      if (!this.drag || this.drag.path !== path) return;
      e.preventDefault();
      e.stopPropagation();
      clearMarks();
      const target = e.target && e.target.closest ? e.target.closest('.sl-card') : null;
      const before = target && laneEl.contains(target) ? Number(target.dataset.idx) : null;
      const { idx, key } = this.drag;
      this.drag = null;
      this.moveCard(path, idx, key, { lane: lane.id, category: cat, before });
    });
    return laneEl;
  }

  renderCard(c, i, cats, path, noteDate, comp) {
    const lane = laneOf(c.status);
    const key = cardKey(c);
    const card = h('div', `sl-card sl-card-${lane}`);
    card.dataset.idx = String(i);
    card.draggable = true;

    const cb = h('input', 'sl-check');
    cb.type = 'checkbox';
    cb.checked = lane === 'done';
    cb.title = lane === 'done' ? 'Mark as not done' : 'Mark as done';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () =>
      this.moveCard(path, i, key, { lane: cb.checked ? 'done' : 'todo', category: c.category, before: i })
    );
    card.appendChild(cb);

    const text = h('div', 'sl-card-text');
    this.renderMd(c.text, text, path, comp);
    card.appendChild(text);

    if (c.since && noteDate) {
      const age = noteDate.diff(moment(c.since, DATE_FMT), 'days');
      if (age > 0) card.appendChild(ageBadge(age, `Open since ${c.since}`));
    }

    card.appendChild(
      button(null, {
        cls: 'sl-icon sl-card-more',
        icon: 'more-horizontal',
        title: 'Task actions',
        onClick: (e) => this.cardMenu(e, path, i, c, cats),
      })
    );
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cardMenu(e, path, i, c, cats);
    });
    card.addEventListener('dragstart', (e) => {
      this.drag = { path, idx: i, key };
      if (e.dataTransfer) {
        e.dataTransfer.setData(DRAG_MIME, String(i));
        e.dataTransfer.effectAllowed = 'move';
      }
      card.classList.add('is-dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      window.setTimeout(() => {
        this.drag = null;
      }, 0);
    });
    return card;
  }

  cardMenu(evt, path, i, c, cats) {
    const key = cardKey(c);
    const lane = laneOf(c.status);
    const menu = new Menu();
    for (const l of LANES) {
      if (l.id === lane) continue;
      menu.addItem((it) =>
        it.setTitle(`Move to ${l.label}`).onClick(() =>
          this.moveCard(path, i, key, { lane: l.id, category: c.category, before: null })
        )
      );
    }
    menu.addSeparator();
    menu.addItem((it) =>
      it.setTitle('Change category...').onClick(() =>
        this.categoryPicker(
          evt,
          [...new Set([...cats, ...this.settings.categories])].filter((x) => x !== c.category),
          (name) => this.moveCard(path, i, key, { lane, category: name, before: null })
        )
      )
    );
    menu.addItem((it) =>
      it.setTitle('Edit...').onClick(() =>
        new PromptModal(this.app, 'Edit task', c.text, (v) =>
          this.editBoard(path, (b) => {
            const x = this.checkCard(b, i, key);
            if (!x) return false;
            x.text = v;
            return true;
          })
        ).open()
      )
    );
    menu.addSeparator();
    menu.addItem((it) => it.setTitle('Archive').onClick(() => this.setCardStatus(path, i, key, '-')));
    menu.addItem((it) =>
      it.setTitle('Delete').onClick(() =>
        this.editBoard(path, (b) => {
          if (!this.checkCard(b, i, key)) return false;
          b.cards.splice(i, 1);
          return true;
        })
      )
    );
    menu.showAtMouseEvent(evt);
  }

  categoryMenu(evt, path, cat, entries, hasExtraLines) {
    const menu = new Menu();
    menu.addItem((it) =>
      it.setTitle('Rename...').onClick(() =>
        new PromptModal(this.app, 'Rename category', cat, (name) =>
          this.editBoard(path, (b) => {
            if (name === cat) return true;
            b.categories = b.categories.map((x) => (x === cat ? name : x)).filter((x, i, a) => a.indexOf(x) === i);
            for (const c of b.cards) if (c.category === cat) c.category = name;
            if (b.extra[cat]) {
              b.extra[name] = (b.extra[name] || []).concat(b.extra[cat]);
              delete b.extra[cat];
            }
            return true;
          })
        ).open()
      )
    );
    const doneCount = entries.filter((x) => laneOf(x.c.status) === 'done').length;
    if (doneCount) {
      menu.addItem((it) =>
        it.setTitle(`Archive done tasks (${doneCount})`).onClick(() =>
          this.editBoard(path, (b) => {
            for (const c of b.cards) if (c.category === cat && laneOf(c.status) === 'done') c.status = '-';
            return true;
          })
        )
      );
    }
    // Only an empty category can be removed: it must hold no cards (archived and moved ones are
    // the history of that day) and no hand-written lines.
    if (!entries.length && !hasExtraLines) {
      menu.addItem((it) =>
        it.setTitle('Remove category').onClick(() =>
          this.editBoard(path, (b) => {
            if (b.cards.some((c) => c.category === cat) || b.extra[cat]) return false;
            b.categories = b.categories.filter((x) => x !== cat);
            return true;
          })
        )
      );
    }
    menu.showAtMouseEvent(evt);
  }

  // note slots: buttons that add the note sections a page doesn't have yet. Brainstorm has its
  // slot at the top of the board, where it will appear; the others are in the notes bar.

  /** Calls `draw(missingKinds)` now and whenever the set of missing note sections changes. */
  watchNoteKinds(root, path, comp, draw) {
    // No `date`: this view reads its own page, so every change to it can matter.
    const view = {
      root,
      sig: null,
      gen: 0,
      refresh: async () => {
        const gen = ++view.gen;
        const f = this.getFile(path);
        const present = f ? noteSections(await this.app.vault.cachedRead(f)).map((s) => s.kind) : [];
        if (gen !== view.gen) return;
        const missing = NOTE_KINDS.filter((k) => !present.includes(k.id));
        const sig = missing.map((k) => k.id).join();
        if (sig === view.sig) return;
        view.sig = sig;
        draw(missing);
      },
    };
    this.liveViews.add(view);
    comp.register(() => this.liveViews.delete(view));
    view.refresh();
  }

  renderNotesBar(el, ctx) {
    const path = ctx.sourcePath;
    const root = h('div', 'sl-notes-bar');
    el.appendChild(root);
    if (!this.dateOfPath(path)) {
      root.appendChild(h('span', 'sl-muted', 'This block only works in a daily page named by date, for example 2026-10-19.'));
      return;
    }
    const comp = new MarkdownRenderChild(root);
    ctx.addChild(comp);
    this.watchNoteKinds(root, path, comp, (missing) => this.drawNotesBar(root, path, missing));
  }

  drawNotesBar(root, path, missing) {
    root.replaceChildren();
    root.appendChild(h('span', 'sl-notes-bar-label', 'Add a note'));
    const icons = { today: 'pencil', evening: 'sunset', next: 'forward' };
    for (const k of missing) {
      if (k.id === 'brainstorm') continue;
      root.appendChild(button(k.title, { cls: 'sl-slot', icon: icons[k.id], onClick: () => this.addNote(path, k.id) }));
    }
    root.appendChild(
      button('Other...', {
        cls: 'sl-slot',
        icon: 'plus',
        onClick: () => new PromptModal(this.app, 'Note title', '', (title) => this.addNote(path, 'other', title)).open(),
      })
    );
  }

  drawPlanBar(root, path, missing) {
    root.replaceChildren();
    if (!missing.some((k) => k.id === 'brainstorm')) return;
    root.appendChild(
      button('Brainstorm first', {
        cls: 'sl-slot',
        icon: 'lightbulb',
        title: 'Add a brainstorm section here, above the tasks',
        onClick: () => this.addNote(path, 'brainstorm'),
      })
    );
  }

  // removing note sections: an X in the title of every Studiolo callout

  decorateCallouts(el, ctx) {
    if (!this.isJournalPath(ctx.sourcePath)) return;
    const callouts = el.matches && el.matches('.callout') ? [el] : el.querySelectorAll('.callout');
    for (const co of callouts) {
      const type = co.getAttribute('data-callout') || '';
      const title = co.querySelector('.callout-title');
      const inner = co.querySelector('.callout-title-inner');
      if (!type.startsWith('studiolo-') || !title || !inner || title.querySelector('.sl-callout-remove')) continue;
      const text = inner.textContent.trim();
      const x = button(null, {
        // interactive-child keeps Live Preview from moving the cursor into the callout on click.
        cls: 'sl-icon sl-callout-remove interactive-child',
        icon: 'x',
        title: `Remove "${text}"`,
        onClick: () => this.removeNote(ctx.sourcePath, type, text),
      });
      title.appendChild(x);
    }
  }

  /** Removes a note callout. Asks first unless it's empty; never touches anything else. */
  async removeNote(path, type, title) {
    const file = this.getFile(path);
    if (!file) return false;
    const lines = (await this.app.vault.cachedRead(file)).split('\n');
    const sec = findCallout(lines, type, title);
    if (!sec) {
      new Notice(`Couldn't find "${title}" in this page. It may have been changed or removed already.`);
      return false;
    }
    const remove = async () => {
      let ok = false;
      await this.app.vault.process(file, (content) => {
        const fresh = findCallout(content.split('\n'), type, title);
        if (!fresh) return content;
        ok = true;
        return removeSection(content, fresh);
      });
      if (!ok) new Notice('That note changed elsewhere, so nothing was saved. Try again.');
      return ok;
    };
    if (sectionIsEmpty(lines, sec)) return remove();
    return new Promise((resolve) => {
      new ConfirmModal(
        this.app,
        `Remove "${title}"?`,
        'The section and everything written in it will be deleted from this page.',
        'Remove',
        () => resolve(remove())
      ).open();
    });
  }

  // live blocks: left behind, from previous days

  /** One section with its own title holding both lists; hidden entirely while both are empty. */
  renderCatchup(el, ctx) {
    const section = h('div', 'sl-section sl-catchup');
    section.appendChild(h('div', 'sl-section-title', 'Catch up'));
    el.appendChild(section);
    const empty = {};
    const onDraw = (kind, n) => {
      empty[kind] = n === 0;
      section.classList.toggle('sl-hidden', empty.carryover !== false && empty.previous !== false);
    };
    this.renderLive(section, ctx, 'carryover', onDraw);
    this.renderLive(section, ctx, 'previous', onDraw);
  }

  /** `onDraw(kind, itemCount)` is called after every redraw. */
  renderLive(el, ctx, kind, onDraw) {
    const path = ctx.sourcePath;
    const date = this.dateOfPath(path);
    const root = h('div', `sl-live sl-${kind}`);
    el.appendChild(root);
    const comp = new MarkdownRenderChild(root);
    ctx.addChild(comp);
    this.wireLinks(root, path);
    if (!date) {
      root.appendChild(h('div', 'sl-muted', 'This block only works in a daily page named by date, for example 2026-10-19.'));
      return;
    }
    const view = {
      root,
      date,
      sig: null,
      dc: null,
      busy: false,
      gen: 0,
      refresh: async (force) => {
        // Refreshes can overlap (vault event + own action). Only the latest one may draw,
        // or an older scan could paint items that were already handled.
        const gen = ++view.gen;
        const items = kind === 'carryover' ? await this.collectLeftBehind(date) : await this.collectPending(date);
        if (gen !== view.gen) return;
        const sig = JSON.stringify(
          items.map((x) => [x.path, x.idx != null ? x.idx : x.line, x.raw || cardLine(x.card), x.card ? x.card.category : ''])
        );
        if (!force && sig === view.sig) return;
        view.sig = sig;
        if (view.dc) comp.removeChild(view.dc);
        view.dc = comp.addChild(new MarkdownRenderChild(root));
        if (kind === 'carryover') this.drawCarryover(root, items, path, date, view);
        else this.drawPrevious(root, items, path, date, view);
        root.classList.toggle('is-empty', !items.length);
        if (onDraw) onDraw(kind, items.length);
      },
    };
    this.liveViews.add(view);
    comp.register(() => this.liveViews.delete(view));
    view.refresh(true);
  }

  /** Runs an action from a live block, preventing double clicks. */
  async runLive(view, fn) {
    if (view.busy) return;
    view.busy = true;
    view.root.classList.add('is-busy');
    try {
      await fn();
    } finally {
      view.busy = false;
      view.root.classList.remove('is-busy');
      this.refreshLive(true);
    }
  }

  drawCarryover(root, items, path, date, view) {
    root.replaceChildren();
    if (!items.length) {
      root.appendChild(h('div', 'sl-empty sl-ok', 'Nothing left behind.'));
      return;
    }
    const isToday = date.isSame(moment(), 'day');
    const here = isToday ? 'today' : 'this day';

    const head = h('div', 'sl-live-head');
    head.appendChild(
      h('span', 'sl-muted', `${items.length} unfinished task${items.length === 1 ? '' : 's'} from previous days, oldest first`)
    );
    head.appendChild(h('span', 'sl-spacer'));
    head.appendChild(
      button(`Move all to ${here}`, {
        cls: 'sl-small mod-cta',
        onClick: () =>
          this.runLive(view, async () => {
            for (const it of items) await this.carryTo(path, it);
          }),
      })
    );
    root.appendChild(head);

    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.card.category)) groups.set(it.card.category, []);
      groups.get(it.card.category).push(it);
    }
    const sorted = [...groups.entries()].sort(
      (a, b) => Math.max(...b[1].map((x) => x.age)) - Math.max(...a[1].map((x) => x.age))
    );

    for (const [cat, list] of sorted) {
      const g = h('div', 'sl-group');
      g.setCssProps({ '--sl-cat': catColor(cat) });
      const gh = h('div', 'sl-group-head');
      gh.append(h('span', 'sl-dot'), h('span', 'sl-cat-name', cat), h('span', 'sl-muted', String(list.length)));
      g.appendChild(gh);

      list.sort((a, b) => b.age - a.age);
      for (const it of list) {
        const row = h('div', `sl-item sl-urgency-row-${urgencyLevel(it.age)}`);
        row.appendChild(ageBadge(it.age, `Open since ${it.origin}`));
        const t = h('div', 'sl-item-text');
        this.renderMd(it.card.text, t, path, view.dc);
        if (laneOf(it.card.status) === 'doing') t.prepend(h('span', 'sl-tag', 'doing'));
        row.appendChild(t);

        const src = h('a', 'sl-src', it.date.format('ddd D MMM'));
        src.href = '#';
        src.title = 'Open that day';
        src.addEventListener('click', (e) => {
          e.preventDefault();
          this.openPath(it.path);
        });
        row.appendChild(src);

        const acts = h('div', 'sl-actions');
        acts.append(
          button(isToday ? 'Move to today' : 'Move here', {
            cls: 'sl-small',
            title: `Move it to ${here}'s board`,
            onClick: () => this.runLive(view, () => this.carryTo(path, it)),
          }),
          button('Done', {
            cls: 'sl-small',
            title: 'It was done that day',
            onClick: () => this.runLive(view, () => this.setCardStatus(it.path, it.idx, it.key, 'x')),
          }),
          button('Archive', {
            cls: 'sl-small',
            title: 'Stop tracking it. It stays in the old page as archived.',
            onClick: () => this.runLive(view, () => this.setCardStatus(it.path, it.idx, it.key, '-')),
          })
        );
        row.appendChild(acts);
        g.appendChild(row);
      }
      root.appendChild(g);
    }
  }

  drawPrevious(root, items, path, date, view) {
    root.replaceChildren();
    if (!items.length) {
      root.appendChild(h('div', 'sl-empty sl-ok', 'Nothing pending from previous days.'));
      return;
    }
    const head = h('div', 'sl-live-head');
    head.appendChild(
      h('span', 'sl-muted', `${items.length} note${items.length === 1 ? '' : 's'} you left for the next days`)
    );
    head.appendChild(h('span', 'sl-spacer'));
    head.appendChild(
      button('Mark all as read', {
        cls: 'sl-small',
        onClick: () =>
          this.runLive(view, async () => {
            for (const it of items) await this.resolvePending(it);
          }),
      })
    );
    root.appendChild(head);

    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.path)) groups.set(it.path, []);
      groups.get(it.path).push(it);
    }
    for (const [p, list] of groups) {
      const g = h('div', 'sl-group');
      const gh = h('div', 'sl-group-head');
      const link = h('a', 'sl-src', list[0].date.format('dddd D MMMM'));
      link.href = '#';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.openPath(p);
      });
      gh.appendChild(link);
      g.appendChild(gh);

      for (const it of list) {
        const row = h('div', 'sl-item');
        const t = h('div', 'sl-item-text');
        this.renderMd(it.text, t, path, view.dc);
        row.appendChild(t);
        const acts = h('div', 'sl-actions');
        acts.append(
          button('Add to notes', {
            cls: 'sl-small',
            title: 'Copy it into "Notes for today"',
            onClick: () => this.runLive(view, () => this.pendingToNotes(path, it)),
          }),
          button('Make task', {
            cls: 'sl-small',
            title: 'Turn it into a task on the board',
            onClick: async (e) => {
              const opts = await this.boardCategories(path);
              this.categoryPicker(e, opts, (cat) => this.runLive(view, () => this.pendingToTask(path, it, cat)));
            },
          }),
          button('Dismiss', {
            cls: 'sl-small',
            title: 'Mark it as read and hide it',
            onClick: () => this.runLive(view, () => this.resolvePending(it)),
          })
        );
        row.appendChild(acts);
        g.appendChild(row);
      }
      root.appendChild(g);
    }
  }
}

// Settings

class StudioloSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.replaceChildren();

    const save = async () => p.persist();
    const num = (v, fallback) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };

    new Setting(containerEl).setName('Daily pages').setHeading();

    new Setting(containerEl)
      .setName('Journal folder')
      .setDesc('Where daily pages are created and read from. Each page is named by its date, for example 2026-10-19.md.')
      .addText((t) =>
        t.setPlaceholder('Journal').setValue(p.settings.folder).onChange(async (v) => {
          p.settings.folder = v.trim();
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Custom template (optional)')
      .setDesc(
        'Path to a note used for new daily pages. {{date}} and {{title}} are replaced. Keep the studiolo code blocks; note sections are added from the page as you need them.'
      )
      .addText((t) =>
        t.setPlaceholder('Templates/daily').setValue(p.settings.templatePath).onChange(async (v) => {
          p.settings.templatePath = v.trim();
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Open today on startup')
      .setDesc("Creates today's page if needed and opens it when Obsidian starts.")
      .addToggle((t) =>
        t.setValue(p.settings.openOnStartup).onChange(async (v) => {
          p.settings.openOnStartup = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Create the page automatically every day')
      .setDesc(
        "Creates today's page at startup, and at midnight if Obsidian is open. If several devices sync this vault, turn this off on all but one, or each may create the same page and cause a sync conflict."
      )
      .addToggle((t) =>
        t.setValue(p.settings.autoCreate).onChange(async (v) => {
          p.settings.autoCreate = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName('Categories')
      .setDesc('Suggested task categories, comma separated. You can always add new ones from the board.')
      .addText((t) =>
        t.setValue(p.settings.categories.join(', ')).onChange(async (v) => {
          p.settings.categories = v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
          await save();
        })
      );

    new Setting(containerEl).setName('Board').setHeading();

    // The picker needs a hex value, so a lane on its theme color shows that color resolved.
    const themeHex = (lane) => {
      const probe = h('div');
      probe.setCssProps({ color: `var(${lane.theme})` });
      containerEl.appendChild(probe);
      const hex = cssColorToHex(probe.ownerDocument.defaultView.getComputedStyle(probe).color);
      probe.remove();
      return hex || '#808080';
    };
    for (const lane of LANES) {
      let picker;
      new Setting(containerEl)
        .setName(`${lane.label} color`)
        .addColorPicker((c) => {
          picker = c;
          c.setValue(p.settings.laneColors[lane.id] || themeHex(lane)).onChange(async (v) => {
            p.settings.laneColors[lane.id] = v;
            p.applyLaneColors();
            await save();
          });
        })
        .addExtraButton((b) =>
          b
            .setIcon('rotate-ccw')
            .setTooltip('Use the theme color')
            .onClick(async () => {
              picker.setValue(themeHex(lane));
              p.settings.laneColors[lane.id] = '';
              p.applyLaneColors();
              await save();
            })
        );
    }

    new Setting(containerEl).setName('Timer').setHeading();

    const minutes = (name, key, fallback) =>
      new Setting(containerEl).setName(name).addText((t) =>
        t.setValue(String(p.settings[key])).onChange(async (v) => {
          p.settings[key] = num(v, fallback);
          p.timer.settingsChanged();
          await save();
        })
      );
    minutes('Focus (minutes)', 'focusMin', 25);
    minutes('Short break (minutes)', 'shortMin', 5);
    minutes('Long break (minutes)', 'longMin', 15);
    minutes('Long break after this many focus sessions', 'longEvery', 4);

    new Setting(containerEl)
      .setName('Start the next phase automatically')
      .addToggle((t) =>
        t.setValue(p.settings.autoStartNext).onChange(async (v) => {
          p.settings.autoStartNext = v;
          await save();
        })
      );

    new Setting(containerEl).setName('Sound when a timer ends').addToggle((t) =>
      t.setValue(p.settings.sound).onChange(async (v) => {
        p.settings.sound = v;
        await save();
      })
    );

    new Setting(containerEl)
      .setName('System notification when a timer ends')
      .setDesc('Desktop only. Obsidian will ask for permission the first time you start a timer.')
      .addToggle((t) =>
        t.setValue(p.settings.systemNotification).onChange(async (v) => {
          p.settings.systemNotification = v;
          await save();
        })
      );
  }
}

module.exports = StudioloPlugin;
module.exports.default = StudioloPlugin;
module.exports._test = {
  laneOf,
  laneChar,
  parseBoard,
  serializeBoard,
  visibleCategories,
  findBlock,
  getBlockBody,
  replaceBlockBody,
  findSection,
  pendingNotes,
  resolveLine,
  insertIntoSection,
  noteSections,
  addNoteSection,
  findCallout,
  sectionIsEmpty,
  removeSection,
  cssColorToHex,
  buildDailyNote,
  fmtDuration,
  StudioloTimer,
  DEFAULT_SETTINGS,
  BLOCK,
};
