import { MERCHANT_PERMISSIONS, merchantDTO } from './merchant-access.js';

const BASE = '/api/v1/admin/merchants';
const ID = /^MERCHANT-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const uuid = prefix => `${prefix}-${crypto.randomUUID().toUpperCase()}`;

export async function handleMerchantApi(request, env, helpers) {
  const path = new URL(request.url).pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return null;
  // A verified WeChat subject has no verified email invitation to claim.
  // Its operator authorizations use the separate explicit-account API.
  if (env.AUTH_MODE === 'wechat') helpers.fail(404, 'not_found', '请使用微信采购者账号管理入口。');
  const { manager, requireDB, fail, json, jsonBody, sameOrigin, method } = helpers;
  const user = await manager(request, env, true), db = requireDB(env);
  const get = async id => {
    if (!ID.test(id)) fail(404, 'not_found', '商家档案不存在。');
    const row = await db.prepare('SELECT * FROM merchant_accounts WHERE id=?').bind(id).first();
    if (!row) fail(404, 'not_found', '商家档案不存在。');
    return row;
  };
  const checkAdminEmail = async email => {
    if (await db.prepare("SELECT user_id FROM users WHERE lower(email)=? AND role='admin' LIMIT 1").bind(email).first()) fail(409, 'admin_protected', '管理员账号不能作为采购者添加或停用。');
  };
  const fields = body => {
    const allowed = ['name', 'email', 'region', 'status', 'permissions', ...(request.method === 'PUT' ? ['expectedVersion'] : [])];
    if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'merchant_invalid', '商家请求含未知字段。');
    const text = (key, limit) => {
      if (typeof body[key] !== 'string' || !body[key].trim() || body[key].trim().length > limit || /[\u0000-\u001f\u007f]/u.test(body[key])) fail(400, 'merchant_invalid', `${key} 内容无效或超长。`);
      return body[key].trim();
    };
    const email = text('email', 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'merchant_invalid', '请填写有效的登录邮箱。');
    if (!['enabled', 'disabled'].includes(body.status) || !Array.isArray(body.permissions) || body.permissions.length > 3
      || body.permissions.some(permission => !MERCHANT_PERMISSIONS.includes(permission)) || new Set(body.permissions).size !== body.permissions.length) fail(400, 'merchant_invalid', '商家状态或权限无效。');
    return { name: text('name', 80), email, region: text('region', 100), status: body.status, permissions: MERCHANT_PERMISSIONS.filter(permission => body.permissions.includes(permission)) };
  };
  if (path === BASE && request.method === 'GET') {
    const rows = (await db.prepare('SELECT * FROM merchant_accounts ORDER BY created_at DESC,id DESC').all()).results || [];
    return json({ merchants: rows.map(merchantDTO), updatedAt: new Date().toISOString() });
  }
  if (path === BASE && request.method === 'POST') {
    sameOrigin(request); const input = fields(await jsonBody(request)); await checkAdminEmail(input.email);
    if (await db.prepare('SELECT id FROM merchant_accounts WHERE email=?').bind(input.email).first()) fail(409, 'merchant_duplicate', '该登录邮箱已存在商家档案。');
    const id = uuid('MERCHANT'), time = new Date().toISOString();
    const after = { ...input, id, version: 1, createdAt: time, updatedAt: time, bound: false };
    const results = await db.batch([
      db.prepare(`INSERT INTO merchant_accounts(id,email,user_id,name,region,status,permissions_json,version,created_at,updated_at,created_by,updated_by)
        SELECT ?,?,NULL,?,?,?,?,1,?,?,?,? WHERE (SELECT count(*) FROM merchant_accounts)<200 AND EXISTS(SELECT 1 FROM users WHERE user_id=? AND role='admin')
        AND NOT EXISTS(SELECT 1 FROM users WHERE lower(email)=? AND role='admin')
        ON CONFLICT(email) DO NOTHING`).bind(id, input.email, input.name, input.region, input.status, JSON.stringify(input.permissions), time, time, user.id, user.id, user.id, input.email),
      db.prepare("INSERT INTO merchant_audit(id,merchant_id,actor_id,action,before_json,after_json,created_at) SELECT ?,?,?,'created',NULL,?,? WHERE changes()=1").bind(uuid('AUDIT'), id, user.id, JSON.stringify(after), time)
    ]);
    if (!results[0].meta?.changes) {
      if (await db.prepare('SELECT id FROM merchant_accounts WHERE email=?').bind(input.email).first()) fail(409, 'merchant_duplicate', '该登录邮箱已存在商家档案。');
      fail(422, 'merchant_limit', '无法新增：请确认管理权限，当前最多支持200个商家档案。');
    }
    return json({ merchant: merchantDTO(await get(id)) }, 201);
  }
  if (path === BASE) method(request, ['GET', 'POST']);
  const match = new RegExp(`^${BASE}/([^/]+)(/audit)?$`).exec(path);
  if (!match) fail(404, 'not_found', '接口不存在。');
  const [, id, audit] = match, existing = await get(id);
  if (audit) {
    method(request, ['GET']);
    const rows = (await db.prepare(`SELECT a.*,u.name actor_name FROM merchant_audit a JOIN users u ON u.user_id=a.actor_id WHERE merchant_id=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT 50`).bind(id).all()).results || [];
    return json({ events: rows.map(row => ({ id: row.id, action: row.action, createdAt: row.created_at, actorName: row.actor_name, before: row.before_json ? JSON.parse(row.before_json) : null, after: JSON.parse(row.after_json) })) });
  }
  if (request.method === 'GET') return json({ merchant: merchantDTO(existing) });
  method(request, ['GET', 'PUT']); sameOrigin(request);
  const body = await jsonBody(request), input = fields(body);
  if (existing.user_id && await db.prepare("SELECT user_id FROM users WHERE user_id=? AND role='admin'").bind(existing.user_id).first()) fail(409, 'admin_protected', '管理员账号不能作为采购者修改或停用。');
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 || body.expectedVersion >= Number.MAX_SAFE_INTEGER) fail(400, 'version_invalid', '请填写有效商家版本。');
  if (existing.version !== body.expectedVersion) fail(409, 'version_conflict', '商家档案已更新，请重新读取后再修改。');
  if (existing.user_id && existing.email !== input.email) fail(409, 'merchant_bound', '账号绑定后不能更换登录邮箱或转让归属。');
  await checkAdminEmail(input.email);
  if (await db.prepare('SELECT id FROM merchant_accounts WHERE email=? AND id<>?').bind(input.email, id).first()) fail(409, 'merchant_duplicate', '该登录邮箱已存在商家档案。');
  const time = new Date().toISOString(), after = { ...merchantDTO(existing), ...input, version: existing.version + 1, updatedAt: time };
  const results = await db.batch([
    db.prepare(`UPDATE merchant_accounts SET name=?,email=?,region=?,status=?,permissions_json=?,version=version+1,updated_at=?,updated_by=?
      WHERE id=? AND version=? AND (user_id IS NULL OR email=?) AND EXISTS(SELECT 1 FROM users WHERE user_id=? AND role='admin')
      AND NOT EXISTS(SELECT 1 FROM users WHERE (lower(email)=? OR users.user_id=merchant_accounts.user_id) AND role='admin')
      AND NOT EXISTS(SELECT 1 FROM merchant_accounts other WHERE other.email=? AND other.id<>?)`)
      .bind(input.name, input.email, input.region, input.status, JSON.stringify(input.permissions), time, user.id, id, body.expectedVersion, input.email, user.id, input.email, input.email, id),
    db.prepare("INSERT INTO merchant_audit(id,merchant_id,actor_id,action,before_json,after_json,created_at) SELECT ?,?,?,'updated',?,?,? WHERE changes()=1")
      .bind(uuid('AUDIT'), id, user.id, JSON.stringify(merchantDTO(existing)), JSON.stringify(after), time)
  ]);
  if (!results[0].meta?.changes) fail(409, 'version_conflict', '商家档案或管理权限已变化，请重新读取后再修改。');
  return json({ merchant: merchantDTO(await get(id)) });
}
