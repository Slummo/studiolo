'use strict';
// Builds a throwaway vault for manual testing: the plugin installed and enabled, plus pages for
// earlier days with unfinished tasks and pending notes. Run it again to copy a fresh build in.
//
//   node test/make-vault.js ~/daily-desk-test-vault

const fs = require('fs');
const path = require('path');
const moment = require('moment');

const vault = process.argv[2];
if (!vault) {
  console.error('Usage: node test/make-vault.js <vault folder>');
  process.exit(1);
}
const root = path.join(__dirname, '..');
const pluginDir = path.join(vault, '.obsidian', 'plugins', 'daily-desk');
fs.mkdirSync(pluginDir, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  fs.copyFileSync(path.join(root, f), path.join(pluginDir, f));
}
// Hot Reload reloads the plugin when main.js or styles.css change, if this file exists.
fs.writeFileSync(path.join(pluginDir, '.hotreload'), '');

const community = path.join(vault, '.obsidian', 'community-plugins.json');
if (!fs.existsSync(community)) fs.writeFileSync(community, JSON.stringify(['daily-desk']));

// Seed earlier days only; today's page is left for the plugin to create.
const { buildDailyNote, replaceBlockBody, addNoteSection, insertIntoSection, BLOCK } = loadHelpers();
const journal = path.join(vault, 'Journal');
fs.mkdirSync(journal, { recursive: true });
const seed = (daysAgo, board, nextDays) => {
  const m = moment().startOf('day').subtract(daysAgo, 'days');
  const file = path.join(journal, `${m.format('YYYY-MM-DD')}.md`);
  if (fs.existsSync(file)) return;
  let note = replaceBlockBody(buildDailyNote(m), BLOCK.board, board);
  note = addNoteSection(note, 'next').content;
  for (const line of nextDays.split('\n')) note = insertIntoSection(note, /notes for next days/i, line);
  fs.writeFileSync(file, note);
};
const d8 = moment().subtract(8, 'days').format('YYYY-MM-DD');
seed(8, '## Study\n- [ ] Read chapter 3\n- [x] Watch lecture 2', '- Buy a new notebook');
seed(3, '## Work\n- [/] Write the quarterly report\n- [ ] Reply to [[Project X]] email\n- [x] Standup', '- Ask about the deadline\n- [x] Already handled');
// A page in the 1.0 layout (a heading per section), to check old pages still work.
const old = moment().startOf('day').subtract(5, 'days');
const oldFile = path.join(journal, `${old.format('YYYY-MM-DD')}.md`);
if (!fs.existsSync(oldFile)) {
  fs.writeFileSync(oldFile, [
    '---', `daily-desk: ${old.format('YYYY-MM-DD')}`, '---', `# ${old.format('dddd D MMMM YYYY')}`, '',
    '```daily-desk-nav', '```', '', '```daily-desk-timer', '```', '',
    '## Left behind', '```daily-desk-carryover', '```', '',
    '## Tasks', '```daily-desk-board', '## Personal', '- [ ] Renew the passport', '```', '',
    '## From previous days', '```daily-desk-previous', '```', '',
    '## Notes for today', '- ', '', '## Notes for next days', '- Old-style note from the 1.0 layout', '',
  ].join('\n'));
}
seed(1, `## Work\n- [ ] Fix login bug\n\n## Personal\n- [ ] Call the dentist (since ${d8})\nnote to self: this line must survive edits`, '- Check the gym schedule');

console.log(`Test vault ready at ${path.resolve(vault)}`);

function loadHelpers() {
  // main.js requires 'obsidian'; give it just enough to load the pure helpers.
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'obsidian') return { moment, Plugin: class {}, Modal: class {}, PluginSettingTab: class {}, MarkdownRenderChild: class {} };
    return orig.call(this, req, ...rest);
  };
  try {
    return require(path.join(root, 'main.js'))._test;
  } finally {
    Module._load = orig;
  }
}
