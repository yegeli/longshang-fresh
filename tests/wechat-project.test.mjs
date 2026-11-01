import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureWechat, parseWechatAppId } from '../scripts/configure-wechat.mjs';

test('local WeChat project configuration accepts only AppID and preserves existing identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'longshang-wx-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(new URL('../project.config.example.json', import.meta.url), join(root, 'project.config.example.json'));
  assert.equal(parseWechatAppId([]), 'touristappid');
  for (const args of [['--secret','not-a-secret'],['--appid','bad'],['--appid','wx1234567890abcdef','extra']]) assert.throws(() => parseWechatAppId(args));
  await configureWechat(root, ['--appid','wx1234567890abcdef']);
  const saved = JSON.parse(await readFile(join(root,'project.config.json'),'utf8'));
  assert.equal(saved.appid, 'wx1234567890abcdef');
  assert.equal(saved.miniprogramRoot, 'miniprogram/');
  assert.equal(saved.setting.urlCheck, true);
  await configureWechat(root, ['--appid','wx1234567890abcdef']);
  await assert.rejects(configureWechat(root, []), /existing AppID/);
  await assert.rejects(configureWechat(root, ['--appid','wx0000000000000001']), /existing AppID/);
  assert.equal(JSON.parse(await readFile(join(root,'project.config.json'),'utf8')).appid, saved.appid);
});
