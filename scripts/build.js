'use strict';
// Makes the files Obsidian installs from the sources in src/. The plugin is plain JavaScript, so
// building is a syntax check and a copy. The sources can't be called main.js or styles.css: build
// verification deletes every file with those names before it runs this.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const src = (f) => path.join(root, 'src', f);

execFileSync(process.execPath, ['--check', src('plugin.js')], { stdio: 'inherit' });
fs.copyFileSync(src('plugin.js'), path.join(root, 'main.js'));
fs.copyFileSync(src('plugin.css'), path.join(root, 'styles.css'));
