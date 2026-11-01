import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function parseWechatAppId(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--tourist')) return 'touristappid';
  if (args.length !== 2 || args[0] !== '--appid' || !/^wx[a-f0-9]{16}$/.test(args[1])) throw new Error('Usage: npm run wechat:configure -- --appid wxXXXXXXXXXXXXXXXX (AppID only, never AppSecret).');
  return args[1];
}
export async function configureWechat(root, args) {
  const appid = parseWechatAppId(args);
  const example = JSON.parse(await readFile(resolve(root, 'project.config.example.json'), 'utf8'));
  const path = resolve(root, 'project.config.json');
  let previous;
  try { previous = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.appid && previous.appid !== 'touristappid' && previous.appid !== appid) throw new Error('An existing AppID is configured. Preserve it or edit the local configuration explicitly.');
  await writeFile(path, JSON.stringify({ ...example, ...previous, miniprogramRoot: 'miniprogram/', compileType: 'miniprogram', appid }, null, 2) + '\n');
  return { path, appid, mode: appid === 'touristappid' ? 'local-development' : 'registered-project', uploaded: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await configureWechat(fileURLToPath(new URL('../', import.meta.url)), process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
