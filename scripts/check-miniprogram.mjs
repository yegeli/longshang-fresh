import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mini = resolve(root, 'miniprogram');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const app = await readJSON(resolve(mini, 'app.json'));
const project = await readJSON(resolve(root, 'project.config.example.json'));
assert.equal(project.compileType, 'miniprogram');
assert.equal(project.miniprogramRoot, 'miniprogram/');
assert.equal(project.setting.urlCheck, true, 'Do not bypass native domain checking.');
assert.equal(new Set(app.pages).size, app.pages.length);
assert.ok(app.pages.length >= 13);
assert.equal(app.tabBar.list.length, 4);
for (const tab of app.tabBar.list) assert.ok(app.pages.includes(tab.pagePath), 'Tab is not a registered page.');
await readJSON(resolve(mini, app.sitemapLocation));
for (const page of app.pages) {
  assert.match(page, /^pages\/[a-z-]+\/index$/);
  const [js, wxml] = await Promise.all(['js','wxml'].map(ext => readFile(resolve(mini, page + '.' + ext), 'utf8')));
  assert.ok(js.trim() && wxml.trim(), 'Native pages must have implementation and a template.');
  assert.doesNotMatch(wxml, /<\s*(?:web-view|iframe|html|body|div|script)\b/i, 'Use native WXML instead of a website wrapper.');
  const config = await readJSON(resolve(mini, page + '.json'));
  assert.ok(config.navigationBarTitleText, 'Each page needs a clear navigation title.');
}
let bytes = 0, files = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else {
      assert.ok(entry.isFile(), 'No package symlinks.');
      bytes += (await stat(path)).size; files++;
      if (entry.name.endsWith('.json')) await readJSON(path);
    }
  }
}
await walk(mini);
assert.ok(bytes <= 2 * 1024 * 1024, 'Native main package exceeds 2 MiB.');
console.log(JSON.stringify({ result: 'PASS', nativePages: app.pages.length, tabs: app.tabBar.list.length, files, bytes, payment: false, validation: 'source/package only; official compilation and real-device preview are separate checks' }));
