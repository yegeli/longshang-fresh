#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const appRoot = path.join(root, 'miniprogram');
const output = path.join(root, 'qa', 'wechat-compile');
const require = createRequire(import.meta.url);
if (!['darwin', 'win32'].includes(process.platform)) {
  console.error('The pinned official offline WCC/WCSC binaries support macOS and Windows. Run this optional compiler there; Linux checks do not replace it.');
  process.exit(1);
}
let ci, native, ciVersion;
try {
  // Isolated official tool dependencies; no CI Project, private key, AppID,
  // provider request, preview upload or remote attribute lookup is involved.
  ci = require('../tools/wechat/node_modules/miniprogram-ci');
  native = require('../tools/wechat/node_modules/miniprogram-ci/dist/modules/fullcompiler/trans/wcc/lib');
  ciVersion = require('../tools/wechat/node_modules/miniprogram-ci/package.json').version;
} catch {
  console.error('Install the isolated official compiler first: npm ci --prefix tools/wechat');
  process.exit(1);
}

function filesIn(directory, files = [], dirs = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name), relative = path.relative(appRoot, full).split(path.sep).join('/');
    if (entry.isDirectory()) { dirs.push(relative); filesIn(full, files, dirs); }
    else if (entry.isFile()) files.push(relative);
  }
  return { files: files.sort(), dirs: dirs.sort() };
}
const inventory = filesIn(appRoot);

// DevtoolsProject is the package's public local-project abstraction. Its base
// class supplies stat/file-list/events; only filesystem reads are implemented.
// The compiler sees the miniprogram directory itself, so it neither reads the
// user's project.config.json nor creates fake upload credentials.
class OfflineProject extends ci.DevtoolsProject {
  constructor() {
    super();
    this._projectPath = appRoot;
    this._type = 'miniProgram';
    this._miniprogramRoot = '';
    this._pluginRoot = '';
    this._fileSet = new Set(inventory.files);
    this._dirSet = new Set(inventory.dirs);
  }
  getSrcFile(prefix, file) {
    const full = path.resolve(appRoot, prefix, file);
    assert.ok(full.startsWith(appRoot + path.sep), 'Compiler tried to read outside the mini-program source.');
    return readFileSync(full);
  }
  getFile(prefix, file) { return this.getSrcFile(prefix, file); }
}

async function main() {
  const templates = inventory.files.filter(file => file.endsWith('.wxml'));
  const styles = inventory.files.filter(file => file.endsWith('.wxss'));
  const scripts = inventory.files.filter(file => file.endsWith('.js'));
  assert.ok(templates.length && styles.length && scripts.length, 'Build the native mini-program assets before compiling.');
  await mkdir(output, { recursive: true });
  const options = files => ({ files: files.map(file => './' + file), contents: files.map(file => readFileSync(path.join(appRoot, file), 'utf8')), cwd: appRoot });
  const wxml = await native.wcc(options(templates));
  assert.ok(typeof wxml === 'string' && wxml.length > 0, 'WXML compiler produced no code.');
  // WCSC's native ABI expects this to equal the number of stylesheet roots,
  // not the app.json page count. Other CSS files, if added, are roots as well.
  const wxss = await native.wcsc({ ...options(styles), pageCount: styles.length });
  assert.ok(wxss && Object.keys(wxss).length > 0, 'WXSS compiler produced no code.');
  await writeFile(path.join(output, 'wxml.js'), wxml);
  await writeFile(path.join(output, 'wxss.json'), JSON.stringify(wxss));
  const project = new OfflineProject();
  let javascriptBytes = 0;
  // Match the project's enhanced ES6 compilation path. Running the old legacy
  // ES6 parser would incorrectly reject supported optional chaining syntax.
  for (const file of scripts) {
    const result = await ci.compileJS(project, file, { sourceCode: readFileSync(path.join(appRoot, file), 'utf8'),
      setting: { enhance: true, es6: true, es7: true, minifyJS: false } });
    assert.ok(!result.error && typeof result.code === 'string', `JavaScript compilation failed: ${file}`);
    const target = path.join(output, 'js', file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, result.code);
    javascriptBytes += Buffer.byteLength(result.code);
  }
  console.log(JSON.stringify({ result: 'PASS', compiler: `miniprogram-ci@${ciVersion}`, offline: true,
    templates: templates.length, stylesheets: styles.length, javascript: scripts.length,
    wxmlBytes: Buffer.byteLength(wxml), wxssBytes: Buffer.byteLength(JSON.stringify(wxss)), javascriptBytes,
    output: 'qa/wechat-compile', upload: false, appIdRequired: false, privateKeyRequired: false,
    realDeviceVerified: false }));
}
await main();
