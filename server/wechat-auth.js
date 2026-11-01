import { MERCHANT_PERMISSIONS, merchantDTO } from './merchant-access.js';

const LOGIN = '/api/v1/auth/wechat/login';
const LOGOUT = '/api/v1/auth/wechat/logout';
const TOKEN = /^wxs_[a-f0-9]{64}$/;
const TTL = 7 * 24 * 60 * 60 * 1000;
const PROVIDER = 'https://api.weixin.qq.com/sns/jscode2session';
const encode = value => new TextEncoder().encode(value);
export async function wechatDigest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  return `wxs_${Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
function appId(env, fail) {
  if (typeof env.WECHAT_APP_ID !== 'string' || !/^wx[a-f0-9]{16}$/.test(env.WECHAT_APP_ID)) fail(503, 'wechat_unconfigured', '微信登录尚未配置，请联系管理员。');
  return env.WECHAT_APP_ID;
}

// The native client uses an explicit bearer session, never ambient cookies or
// the Sites dispatch headers. A browser-supplied foreign Origin is still denied.
export function wechatWriteOrigin(request, fail, requireBearer = true) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) fail(403, 'origin_rejected', '此写入来源不被允许。');
  if (requireBearer && !/^Bearer wxs_[a-f0-9]{64}$/.test(request.headers.get('Authorization') || '')) fail(401, 'sign_in_required', '请先使用微信登录。');
}

function bearer(request, fail) {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!TOKEN.test(token)) fail(401, 'session_invalid', '登录状态无效，请重新使用微信登录。');
  return token;
}

async function userDTO(db, userId, fail) {
  const user = await db.prepare('SELECT user_id,name,email,role FROM users WHERE user_id=?').bind(userId).first();
  if (!user || !['buyer', 'merchant', 'admin'].includes(user.role)) fail(401, 'session_invalid', '登录状态已失效，请重新登录。');
  const profile = await db.prepare('SELECT * FROM merchant_accounts WHERE user_id=?').bind(userId).first();
  const merchant = profile ? merchantDTO(profile) : null;
  const permissions = user.role === 'admin' ? [...MERCHANT_PERMISSIONS]
    : user.role === 'merchant' && merchant?.status === 'enabled' ? merchant.permissions.filter(value => MERCHANT_PERMISSIONS.includes(value)) : [];
  return { id: user.user_id, name: user.name, email: '', role: user.role, merchant, permissions };
}

export function wechatSessionDTO(user) {
  return { user: user ? { id: user.id, email: '', name: user.name } : null,
    role: user?.role || 'anonymous', canManage: !!user?.permissions.length, permissions: user?.permissions || [], merchant: user?.merchant || null,
    signInUrl: null, signOutUrl: null, authProvider: 'wechat' };
}

export async function wechatIdentity(request, env, { requireDB, fail }) {
  const token = bearer(request, fail);
  if (!token) return null;
  const id = appId(env, fail), db = requireDB(env), now = new Date().toISOString();
  const row = await db.prepare(`SELECT s.user_id FROM wechat_sessions s
    JOIN wechat_identities i ON i.user_id=s.user_id AND i.app_id=s.app_id
    WHERE s.token_hash=? AND s.app_id=? AND s.revoked_at IS NULL AND s.expires_at>?`)
    .bind(await wechatDigest(token), id, now).first();
  if (!row) fail(401, 'session_invalid', '登录状态已失效，请重新使用微信登录。');
  return userDTO(db, row.user_id, fail);
}

async function providerJSON(response, fail) {
  if (!response.ok) fail(502, 'wechat_unavailable', '微信登录服务暂不可用，请稍后重新登录。');
  if (!response.body) fail(502, 'wechat_unavailable', '微信登录服务返回异常，请稍后重试。');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 8192) { await reader.cancel().catch(() => {}); fail(502, 'wechat_unavailable', '微信登录服务返回异常，请稍后重试。'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let at = 0;
  for (const part of chunks) { bytes.set(part, at); at += part.byteLength; }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(502, 'wechat_unavailable', '微信登录服务返回异常，请稍后重试。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(502, 'wechat_unavailable', '微信登录服务返回异常，请稍后重试。');
  return data;
}

export async function handleWechatAuthApi(request, env, helpers) {
  const path = new URL(request.url).pathname;
  if (path !== LOGIN && path !== LOGOUT) return null;
  const { fail, json, jsonBody, method, requireDB, providerFetch = fetch } = helpers;
  if (env.AUTH_MODE !== 'wechat') fail(404, 'not_found', '接口不存在。');
  method(request, ['POST']);
  wechatWriteOrigin(request, fail, path === LOGOUT);
  const body = await jsonBody(request, 1024), db = requireDB(env);
  if (path === LOGOUT) {
    if (Object.keys(body).length) fail(400, 'logout_invalid', '退出请求只接受空对象。');
    const token = bearer(request, fail);
    // Idempotent revocation does not require a still-valid session.
    await db.prepare('UPDATE wechat_sessions SET revoked_at=? WHERE token_hash=? AND app_id=? AND revoked_at IS NULL')
      .bind(new Date().toISOString(), await wechatDigest(token), appId(env, fail)).run();
    return json({ signedOut: true });
  }
  if (Object.keys(body).length !== 1 || typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.code)) fail(400, 'wechat_code_invalid', '请重新获取微信登录凭证。');
  const id = appId(env, fail);
  if (typeof env.WECHAT_APP_SECRET !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(env.WECHAT_APP_SECRET)) fail(503, 'wechat_unconfigured', '微信登录尚未配置，请联系管理员。');
  const codeHash = await wechatDigest(`${id}\0${body.code}`);
  if (await db.prepare('SELECT code_hash FROM wechat_login_codes WHERE code_hash=?').bind(codeHash).first()) fail(409, 'wechat_code_used', '这次登录凭证已使用，请重新获取。');
  const url = new URL(PROVIDER);
  url.search = new URLSearchParams({ appid: id, secret: env.WECHAT_APP_SECRET, js_code: body.code, grant_type: 'authorization_code' }).toString();
  let response;
  // Workers supports manual/follow, not redirect:error. Reject every non-2xx
  // below so a provider redirect can never forward the AppSecret elsewhere.
  try { response = await providerFetch(url.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } }); }
  catch { fail(502, 'wechat_unavailable', '微信登录服务暂不可用，请重新获取登录凭证后重试。'); }
  const provider = await providerJSON(response, fail);
  if ([40029, 40163].includes(provider.errcode)) fail(401, 'wechat_code_invalid', '微信登录凭证无效或已过期，请重新登录。');
  if (provider.errcode === 45011) fail(429, 'wechat_rate_limited', '微信登录过于频繁，请稍后重试。', { 'Retry-After': '60' });
  if (provider.errcode || typeof provider.openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(provider.openid)
    || typeof provider.session_key !== 'string' || !provider.session_key || provider.session_key.length > 256) fail(502, 'wechat_unavailable', '微信登录服务返回异常，请稍后重试。');
  // Both the provider subject and code are namespaced by AppID and hashed. Raw
  // OpenID/session_key are never persisted, logged or returned to the client.
  const subjectHash = await wechatDigest(`${id}\0${provider.openid}`), userId = `wechat:${subjectHash}`;
  const token = randomToken(), tokenHash = await wechatDigest(token), nonce = crypto.randomUUID();
  const created = new Date().toISOString(), expires = new Date(Date.now() + TTL).toISOString();
  const claim = 'EXISTS(SELECT 1 FROM wechat_login_codes WHERE code_hash=? AND request_nonce=?)';
  await db.batch([
    db.prepare('INSERT INTO wechat_login_codes(code_hash,request_nonce,created_at) VALUES(?,?,?) ON CONFLICT(code_hash) DO NOTHING').bind(codeHash, nonce, created),
    db.prepare(`INSERT INTO users(user_id,email,name,role,created_at,updated_at) SELECT ?,'','微信买家','buyer',?,? WHERE ${claim} ON CONFLICT(user_id) DO NOTHING`)
      .bind(userId, created, created, codeHash, nonce),
    db.prepare(`INSERT INTO wechat_identities(subject_hash,app_id,user_id,created_at) SELECT ?,?,?,? WHERE ${claim} ON CONFLICT(subject_hash) DO NOTHING`)
      .bind(subjectHash, id, userId, created, codeHash, nonce),
    db.prepare(`INSERT INTO wechat_sessions(token_hash,user_id,app_id,created_at,expires_at,revoked_at)
      SELECT ?,?,?,?,?,NULL WHERE ${claim} AND EXISTS(SELECT 1 FROM wechat_identities WHERE subject_hash=? AND user_id=? AND app_id=?)`)
      .bind(tokenHash, userId, id, created, expires, codeHash, nonce, subjectHash, userId, id)
  ]);
  if (!await db.prepare('SELECT token_hash FROM wechat_sessions WHERE token_hash=?').bind(tokenHash).first()) fail(409, 'wechat_code_used', '这次登录凭证已使用，请重新获取。');
  return json({ token, expiresAt: expires, session: wechatSessionDTO(await userDTO(db, userId, fail)) });
}
