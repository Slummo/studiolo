'use strict';
const assert = require('assert');
const Module = require('module');
const { JSDOM } = require('jsdom');
const moment = require('moment');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
// Obsidian adds this to every element.
dom.window.HTMLElement.prototype.setCssProps = function (props) {
  for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
};

/* ---------------- obsidian mock ---------------- */
class Component {
  constructor() { this._cbs = []; this._children = []; }
  register(cb) { this._cbs.push(cb); }
  addChild(c) { this._children.push(c); return c; }
  removeChild(c) { this._children = this._children.filter((x) => x !== c); c.unload(); return c; }
  load() {}
  unload() { this._children.forEach((c) => c.unload()); this._cbs.forEach((f) => f()); }
}
class MarkdownRenderChild extends Component { constructor(el) { super(); this.containerEl = el; } }
class TFile { constructor(path) { this.path = path; this.basename = path.split('/').pop().replace(/\.md$/, ''); this.extension = 'md'; } }
const notices = [];
let lastMenu = null;
class Menu {
  constructor() { this.items = []; lastMenu = this; }
  addItem(cb) { const it = { title: '', click: null, setTitle(t) { this.title = t; return this; }, setIcon() { return this; }, onClick(f) { this.click = f; return this; } }; cb(it); this.items.push(it); return this; }
  addSeparator() { return this; }
  showAtMouseEvent() {}
  click(title) { const it = this.items.find((i) => i.title === title); if (!it) throw new Error('No menu item ' + title + ' in ' + this.items.map((i) => i.title)); return it.click(); }
}
const mock = {
  Plugin: class { constructor(app, manifest) { this.app = app; this.manifest = manifest; } },
  Notice: class { constructor(m) { notices.push(m); } },
  Modal: class { constructor(app) { this.app = app; this.titleEl = document.createElement('div'); this.contentEl = document.createElement('div'); } open() { this.onOpen(); } close() {} },
  Menu,
  Setting: class {},
  PluginSettingTab: class {},
  MarkdownRenderChild,
  MarkdownView: class {},
  MarkdownRenderer: { render: (app, md, el) => { const p = document.createElement('p'); p.textContent = md; el.appendChild(p); return Promise.resolve(); } },
  TFile,
  normalizePath: (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || '/',
  setIcon: (el, icon) => { el.dataset.icon = icon; },
  moment,
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'obsidian' ? mock : origLoad.call(this, req, ...rest); };

const Plugin = require(require('path').join(__dirname, '..', 'main.js'));
const T = Plugin._test;

/* ---------------- fake vault ---------------- */
function makeApp() {
  const files = new Map();
  const tfiles = new Map();
  const vault = {
    files,
    getAbstractFileByPath: (p) => tfiles.get(p) || (folders.has(p) ? { path: p } : null),
    getMarkdownFiles: () => [...tfiles.values()],
    cachedRead: async (f) => files.get(f.path),
    read: async (f) => files.get(f.path),
    process: async (f, fn) => { const n = fn(files.get(f.path)); files.set(f.path, n); return n; },
    create: async (p, c) => { if (files.has(p)) throw new Error('exists'); files.set(p, c); const t = new TFile(p); tfiles.set(p, t); return t; },
    createFolder: async (p) => { folders.add(p); },
    on: () => ({}),
  };
  const folders = new Set();
  const opened = [];
  const workspace = {
    getActiveViewOfType: () => null,
    iterateAllLeaves: () => {},
    getLeaf: () => ({ openFile: async (f) => opened.push(f.path) }),
    openLinkText: () => {},
    onLayoutReady: () => {},
  };
  return { vault, workspace, opened };
}

function makePlugin() {
  const app = makeApp();
  const p = new Plugin(app, {});
  p.settings = Object.assign({}, T.DEFAULT_SETTINGS, { categories: ['Work', 'Study', 'Personal'] });
  p.timerState = null;
  p.saveData = async () => {};
  p.initState();
  return { p, app };
}
const ctxFor = (path) => ({ sourcePath: path, addChild: () => {} });
const tick = () => new Promise((r) => setTimeout(r, 5));
const fire = (el, type, props = {}) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, props); el.dispatchEvent(e); return e; };

// A page that uses headings instead of callouts, as a custom template or a hand-made page might.
// Pages like this must keep working.
const HEADING_NOTE = [
  '---', 'studiolo: 2026-10-18', '---', '# Sunday 18 October 2026', '',
  '```studiolo-nav', '```', '', '```studiolo-timer', '```', '',
  '## ⚠️ Left behind', '```studiolo-carryover', '```', '',
  '## 📋 Tasks', '```studiolo-board', '```', '',
  '## 📨 From previous days', '```studiolo-previous', '```', '',
  '## 💭 Brainstorm', '- ', '', '## 📝 Notes for today', '- ', '', '## 🏆 Results of today', '- ', '',
  '## 💡 What I learned', '- ', '', '## ➡️ Notes for next days', '- ', '',
].join('\n');
const BLOCK_FENCE = (k) => '```' + T.BLOCK[k];

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name); console.log(e); process.exitCode = 1; }
}

(async () => {
  console.log('Pure helpers');

  await test('parse / serialize round trip', () => {
    const src = '## Work\n- [ ] A\n- [/] B (since 2026-10-15)\n- [x] C\n\n## Study\n- [-] D\n- [>] E';
    const b = T.parseBoard(src);
    assert.strictEqual(b.cards.length, 5);
    assert.strictEqual(b.cards[1].since, '2026-10-15');
    assert.strictEqual(b.cards[1].text, 'B');
    assert.strictEqual(T.serializeBoard(b), src);
  });

  await test('cards before any heading go to General', () => {
    const b = T.parseBoard('- [ ] loose');
    assert.deepStrictEqual(b.categories, ['General']);
  });

  await test('categories with only archived/moved cards are hidden', () => {
    const b = T.parseBoard('## Work\n- [-] old\n## Study\n- [ ] x\n## Empty');
    assert.deepStrictEqual(T.visibleCategories(b), ['Study', 'Empty']);
  });

  await test('block replace keeps the rest of the note', () => {
    const note = T.buildDailyNote(moment('2026-10-19'));
    const out = T.replaceBlockBody(note, T.BLOCK.board, '## Work\n- [ ] hi');
    assert.ok(out.includes('```studiolo-board\n## Work\n- [ ] hi\n```'));
    assert.strictEqual(T.getBlockBody(out, T.BLOCK.board), '## Work\n- [ ] hi');
    assert.strictEqual(out.replace('## Work\n- [ ] hi\n', ''), note);
  });

  await test('headings inside the board block are not mistaken for sections', () => {
    let note = T.buildDailyNote(moment('2026-10-19'));
    note = T.replaceBlockBody(note, T.BLOCK.board, '## Notes for next days\n- [ ] trap');
    assert.deepStrictEqual(T.pendingNotes(note), []);
  });

  await test('pending notes and resolving, under headings', () => {
    const note = HEADING_NOTE.replace('## ➡️ Notes for next days\n- ', '## ➡️ Notes for next days\n- call Marco\n- [ ] buy milk\n- [x] already seen\n  - nested ignored');
    const items = T.pendingNotes(note);
    assert.deepStrictEqual(items.map((i) => i.text), ['call Marco', 'buy milk']);
    assert.strictEqual(T.resolveLine('- call Marco'), '- [x] call Marco');
    assert.strictEqual(T.resolveLine('- [ ] buy milk'), '- [x] buy milk');
  });

  await test('pending notes and resolving, in a callout', () => {
    const note = '> [!studiolo-next] Notes for next days\n> - call Marco\n> - [x] seen\n>   - nested ignored\n\nafter';
    const items = T.pendingNotes(note);
    assert.deepStrictEqual(items.map((i) => [i.text, i.line]), [['call Marco', 1]]);
    assert.strictEqual(T.resolveLine('> - call Marco'), '> - [x] call Marco');
    assert.strictEqual(T.resolveLine('>- [ ] x'), '>- [x] x');
  });

  await test('insert into section: heading placeholder, then appends', () => {
    let note = T.insertIntoSection(HEADING_NOTE, /notes for today/i, '- one');
    assert.ok(note.includes('## 📝 Notes for today\n- one\n\n## 🏆'));
    note = T.insertIntoSection(note, /notes for today/i, '- two');
    assert.ok(note.includes('## 📝 Notes for today\n- one\n- two\n\n## 🏆'));
    assert.strictEqual(T.insertIntoSection('# nothing here', /notes for today/i, '- x'), null);
  });

  await test('insert into section: callout placeholder, then appends inside the quote', () => {
    let note = 'a\n\n> [!studiolo-note] Notes for today\n> \n\nb';
    note = T.insertIntoSection(note, /notes for today/i, '- one');
    assert.strictEqual(note, 'a\n\n> [!studiolo-note] Notes for today\n> - one\n\nb');
    note = T.insertIntoSection(note, /notes for today/i, '- two');
    assert.strictEqual(note, 'a\n\n> [!studiolo-note] Notes for today\n> - one\n> - two\n\nb');
  });

  await test('new pages: catch up, plan, notes; styled sections; notes added on demand', () => {
    const note = T.buildDailyNote(moment('2026-10-19'));
    assert.ok(note.startsWith('---\nstudiolo: 2026-10-19\ncssclasses:\n  - studiolo\n---\n'));
    assert.ok(!note.includes('## Catch up'), 'the catch up block draws its own title');
    const order = [BLOCK_FENCE('timer'), BLOCK_FENCE('catchup'), '## Plan', BLOCK_FENCE('board'), '## Notes', BLOCK_FENCE('notes')].map((s) => note.indexOf(s));
    assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), String(order));
    assert.deepStrictEqual(T.noteSections(note), []);
  });

  await test('note sections go in page order, whichever is added first', () => {
    let note = T.buildDailyNote(moment('2026-10-19'));
    for (const k of ['next', 'today', 'brainstorm', 'evening']) note = T.addNoteSection(note, k).content;
    note = T.addNoteSection(note, 'other', 'Reading list').content;
    const titles = note.split('\n').filter((l) => l.startsWith('> [!')).map((l) => l.replace(/^> \[!\S+\] /, ''));
    assert.deepStrictEqual(titles, ['Brainstorm', 'Notes for today', 'End of day', 'Reading list', 'Notes for next days']);
    // brainstorm sits between "## Plan" and the board, everything else after the notes block
    assert.ok(note.includes('## Plan\n\n> [!studiolo-brainstorm] Brainstorm\n> \n\n```studiolo-board'));
    assert.ok(note.indexOf('[!studiolo-note] Notes for today') > note.indexOf('```studiolo-notes'));
    // blank line between every callout, so they never merge; the final newline is kept
    assert.ok(!/^>.*\n(?!>)\S/m.test(note));
    assert.ok(note.endsWith('> \n'));
    // adding a kind that is already there changes nothing
    assert.strictEqual(T.addNoteSection(note, 'today').content, note);
    assert.deepStrictEqual(T.noteSections(note).map((s) => s.kind), ['brainstorm', 'today', 'evening', 'other', 'next']);
  });

  await test('heading pages: their sections count, and new callouts fit around them', () => {
    assert.deepStrictEqual(T.noteSections(HEADING_NOTE).map((s) => s.kind), ['brainstorm', 'today', 'evening', 'evening', 'next']);
    const r = T.addNoteSection(HEADING_NOTE, 'other', 'Ideas');
    assert.ok(r.content.includes('- \n\n> [!studiolo-note] Ideas\n> \n\n## ➡️ Notes for next days'));
    assert.strictEqual(r.content.split('\n')[r.line], '> ');
  });

  await test('css color to hex', () => {
    assert.strictEqual(T.cssColorToHex('rgb(80, 120, 200)'), '#5078c8');
    assert.strictEqual(T.cssColorToHex('rgba(0, 0, 0, 0.5)'), '#000000');
    assert.strictEqual(T.cssColorToHex('var(--x)'), null);
  });

  await test('duration formatting', () => {
    assert.strictEqual(T.fmtDuration(25 * 60000, true), '25:00');
    assert.strictEqual(T.fmtDuration(1, true), '00:01');
    assert.strictEqual(T.fmtDuration(3723000, false), '1:02:03');
  });

  await test('hand-written lines in the board survive a rewrite', () => {
    const b = T.parseBoard('intro line\n## Work\n- [ ] A\nremember: ask Sara\n- plain bullet\n- [x] B');
    assert.deepStrictEqual(b.cards.map((c) => c.text), ['A', 'B']);
    assert.strictEqual(T.serializeBoard(b), 'intro line\n\n## Work\n- [ ] A\n- [x] B\nremember: ask Sara\n- plain bullet');
  });

  await test('forced categories stay visible', () => {
    const b = T.parseBoard('## Work\n- [-] old');
    assert.deepStrictEqual(T.visibleCategories(b), []);
    assert.deepStrictEqual(T.visibleCategories(b, ['Work']), ['Work']);
  });

  console.log('Plugin behaviour');

  const today = moment().startOf('day');
  const todayPath = `Journal/${today.format('YYYY-MM-DD')}.md`;

  await test('creates today\'s page with all blocks and sections', async () => {
    const { p, app } = makePlugin();
    await p.openToday();
    const c = app.vault.files.get(todayPath);
    for (const b of ['nav', 'timer', 'catchup', 'board', 'notes']) assert.ok(c.includes(BLOCK_FENCE(b)), b);
    for (const s of ['## Plan', '## Notes']) assert.ok(c.includes(s), s);
    assert.ok(!c.includes('Brainstorm'), 'note sections are not pre-made');
    assert.deepStrictEqual(app.opened, [todayPath]);
    await p.openToday();
    assert.strictEqual(app.vault.getMarkdownFiles().length, 1, 'no duplicate page');
  });

  await test('empty board offers categories; picking one adds it', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    const el = document.createElement('div');
    p.renderBoard('', el, ctxFor(todayPath));
    const chip = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Work');
    fire(chip, 'click');
    await tick();
    assert.strictEqual(T.getBlockBody(app.vault.files.get(todayPath), T.BLOCK.board), '## Work');
  });

  await test('add, drag between lanes, check off, reorder', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    const body = () => T.getBlockBody(app.vault.files.get(todayPath), T.BLOCK.board);
    const render = () => { const el = document.createElement('div'); document.body.appendChild(el); p.renderBoard(body(), el, ctxFor(todayPath)); return el; };

    await p.addCategory(todayPath, 'Work');
    let el = render();
    const input = el.querySelector('input.sl-add');
    for (const t of ['Fix login bug', 'Write report', 'Standup']) {
      input.value = t;
      fire(input, 'keydown', { key: 'Enter' });
      await tick();
    }
    assert.strictEqual(body(), '## Work\n- [ ] Fix login bug\n- [ ] Write report\n- [ ] Standup');

    el = render();
    const cards = el.querySelectorAll('.sl-lane-todo .sl-card');
    assert.strictEqual(cards.length, 3);
    // drag "Write report" into Doing
    fire(cards[1], 'dragstart');
    fire(el.querySelector('.sl-lane-doing .sl-lane-list'), 'drop');
    await tick();
    assert.strictEqual(body(), '## Work\n- [ ] Fix login bug\n- [ ] Standup\n- [/] Write report');

    el = render();
    // check off Standup via checkbox
    const standup = [...el.querySelectorAll('.sl-card')].find((c) => c.textContent.includes('Standup'));
    const cb = standup.querySelector('input.sl-check');
    cb.checked = true;
    fire(cb, 'change');
    await tick();
    assert.ok(body().includes('- [x] Standup'));

    el = render();
    // drag Standup (done) before "Fix login bug" in To do
    const st = [...el.querySelectorAll('.sl-card')].find((c) => c.textContent.includes('Standup'));
    const fix = [...el.querySelectorAll('.sl-card')].find((c) => c.textContent.includes('Fix login'));
    fire(st, 'dragstart');
    fire(fix.querySelector('.sl-card-text p'), 'drop');
    await tick();
    assert.strictEqual(body(), '## Work\n- [ ] Standup\n- [ ] Fix login bug\n- [/] Write report');
  });

  await test('card menu: change category, archive hides it', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    const body = () => T.getBlockBody(app.vault.files.get(todayPath), T.BLOCK.board);
    await p.addCard(todayPath, 'Work', 'Read paper', null);
    let el = document.createElement('div');
    p.renderBoard(body(), el, ctxFor(todayPath));
    fire(el.querySelector('.sl-card-more'), 'click');
    lastMenu.click('Change category...');
    lastMenu.click('Study');
    await tick();
    assert.strictEqual(body(), '## Work\n\n## Study\n- [ ] Read paper');
    el = document.createElement('div');
    p.renderBoard(body(), el, ctxFor(todayPath));
    fire(el.querySelector('.sl-card-more'), 'click');
    lastMenu.click('Archive');
    await tick();
    assert.ok(body().includes('- [-] Read paper'));
    el = document.createElement('div');
    p.renderBoard(body(), el, ctxFor(todayPath));
    assert.strictEqual(el.querySelectorAll('.sl-card').length, 0);
    assert.ok(el.textContent.includes('1 archived'));
  });

  await test('stale board is not overwritten', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    await p.addCard(todayPath, 'Work', 'A', null);
    const ok = await p.setCardStatus(todayPath, 0, 'Work\u0000- [ ] something else', 'x');
    assert.strictEqual(ok, false);
    assert.ok(T.getBlockBody(app.vault.files.get(todayPath), T.BLOCK.board).includes('- [ ] A'));
  });

  await test('left behind: collects from all previous days, oldest first, carry / done / archive', async () => {
    const { p, app } = makePlugin();
    const d5 = today.clone().subtract(5, 'days');
    const d1 = today.clone().subtract(1, 'days');
    const p5 = `Journal/${d5.format('YYYY-MM-DD')}.md`;
    const p1 = `Journal/${d1.format('YYYY-MM-DD')}.md`;
    await p.ensureNote(d5);
    await p.ensureNote(d1);
    await p.ensureNote(today);
    await app.vault.process(app.vault.getAbstractFileByPath(p5), (c) => T.replaceBlockBody(c, T.BLOCK.board, '## Study\n- [ ] Old chapter\n- [x] Done thing'));
    await app.vault.process(app.vault.getAbstractFileByPath(p1), (c) => T.replaceBlockBody(c, T.BLOCK.board, '## Work\n- [/] Yesterday task\n- [ ] Drop me\n## Study\n- [ ] Exercise (since ' + d5.format('YYYY-MM-DD') + ')'));

    const items = await p.collectLeftBehind(today);
    assert.deepStrictEqual(items.map((i) => [i.card.text, i.age]), [['Old chapter', 5], ['Yesterday task', 1], ['Drop me', 1], ['Exercise', 5]]);

    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderLive(el, ctxFor(todayPath), 'carryover');
    await tick(); await tick();
    // Study group first (age 5), Work second
    const groups = [...el.querySelectorAll('.sl-group-head .sl-cat-name')].map((n) => n.textContent);
    assert.deepStrictEqual(groups, ['Study', 'Work']);
    assert.ok(el.querySelector('.sl-urgency-3'), 'age 5 badge is red');

    const rowOf = (txt) => [...el.querySelectorAll('.sl-item')].find((r) => r.textContent.includes(txt));
    fire([...rowOf('Old chapter').querySelectorAll('button')].find((b) => b.textContent === 'Move to today'), 'click');
    await tick(); await tick(); await tick();
    fire([...rowOf('Drop me').querySelectorAll('button')].find((b) => b.textContent === 'Archive'), 'click');
    await tick(); await tick(); await tick();
    fire([...rowOf('Exercise').querySelectorAll('button')].find((b) => b.textContent === 'Done'), 'click');
    await tick(); await tick(); await tick();

    const todayBody = T.getBlockBody(app.vault.files.get(todayPath), T.BLOCK.board);
    assert.strictEqual(todayBody, `## Study\n- [ ] Old chapter (since ${d5.format('YYYY-MM-DD')})`);
    assert.ok(app.vault.files.get(p5).includes('- [>] Old chapter'));
    assert.ok(app.vault.files.get(p1).includes('- [-] Drop me'));
    assert.ok(app.vault.files.get(p1).includes('- [x] Exercise'));

    const left = await p.collectLeftBehind(today);
    assert.deepStrictEqual(left.map((i) => i.card.text), ['Yesterday task']);
    assert.ok(el.textContent.includes('Yesterday task') && !el.textContent.includes('Drop me'), 'view refreshed');

    // today's board shows the age badge for the carried card
    const bel = document.createElement('div');
    p.renderBoard(todayBody, bel, ctxFor(todayPath));
    assert.strictEqual(bel.querySelector('.sl-age').textContent, '5d');

    // "doing" stays doing when carried, and a second carry keeps the original date
    await p.carryTo(todayPath, left[0]);
    assert.ok(T.getBlockBody(app.vault.files.get(todayPath), T.BLOCK.board).includes(`- [/] Yesterday task (since ${d1.format('YYYY-MM-DD')})`));
  });

  await test('from previous days: everything not yet read, from every earlier day', async () => {
    const { p, app } = makePlugin();
    const d3 = today.clone().subtract(3, 'days');
    const d1 = today.clone().subtract(1, 'days');
    const p3 = `Journal/${d3.format('YYYY-MM-DD')}.md`;
    const p1 = `Journal/${d1.format('YYYY-MM-DD')}.md`;
    await p.ensureNote(d3); await p.ensureNote(d1); await p.ensureNote(today);
    const setNext = (path, lines) => app.vault.process(app.vault.getAbstractFileByPath(path), (c) => lines.split('\n').reduce((acc, l) => T.insertIntoSection(acc, /notes for next days/i, l), T.addNoteSection(c, 'next').content));
    await setNext(p3, '- remember the book\n- [x] already read');
    await setNext(p1, '- call Marco\n- review PR #12');

    const items = await p.collectPending(today);
    assert.deepStrictEqual(items.map((i) => i.text), ['remember the book', 'call Marco', 'review PR #12']);

    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderLive(el, ctxFor(todayPath), 'previous');
    await tick(); await tick();
    const rowOf = (txt) => [...el.querySelectorAll('.sl-item')].find((r) => r.textContent.includes(txt));

    fire([...rowOf('remember the book').querySelectorAll('button')].find((b) => b.textContent === 'Add to notes'), 'click');
    await tick(); await tick(); await tick();
    // today's page had no "Notes for today" yet: it is created in place
    assert.ok(app.vault.files.get(todayPath).includes('```studiolo-notes\n```\n\n> [!studiolo-note] Notes for today\n> - remember the book\n'));
    assert.ok(app.vault.files.get(p3).includes('- [x] remember the book'));

    fire([...rowOf('review PR').querySelectorAll('button')].find((b) => b.textContent === 'Make task'), 'click');
    await tick(); await tick();
    lastMenu.click('Work');
    await tick(); await tick(); await tick();
    assert.ok(T.getBlockBody(app.vault.files.get(todayPath), T.BLOCK.board).includes('## Work\n- [ ] review PR #12'));

    fire([...rowOf('call Marco').querySelectorAll('button')].find((b) => b.textContent === 'Dismiss'), 'click');
    await tick(); await tick(); await tick();
    assert.deepStrictEqual(await p.collectPending(today), []);
    assert.ok(el.textContent.includes('Nothing pending'));
  });

  await test('nav and timer render without errors', async () => {
    const { p } = makePlugin();
    await p.ensureNote(today.clone().subtract(2, 'days'));
    await p.ensureNote(today);
    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderNav(el, ctxFor(todayPath));
    assert.ok(el.textContent.includes('←') && el.textContent.includes('Today'));
    const tel = document.createElement('div');
    document.body.appendChild(tel);
    p.renderTimer(tel, ctxFor(todayPath));
    assert.ok(tel.querySelector('.sl-timer-time').textContent === '25:00');
    fire([...tel.querySelectorAll('.sl-tab')][1], 'click');
    assert.strictEqual(tel.querySelector('.sl-timer-time').textContent, '10:00');
    assert.ok(!tel.querySelector('.sl-timer-setter').classList.contains('sl-hidden'));
    assert.ok(tel.querySelector('.sl-progress').classList.contains('sl-hidden') === false);
  });

  await test('pomodoro cycle: focus, short x3, long, today count', async () => {
    const { p } = makePlugin();
    const t = p.timer;
    p.notify = () => {};
    const seq = [];
    for (let i = 0; i < 8; i++) {
      t.start();
      t.s.endAt = Date.now() - 1;
      t.tick();
      seq.push(t.s.phase);
    }
    assert.deepStrictEqual(seq, ['short', 'focus', 'short', 'focus', 'short', 'focus', 'long', 'focus']);
    assert.strictEqual(t.todayCount(), 4);
  });

  await test('countdown and stopwatch pause / resume', async () => {
    const { p } = makePlugin();
    const t = p.timer;
    p.notify = () => {};
    t.setMode('countdown');
    t.setCountdown(3);
    assert.strictEqual(t.remaining(), 180000);
    t.start();
    t.s.endAt -= 60000; // pretend a minute passed
    t.pause();
    assert.ok(Math.abs(t.remaining() - 120000) < 50);
    assert.ok(t.statusText().includes('paused'));
    t.setMode('stopwatch');
    t.start();
    t.s.startedAt -= 5000;
    t.pause();
    assert.ok(t.elapsed() >= 5000 && t.elapsed() < 5100);
    t.reset();
    assert.strictEqual(t.statusText(), '');
  });

  await test('board edits keep hand-written lines, and a category holding them cannot be removed', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    const body = () => T.getBlockBody(app.vault.files.get(todayPath), T.BLOCK.board);
    await app.vault.process(app.vault.getAbstractFileByPath(todayPath), (c) => T.replaceBlockBody(c, T.BLOCK.board, '## Work\n- [ ] A\nnote to self'));
    await p.addCard(todayPath, 'Work', 'B', null);
    assert.strictEqual(body(), '## Work\n- [ ] A\n- [ ] B\nnote to self');
    const el = document.createElement('div');
    p.renderBoard(body(), el, ctxFor(todayPath));
    fire(el.querySelector('.sl-cat-head [aria-label="Category actions"]'), 'click');
    assert.ok(!lastMenu.items.some((i) => i.title === 'Remove category'));
  });

  await test('renaming into an existing category merges cards and hand-written lines', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    const body = () => T.getBlockBody(app.vault.files.get(todayPath), T.BLOCK.board);
    await app.vault.process(app.vault.getAbstractFileByPath(todayPath), (c) => T.replaceBlockBody(c, T.BLOCK.board, '## Work\n- [ ] A\nnote to self\n\n## Job\n- [ ] C'));
    const el = document.createElement('div');
    p.renderBoard(body(), el, ctxFor(todayPath));
    let modal = null;
    fire(el.querySelector('.sl-cat-head [aria-label="Category actions"]'), 'click');
    const item = lastMenu.items.find((i) => i.title === 'Rename...');
    const OrigModal = require('obsidian').Modal;
    const open = OrigModal.prototype.open;
    OrigModal.prototype.open = function () { modal = this; open.call(this); };
    item.click();
    OrigModal.prototype.open = open;
    const input = modal.contentEl.querySelector('input');
    input.value = 'Job';
    fire(input, 'keydown', { key: 'Enter' });
    await tick();
    assert.strictEqual(body(), '## Job\n- [ ] A\n- [ ] C\nnote to self');
  });

  await test('picking a category that only has archived cards shows it again', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    await app.vault.process(app.vault.getAbstractFileByPath(todayPath), (c) => T.replaceBlockBody(c, T.BLOCK.board, '## Work\n- [-] old'));
    const before = app.vault.files.get(todayPath);
    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderBoard('## Work\n- [-] old', el, ctxFor(todayPath));
    assert.strictEqual(el.querySelectorAll('input.sl-add').length, 0);
    fire([...el.querySelectorAll('button')].find((b) => b.textContent === 'Work'), 'click');
    await tick(); await tick();
    assert.strictEqual(app.vault.files.get(todayPath), before, 'file untouched');
    assert.strictEqual(el.querySelectorAll('input.sl-add').length, 1, 'redrawn with an input');
  });

  await test('a moved pending note is ticked only if its text is unique', async () => {
    const { p, app } = makePlugin();
    const d1 = today.clone().subtract(1, 'days');
    const p1 = `Journal/${d1.format('YYYY-MM-DD')}.md`;
    await p.ensureNote(d1);
    await app.vault.process(app.vault.getAbstractFileByPath(p1), () => HEADING_NOTE.replace('## ➡️ Notes for next days\n- ', '## ➡️ Notes for next days\n- call Marco'));
    const [it] = await p.collectPending(today);
    // a line is inserted above, and the same text also appears in "Notes for today"
    await app.vault.process(app.vault.getAbstractFileByPath(p1), (c) => c.replace('## 📝 Notes for today\n- ', '## 📝 Notes for today\n- call Marco\n- other'));
    assert.strictEqual(await p.resolvePending(it), false);
    assert.ok(!app.vault.files.get(p1).includes('[x]'), 'nothing ticked');
    // without the duplicate, the moved line is followed
    await app.vault.process(app.vault.getAbstractFileByPath(p1), (c) => c.replace('## 📝 Notes for today\n- call Marco', '## 📝 Notes for today\n- something'));
    assert.strictEqual(await p.resolvePending(it), true);
    assert.ok(app.vault.files.get(p1).includes('## ➡️ Notes for next days\n- [x] call Marco'));
  });

  await test('vault changes only refresh views of later days, nav always', async () => {
    const { p } = makePlugin();
    const calls = [];
    const fake = (name, date) => ({ root: { isConnected: true }, date, refresh: () => calls.push(name) });
    p.liveViews.add(fake('today', today));
    p.liveViews.add(fake('yesterday', today.clone().subtract(1, 'days')));
    p.liveViews.add(fake('nav', undefined));
    p.refreshLive(false, today.clone().subtract(1, 'days'));
    assert.deepStrictEqual(calls, ['today', 'nav']);
  });

  await test('nav picks up a newly created later day', async () => {
    const { p } = makePlugin();
    const d1 = today.clone().subtract(1, 'days');
    await p.ensureNote(d1);
    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderNav(el, ctxFor(`Journal/${d1.format('YYYY-MM-DD')}.md`));
    assert.ok(el.textContent.includes('No later days'));
    assert.ok(el.querySelector('.sl-banner'), 'not-today banner');
    await p.ensureNote(today);
    p.refreshLive(false);
    assert.ok(el.textContent.includes(today.format('ddd D MMM')));
  });

  await test('an older refresh never draws over a newer one', async () => {
    const { p, app } = makePlugin();
    const d1 = today.clone().subtract(1, 'days');
    const p1 = `Journal/${d1.format('YYYY-MM-DD')}.md`;
    await p.ensureNote(d1); await p.ensureNote(today);
    await app.vault.process(app.vault.getAbstractFileByPath(p1), (c) => T.replaceBlockBody(c, T.BLOCK.board, '## Work\n- [ ] Stale'));
    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderLive(el, ctxFor(todayPath), 'carryover');
    await tick();
    // slow first read returns the old content, second read sees the task already handled
    const real = app.vault.cachedRead;
    let n = 0;
    app.vault.cachedRead = async (f) => { const c = await real(f); if (n++ === 0) { await tick(); await tick(); } return c; };
    const view = [...p.liveViews].find((v) => v.root.parentNode === el);
    const slow = view.refresh(true);
    await app.vault.process(app.vault.getAbstractFileByPath(p1), (c) => c.replace('- [ ] Stale', '- [x] Stale'));
    await view.refresh(true);
    await slow;
    app.vault.cachedRead = real;
    assert.ok(el.textContent.includes('Nothing left behind'), el.textContent);
  });

  await test('notes bar: offers missing sections, adds one and moves the cursor into it', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    const cursor = [];
    const editorLines = () => app.vault.files.get(todayPath).split('\n');
    app.workspace.getActiveViewOfType = () => ({
      file: { path: todayPath },
      getMode: () => 'source',
      editor: { lineCount: () => editorLines().length, getLine: (n) => editorLines()[n], setCursor: (c) => cursor.push(c), focus: () => {} },
    });
    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderNotesBar(el, ctxFor(todayPath));
    await tick();
    const labels = () => [...el.querySelectorAll('button')].map((b) => b.textContent);
    // brainstorm is offered in Plan, not here
    assert.deepStrictEqual(labels(), ['Notes for today', 'End of day', 'Notes for next days', 'Other...']);
    fire([...el.querySelectorAll('button')].find((b) => b.textContent === 'End of day'), 'click');
    await tick(); await new Promise((r) => setTimeout(r, 60));
    const c = app.vault.files.get(todayPath);
    assert.ok(c.includes('```studiolo-notes\n```\n\n> [!studiolo-evening] End of day\n> \n'));
    assert.strictEqual(editorLines()[cursor[0].line], '> ', 'cursor on the empty body line');
    p.refreshLive(false);
    await tick();
    assert.deepStrictEqual(labels(), ['Notes for today', 'Notes for next days', 'Other...']);
  });

  await test('plan: the brainstorm slot sits above the board and adds the brainstorm there', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderBoard('', el, ctxFor(todayPath));
    await tick();
    const slot = el.querySelector('.sl-plan-bar button');
    assert.strictEqual(slot.textContent, 'Brainstorm first');
    assert.ok(el.firstChild.classList.contains('sl-plan-bar'), 'slot comes before the board');
    fire(slot, 'click');
    await tick();
    assert.ok(app.vault.files.get(todayPath).includes('## Plan\n\n> [!studiolo-brainstorm] Brainstorm\n> \n\n```studiolo-board'));
    p.refreshLive(false);
    await tick();
    assert.strictEqual(el.querySelector('.sl-plan-bar').childElementCount, 0, 'slot gone once the brainstorm exists');
  });

  await test('catch up: hidden with nothing from earlier days, each list only when it has items', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderCatchup(el, ctxFor(todayPath));
    await tick(); await tick();
    const section = el.querySelector('.sl-catchup');
    assert.ok(section.classList.contains('sl-hidden'), 'first day: nothing to catch up on');
    const d1 = today.clone().subtract(1, 'days');
    await p.ensureNote(d1);
    const p1 = `Journal/${d1.format('YYYY-MM-DD')}.md`;
    await app.vault.process(app.vault.getAbstractFileByPath(p1), (c) => T.replaceBlockBody(c, T.BLOCK.board, '## Work\n- [ ] Leftover'));
    p.refreshLive(false);
    await tick(); await tick();
    assert.ok(!section.classList.contains('sl-hidden'));
    assert.strictEqual(section.querySelector('.sl-section-title').textContent, 'Catch up');
    assert.ok(!section.querySelector('.sl-carryover').classList.contains('is-empty'));
    assert.ok(section.querySelector('.sl-previous').classList.contains('is-empty'), 'no notes: that list is hidden');
  });

  await test('removing a note: X in the callout title, asks first when it has text, slot comes back', async () => {
    const { p, app } = makePlugin();
    await p.ensureNote(today);
    await p.addNote(todayPath, 'today');
    await p.addNote(todayPath, 'next');
    await app.vault.process(app.vault.getAbstractFileByPath(todayPath), (c) => T.insertIntoSection(c, /notes for today/i, '- keep this?'));
    // callouts as Obsidian renders them
    const callout = (type, title) => {
      const co = document.createElement('div');
      co.className = 'callout';
      co.setAttribute('data-callout', type);
      co.innerHTML = `<div class="callout-title"><div class="callout-icon"></div><div class="callout-title-inner">${title}</div></div>`;
      return co;
    };
    const el = document.createElement('div');
    el.append(callout('studiolo-note', 'Notes for today'), callout('studiolo-next', 'Notes for next days'), callout('tip', 'Not ours'));
    p.decorateCallouts(el, ctxFor(todayPath));
    p.decorateCallouts(el, ctxFor(todayPath));
    assert.strictEqual(el.querySelectorAll('.sl-callout-remove').length, 2, 'one X per Studiolo callout, added once');
    assert.ok(el.querySelector('.sl-callout-remove').classList.contains('interactive-child'));

    // empty section: removed straight away
    fire(el.querySelectorAll('.sl-callout-remove')[1], 'click');
    await tick();
    assert.ok(!app.vault.files.get(todayPath).includes('Notes for next days'));

    // section with text: a confirmation first; cancel keeps it, confirm removes only it
    const Modal = require('obsidian').Modal;
    const open = Modal.prototype.open;
    let modal = null;
    Modal.prototype.open = function () { modal = this; open.call(this); };
    fire(el.querySelectorAll('.sl-callout-remove')[0], 'click');
    await tick();
    assert.ok(app.vault.files.get(todayPath).includes('- keep this?'), 'nothing removed before confirming');
    [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    fire(el.querySelectorAll('.sl-callout-remove')[0], 'click');
    await tick();
    [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click();
    await tick(); await tick();
    Modal.prototype.open = open;
    assert.strictEqual(app.vault.files.get(todayPath), T.buildDailyNote(today), 'back to the untouched page');

    // the notes bar offers it again
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    p.renderNotesBar(bar, ctxFor(todayPath));
    await tick();
    assert.ok([...bar.querySelectorAll('button')].some((b) => b.textContent === 'Notes for today'));
  });

  await test('timer: icon controls, and restart goes back to focus from a break', async () => {
    const { p } = makePlugin();
    p.notify = () => {};
    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderTimer(el, ctxFor(todayPath));
    const btn = (label) => el.querySelector(`.sl-timer-controls [aria-label="${label}"]`);
    assert.strictEqual(btn('Start').textContent, '', 'icon only');
    fire(btn('Start'), 'click');
    assert.ok(btn('Pause'), 'start turns into pause');
    // finish the focus session: now on a short break, paused
    p.timer.s.endAt = Date.now() - 1;
    p.timer.tick();
    assert.strictEqual(p.timer.s.phase, 'short');
    fire(btn('Restart this phase'), 'click');
    assert.strictEqual(p.timer.s.phase, 'short', 'plain reset stays on the break');
    fire(btn('Restart the cycle from the first focus session'), 'click');
    assert.strictEqual(p.timer.s.phase, 'focus');
    assert.strictEqual(p.timer.s.round, 0);
    assert.strictEqual(el.querySelector('.sl-timer-time').textContent, '25:00');
    fire([...el.querySelectorAll('.sl-tab')][2], 'click');
    assert.ok(btn('Restart the cycle from the first focus session').classList.contains('sl-hidden'), 'pomodoro only');
  });

  await test('lane colors: theme defaults unless set, and settings changes reach open boards', async () => {
    const { p, app } = makePlugin();
    p.settings.laneColors = { todo: '', doing: '#ff8800', done: '' };
    await p.ensureNote(today);
    const el = document.createElement('div');
    document.body.appendChild(el);
    p.renderBoard('## Work\n- [ ] a', el, ctxFor(todayPath));
    const root = el.querySelector('.sl-board');
    assert.strictEqual(root.style.getPropertyValue('--sl-doing'), '#ff8800');
    assert.strictEqual(root.style.getPropertyValue('--sl-todo'), '', 'falls back to the stylesheet');
    p.settings.laneColors.todo = '#123456';
    p.settings.laneColors.doing = '';
    p.applyLaneColors();
    assert.strictEqual(root.style.getPropertyValue('--sl-todo'), '#123456');
    assert.strictEqual(root.style.getPropertyValue('--sl-doing'), '');
    void app;
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  if (notices.length) console.log('Notices:', notices);
})();
