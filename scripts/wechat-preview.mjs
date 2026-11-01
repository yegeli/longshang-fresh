import { createRequire } from 'node:module';
import { createPrivateKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat, realpath, mkdir, mkdtemp, cp, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute, sep, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function previewInputs(root, args) {
  if (args.length !== 2 || args[0] !== '--key-file' || !isAbsolute(args[1])) throw new Error('Use --key-file with an absolute path to the authorized WeChat upload key outside this repository. Do not provide AppSecret.');
  const config = JSON.parse(await readFile(join(root, 'project.config.json'), 'utf8'));
  if (!/^wx[a-f0-9]{16}$/.test(config.appid || '')) throw new Error('Configure the actual AppID before preview; a tourist project cannot be uploaded.');
  const [base, keyFile] = await Promise.all([realpath(root), realpath(args[1])]);
  if (keyFile === base || keyFile.startsWith(base + sep)) throw new Error('Keep the upload private key outside the repository.');
  const info = await stat(keyFile);
  if (!info.isFile() || info.size > 32768) throw new Error('Invalid upload key file.');
  const privateKey = await readFile(keyFile, 'utf8');
  if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw new Error('Use the WeChat upload RSA key, not AppSecret or a session token.');
  return { config, privateKey };
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { config, privateKey } = await previewInputs(root, process.argv.slice(2));
  for (const script of ['build-miniprogram.mjs', 'check-miniprogram.mjs']) {
    execFileSync(process.execPath, [join(root, 'scripts', script)], { cwd: root, stdio: 'inherit' });
  }
  const require = createRequire(import.meta.url);
  const ci = require('../tools/wechat/node_modules/miniprogram-ci');
  const local = join(root, '.wechat-local');
  await mkdir(local, { recursive: true });
  const staging = await mkdtemp(join(local, 'preview-'));
  // Upload only a newly staged native project, never the repository, server
  // source, developer state, local credentials or previous generated output.
  await cp(join(root, 'miniprogram'), join(staging, 'miniprogram'), { recursive: true });
  await writeFile(join(staging, 'project.config.json'), JSON.stringify({ ...config, miniprogramRoot: 'miniprogram/' }, null, 2));
  const qr = join(staging, 'preview.png');
  const project = new ci.Project({ appid: config.appid, type: 'miniProgram', projectPath: staging, privateKey,
    ignores: ['node_modules/**/*', '*.key', '*.pem', '.env*'] });
  await ci.preview({ project, desc: '陇上鲜集原生模拟流程开发预览，不接支付', setting: { useProjectConfig: true },
    qrcodeFormat: 'image', qrcodeOutputDest: qr, pagePath: 'pages/home/index', onProgressUpdate: () => {} });
  if ((await stat(qr)).size === 0) throw new Error('No preview image was returned.');
  console.log(JSON.stringify({ previewUploaded: true, qr, appid: config.appid, reviewSubmitted: false, published: false, realDeviceVerified: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    // SDK failures can contain request data. Never echo keys or remote payloads.
    const code = Number.isInteger(error?.errCode) ? error.errCode : null;
    console.error(JSON.stringify({ previewUploaded: false, code, message: '微信预览未确认成功。请核对实际AppID、仓库外的上传私钥、官方工具安装及微信后台上传权限；不要发送密钥到聊天。' }));
    process.exitCode = 1;
  }
}
