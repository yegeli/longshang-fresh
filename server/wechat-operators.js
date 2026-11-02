import { MERCHANT_PERMISSIONS, merchantDTO } from './merchant-access.js';

const BASE = '/api/v1/admin/wechat/merchants';
const MERCHANT_ID = /^MERCHANT-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const USER_ID = /^wechat:[a-f0-9]{64}$/;
const uuid = prefix => `${prefix}-${crypto.randomUUID().toUpperCase()}`;

// The legacy column is NOT an email invitation here. This deliberately invalid
// email marker cannot be claimed through Sites' verified-email login flow.
const accountMarker = userId => `wechat-account:${userId.slice(7)}`;

export async function handleWechatOperators(request, env, helpers) {
  const path = new URL(request.url).pathname;
  if (path !== BASE && !path.startsWith(BASE + '/')) return null;
  const { manager, requireDB, fail, json, jsonBody, sameOrigin, method } = helpers;
  if (env.AUTH_MODE !== 'wechat') fail(404, 'not_found', '接口不存在。');
  const actor = await manager(request, env, true), db = requireDB(env), appId = env.WECHAT_APP_ID;
  const get = async id => {
    if (!MERCHANT_ID.test(id)) fail(404, 'not_found', '微信采购者档案不存在。');
    const row = await db.prepare(`SELECT m.* FROM merchant_accounts m JOIN wechat_identities i ON i.user_id=m.user_id
      WHERE m.id=? AND i.app_id=?`).bind(id, appId).first();
    if (!row) fail(404, 'not_found', '微信采购者档案不存在。');
    return row;
  };
  const fields = body => {
    const allowed = ['userId', 'name', 'region', 'status', 'permissions', ...(request.method === 'PUT' ? ['expectedVersion'] : [])];
    if (Object.keys(body).some(key => !allowed.includes(key)) || !USER_ID.test(body.userId || '')) fail(400, 'merchant_invalid', '请填写已登录的微信账号编号，不要填写邮箱或OpenID。');
    const text = (key, limit) => {
      if (typeof body[key] !== 'string' || !body[key].trim() || body[key].trim().length > limit || /[\u0000-\u001f\u007f]/u.test(body[key])) fail(400, 'merchant_invalid', '采购者名称或地区无效。');
      return body[key].trim();
    };
    if (!['enabled', 'disabled'].includes(body.status) || !Array.isArray(body.permissions) || body.permissions.length > 3
      || new Set(body.permissions).size !== body.permissions.length || body.permissions.some(value => !MERCHANT_PERMISSIONS.includes(value))) fail(400, 'merchant_invalid', '采购者状态或权限无效。');
    return { userId: body.userId, name: text('name', 80), region: text('region', 100), status: body.status,
      permissions: MERCHANT_PERMISSIONS.filter(value => body.permissions.includes(value)) };
  };
  const target = async userId => {
    const row = await db.prepare(`SELECT u.user_id,u.role FROM users u JOIN wechat_identities i ON i.user_id=u.user_id
      WHERE u.user_id=? AND i.app_id=?`).bind(userId, appId).first();
    if (!row) fail(422, 'wechat_account_required', '该账号尚未在当前小程序完成微信登录，请先登录并复制账号编号。');
    if (row.role === 'admin') fail(409, 'admin_protected', '管理员不能作为采购者添加、修改或停用。');
    return row;
  };
  const actorGuard = `EXISTS(SELECT 1 FROM users au JOIN wechat_identities ai ON ai.user_id=au.user_id WHERE au.user_id=? AND au.role='admin' AND ai.app_id=?)`;
  if (path === BASE && request.method === 'GET') {
    const rows = (await db.prepare(`SELECT m.* FROM merchant_accounts m JOIN wechat_identities i ON i.user_id=m.user_id WHERE i.app_id=? ORDER BY m.created_at DESC,m.id DESC`).bind(appId).all()).results || [];
    return json({ merchants: rows.map(merchantDTO), updatedAt: new Date().toISOString() });
  }
  if (path === BASE && request.method === 'POST') {
    sameOrigin(request);
    const input = fields(await jsonBody(request, 4096)), user = await target(input.userId);
    if (user.role !== 'buyer' || await db.prepare('SELECT id FROM merchant_accounts WHERE user_id=?').bind(input.userId).first()) fail(409, 'merchant_duplicate', '该微信账号已绑定采购者档案。');
    const id = uuid('MERCHANT'), time = new Date().toISOString();
    const after = { ...input, id, email: '', authProvider: 'wechat', bound: true, version: 1, createdAt: time, updatedAt: time };
    const results = await db.batch([
      db.prepare(`INSERT INTO merchant_accounts(id,email,user_id,name,region,status,permissions_json,version,created_at,updated_at,created_by,updated_by)
        SELECT ?,?,?,?,?,?,?,1,?,?,?,? WHERE ${actorGuard} AND (SELECT count(*) FROM merchant_accounts)<200
        AND EXISTS(SELECT 1 FROM users tu JOIN wechat_identities ti ON ti.user_id=tu.user_id WHERE tu.user_id=? AND tu.role='buyer' AND ti.app_id=?)
        AND NOT EXISTS(SELECT 1 FROM merchant_accounts WHERE user_id=?) ON CONFLICT DO NOTHING`)
        .bind(id, accountMarker(input.userId), input.userId, input.name, input.region, input.status, JSON.stringify(input.permissions), time, time, actor.id, actor.id, actor.id, appId, input.userId, appId, input.userId),
      db.prepare("UPDATE users SET role='merchant',updated_at=? WHERE user_id=? AND role='buyer' AND changes()=1")
        .bind(time, input.userId),
      db.prepare("INSERT INTO merchant_audit(id,merchant_id,actor_id,action,before_json,after_json,created_at) SELECT ?,?,?,'created',NULL,?,? WHERE changes()=1")
        .bind(uuid('AUDIT'), id, actor.id, JSON.stringify(after), time)
    ]);
    if (!results[0].meta?.changes || !results[1].meta?.changes) fail(409, 'merchant_conflict', '账号或管理权限已变化，或采购者数量已达上限，请重新读取后核对。');
    return json({ merchant: merchantDTO(await get(id)) }, 201);
  }
  if (path === BASE) method(request, ['GET', 'POST']);
  const match = new RegExp(`^${BASE}/([^/]+)(/audit)?$`).exec(path);
  if (!match) fail(404, 'not_found', '接口不存在。');
  const [, id, audit] = match, existing = await get(id);
  if (audit) {
    method(request, ['GET']);
    const rows = (await db.prepare('SELECT a.*,u.name actor_name FROM merchant_audit a JOIN users u ON u.user_id=a.actor_id WHERE merchant_id=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT 50').bind(id).all()).results || [];
    return json({ events: rows.map(row => ({ id: row.id, action: row.action, createdAt: row.created_at, actorName: row.actor_name,
      before: row.before_json ? JSON.parse(row.before_json) : null, after: JSON.parse(row.after_json) })) });
  }
  if (request.method === 'GET') return json({ merchant: merchantDTO(existing) });
  method(request, ['GET', 'PUT']); sameOrigin(request);
  const body = await jsonBody(request, 4096), input = fields(body);
  if (input.userId !== existing.user_id) fail(409, 'merchant_bound', '微信账号绑定后不能更换归属，请为新账号另建档案。');
  await target(input.userId);
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 || body.expectedVersion >= Number.MAX_SAFE_INTEGER) fail(400, 'version_invalid', '请填写有效档案版本。');
  if (existing.version !== body.expectedVersion) fail(409, 'version_conflict', '采购者档案已更新，请重新读取后再修改。');
  const time = new Date().toISOString(), after = { ...merchantDTO(existing), ...input, version: existing.version + 1, updatedAt: time };
  const results = await db.batch([
    db.prepare(`UPDATE merchant_accounts SET name=?,region=?,status=?,permissions_json=?,version=version+1,updated_at=?,updated_by=?
      WHERE id=? AND version=? AND user_id=? AND ${actorGuard}
      AND EXISTS(SELECT 1 FROM users tu JOIN wechat_identities ti ON ti.user_id=tu.user_id WHERE tu.user_id=merchant_accounts.user_id AND tu.role='merchant' AND ti.app_id=?)`)
      .bind(input.name, input.region, input.status, JSON.stringify(input.permissions), time, actor.id, id, body.expectedVersion, input.userId, actor.id, appId, appId),
    db.prepare("INSERT INTO merchant_audit(id,merchant_id,actor_id,action,before_json,after_json,created_at) SELECT ?,?,?,'updated',?,?,? WHERE changes()=1")
      .bind(uuid('AUDIT'), id, actor.id, JSON.stringify(merchantDTO(existing)), JSON.stringify(after), time)
  ]);
  if (!results[0].meta?.changes) fail(409, 'version_conflict', '采购者档案或管理权限已变化，请重新读取后核对。');
  return json({ merchant: merchantDTO(await get(id)) });
}
