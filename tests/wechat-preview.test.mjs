import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewInputs } from '../scripts/wechat-preview.mjs';

test('preview refuses tourist projects, secrets in argv, repository keys and symlinked repository keys before any upload', async t => {
  const area = await mkdtemp(join(tmpdir(), 'longshang-preview-'));
  t.after(() => rm(area, { recursive: true, force: true }));
  const root = join(area, 'repo'); await mkdir(root);
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const outside = join(area, 'test.key'); await writeFile(outside, privateKey);
  await writeFile(join(root, 'project.config.json'), JSON.stringify({ appid: 'touristappid' }));
  await assert.rejects(previewInputs(root, ['--key-file', outside]), /actual AppID/);
  await assert.rejects(previewInputs(root, ['--secret', 'example']), /--key-file/);
  await writeFile(join(root, 'project.config.json'), JSON.stringify({ appid: 'wx1234567890abcdef' }));
  const input = await previewInputs(root, ['--key-file', outside]);
  assert.equal(input.config.appid, 'wx1234567890abcdef');
  assert.equal(input.privateKey, privateKey);
  const inside = join(root, 'wrong.key'); await writeFile(inside, privateKey);
  await assert.rejects(previewInputs(root, ['--key-file', inside]), /outside the repository/);
  const link = join(area, 'link.key'); await symlink(inside, link);
  await assert.rejects(previewInputs(root, ['--key-file', link]), /outside the repository/);
});
