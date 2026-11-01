import { build } from 'esbuild';
import { mkdir, copyFile, readdir, stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(resolve(root, 'miniprogram/services/generated'), { recursive: true });
await build({ entryPoints: [resolve(root, 'public/model.js')], outfile: resolve(root, 'miniprogram/services/generated/model.js'),
  platform: 'neutral', format: 'cjs', target: 'es2018', bundle: true, minify: true, legalComments: 'none',
  banner: { js: '// Generated from public/model.js by npm run build:miniprogram. Do not edit.' } });
await mkdir(resolve(root, 'miniprogram/assets'), { recursive: true });
for (const name of ['apples.jpg','goji.jpg','pear.jpg','potato.jpg','corn.jpg','onion.jpg','credits.json','media-products-credit.json']) {
  await copyFile(resolve(root, 'public/assets', name), resolve(root, 'miniprogram/assets', name));
}
// Keep the actual compiled package small enough for the base package, and fail
// instead of silently shipping secrets, videos or an entire web build.
let bytes = 0, files = 0;
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), name = relative(root, path);
    if (entry.isDirectory()) { await inspect(path); continue; }
    if (!entry.isFile()) throw new Error('Mini-program package contains a non-regular file.');
    if (/\.(?:mp4|webm|mov|pem|key)$|(?:^|\/)\.env/.test(name)) throw new Error('Forbidden private or oversized package asset.');
    const info = await stat(path); bytes += info.size; files++;
    if (/\.(?:js|json)$/.test(name)) {
      const text = await readFile(path, 'utf8');
      if (/\b(?:WECHAT_APP_SECRET|OAI-Sites-Authorization)\b/.test(text)) throw new Error('Server credential key must not enter the mini-program package.');
    }
  }
}
await inspect(resolve(root, 'miniprogram'));
if (bytes > 2 * 1024 * 1024) throw new Error(`Mini-program base package is too large: ${bytes} bytes.`);
console.log(JSON.stringify({ miniProgram: 'native', files, bytes, sizeLimit: 2 * 1024 * 1024, payment: false }));
