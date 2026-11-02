#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export function validateBootstrapTarget({ appId, userId }) {
  assert.match(appId || '', /^wx[a-f0-9]{16}$/, 'An actual AppID is required.');
  assert.match(userId || '', /^wechat:[a-f0-9]{64}$/, 'Use the exact account ID copied after verified WeChat login.');
  return { appId, userId };
}

export function bootstrapWechatAdminSQL(target) {
  const { appId, userId } = validateBootstrapTarget(target);
  // All substitutions have been constrained to fixed alphabets. The durable
  // singleton chooses one explicit target even when separate CLI runs race.
  // Each grant is a single guarded write. If execution stops after the claim,
  // retrying the SAME target can finish; another target can never take it over.
  return `INSERT INTO admin_bootstrap(singleton,user_id,claimed_at)
SELECT 1,u.user_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM users u JOIN wechat_identities i ON i.user_id=u.user_id
WHERE u.user_id='${userId}' AND i.app_id='${appId}' AND u.role='buyer'
AND NOT EXISTS(SELECT 1 FROM users WHERE role='admin')
AND NOT EXISTS(SELECT 1 FROM merchant_accounts WHERE user_id=u.user_id)
ON CONFLICT(singleton) DO NOTHING;

UPDATE users SET role='admin',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE user_id='${userId}' AND role='buyer'
AND EXISTS(SELECT 1 FROM admin_bootstrap WHERE singleton=1 AND user_id=users.user_id)
AND EXISTS(SELECT 1 FROM wechat_identities WHERE user_id=users.user_id AND app_id='${appId}')
AND NOT EXISTS(SELECT 1 FROM users other WHERE other.role='admin' AND other.user_id<>users.user_id)
AND NOT EXISTS(SELECT 1 FROM merchant_accounts WHERE user_id=users.user_id);

SELECT CASE WHEN EXISTS(SELECT 1 FROM users u JOIN wechat_identities i ON i.user_id=u.user_id
JOIN admin_bootstrap b ON b.user_id=u.user_id AND b.singleton=1
WHERE u.user_id='${userId}' AND i.app_id='${appId}' AND u.role='admin')
THEN 1 ELSE 0 END AS bootstrap_verified;
`;
}

export function parseBootstrapArgs(args) {
  const result = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') { assert.equal(result.apply, false, 'Duplicate option.'); result.apply = true; continue; }
    if (arg === '--local' || arg === '--remote') { assert.equal(result.mode, undefined, 'Choose exactly one database mode.'); result.mode = arg; continue; }
    const name = { '--appid': 'appId', '--user-id': 'userId', '--config': 'config', '--confirm-appid': 'confirmAppId' }[arg];
    assert.ok(name && args[i + 1] && !args[i + 1].startsWith('--') && result[name] === undefined, 'Unknown, missing or duplicate bootstrap argument.');
    result[name] = args[++i];
  }
  validateBootstrapTarget(result);
  if (result.apply) {
    assert.ok(result.config && result.mode, 'Applying requires --config and exactly one of --local/--remote.');
    assert.equal(result.confirmAppId, result.appId, 'Confirm the exact AppID with --confirm-appid.');
  } else assert.ok(!result.config && !result.mode && !result.confirmAppId, 'Execution options require explicit --apply.');
  return result;
}

export function validateBootstrapConfig(config, target) {
  validateBootstrapTarget(target);
  assert.ok(config && typeof config === 'object' && !Array.isArray(config), 'Use a strict JSON Wrangler configuration.');
  assert.equal(config.vars?.WECHAT_APP_ID, target.appId, 'Configuration AppID does not match the selected target.');
  assert.equal(config.vars?.AUTH_MODE, 'wechat', 'Only a standalone WeChat database is supported.');
  assert.ok(Array.isArray(config.d1_databases), 'D1 DB binding is required.');
  const databases = config.d1_databases.filter(value => value.binding === 'DB');
  assert.equal(databases.length, 1, 'Exactly one D1 DB binding is required.');
  assert.match(databases[0].database_id || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, 'Configure an actual D1 database identifier.');
  return true;
}

export async function runBootstrap(args, root = fileURLToPath(new URL('../', import.meta.url))) {
  const input = parseBootstrapArgs(args), local = resolve(root, '.wechat-local');
  await mkdir(local, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(local), local, 'The local setup directory must not be a symlink.');
  const output = resolve(local, `bootstrap-admin-${Date.now()}-${crypto.randomUUID()}.sql`);
  await writeFile(output, bootstrapWechatAdminSQL(input), { flag: 'wx', mode: 0o600 });
  if (!input.apply) return { generated: true, applied: false, path: output, message: 'Review the explicit account target locally; no role has been changed.' };
  const configPath = resolve(input.config);
  // Strict JSON is deliberate: do not silently parse the wrong AppID or load
  // arbitrary JS configuration while granting privileged access.
  validateBootstrapConfig(JSON.parse(await readFile(configPath, 'utf8')), input);
  const child = spawnSync(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB',
    '--config', configPath, input.mode, '--file', output, '--json'], { cwd: dirname(configPath), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 0, 'Database command did not confirm success. Recheck credentials/configuration; no result is assumed.');
  let results;
  try { results = JSON.parse(child.stdout); } catch { throw new Error('Database command did not return verifiable JSON.'); }
  assert.ok(Array.isArray(results) && results.length > 0 && results.every(value => value.success !== false), 'Database command returned a failure.');
  assert.ok(results.some(value => value.results?.some(row => row.bootstrap_verified === 1)), 'The exact account was not confirmed as bootstrap administrator.');
  return { generated: true, applied: true, verified: true, path: output, mode: input.mode.slice(2) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runBootstrap(process.argv.slice(2)))); }
  catch {
    // Credentials, SQL and remote database payloads are not echoed to logs.
    console.error('微信首位管理员未确认配置成功。请核对明确账号、AppID、严格JSON本机配置和执行授权；不要发送密钥到聊天。');
    process.exitCode = 1;
  }
}
