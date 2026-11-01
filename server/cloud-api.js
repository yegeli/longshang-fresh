import { BASE_CATALOG, normalizeCatalogProduct } from '../public/model.js';
import { handleOrderApi } from './order-api.js';
import { handleBuyerStateApi } from './buyer-state-api.js';
import { handleMerchantApi } from './merchant-api.js';
import { handleInventoryApi } from './inventory-api.js';
import { handleStorefrontApi } from './storefront-api.js';
import { handleDemoInventorySetup } from './demo-inventory-setup.js';
import { handleWechatAuthApi, wechatIdentity, wechatSessionDTO, wechatWriteOrigin } from './wechat-auth.js';
import { MERCHANT_PERMISSIONS, merchantDTO, hasPermission, managementGuard, visibleSellerSQL } from './merchant-access.js';

const PREFIX = '/api/v1';
const SIGN_IN = '/signin-with-chatgpt?return_to=%2Fadmin.html';
const SIGN_OUT = '/signout-with-chatgpt?return_to=%2Fadmin.html';
const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MEDIA_ID = /^CLOUD-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMAGE_ASSETS = new Set(['apples', 'goji', 'pear', 'potato', 'corn', 'onion', 'orchard', 'apple-orchard', 'apples-hero'].map(name => `assets/${name}.jpg`));
const TYPES = { image: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']), video: new Set(['video/mp4', 'video/webm']) };
const LIMITS = { image: 5 * 1024 * 1024, video: 30 * 1024 * 1024 };
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie' };
const PRODUCT_KEYS = new Set(['id', 'name', 'category', 'status', 'image', 'origin', 'subtitle', 'tags', 'summary', 'storage', 'sizeNote', 'facts', 'harvestSteps', 'variants', 'video', 'videoTitle', 'videoNote', 'imageMediaId', 'videoMediaId', 'version']);

class ApiError extends Error {
  constructor(status, code, message, headers = {}) { super(message); Object.assign(this, { status, code, headers }); }
}
const fail = (status, code, message, headers) => { throw new ApiError(status, code, message, headers); };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const isoNow = () => new Date().toISOString();

function requireDB(env) {
  if (!env.DB?.prepare || !env.DB?.batch) fail(503, 'unavailable', '云端数据库尚未配置或暂不可用。');
  return env.DB;
}
function requireBucket(env) {
  if (!env.BUCKET?.put || !env.BUCKET?.get || !env.BUCKET?.head || !env.BUCKET?.delete) fail(503, 'unavailable', '云端素材存储尚未配置或暂不可用。');
  return env.BUCKET;
}

async function identity(request, env) {
  if (env.AUTH_MODE === 'wechat') return wechatIdentity(request, env, { requireDB, fail });
  // These headers are trusted ONLY behind Sites dispatch, which strips client-supplied values.
  const id = request.headers.get('oai-authenticated-user-id');
  const rawEmail = request.headers.get('oai-authenticated-user-email');
  if (!id || !rawEmail) return null;
  if (id.startsWith('system:') || id.startsWith('wechat:') || id.length > 255 || id !== id.trim() || /[\u0000-\u001f\u007f]/u.test(id)) fail(401, 'identity_invalid', '登录身份无效，请重新登录。');
  const email = rawEmail.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(401, 'identity_invalid', '登录身份无效，请重新登录。');
  const db = requireDB(env), now = isoNow(), name = email.split('@')[0].slice(0, 120);
  const insert = db.prepare(`INSERT INTO users(user_id,email,name,role,created_at,updated_at) VALUES(?,?,?,'buyer',?,?)
    ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,name=excluded.name,updated_at=excluded.updated_at`).bind(id, email, name, now, now);
  const bootstrap = typeof env.BOOTSTRAP_ADMIN_EMAIL === 'string' ? env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase() : '';
  if (bootstrap && email === bootstrap) {
    await db.batch([
      insert,
      db.prepare('INSERT INTO admin_bootstrap(singleton,user_id,claimed_at) VALUES(1,?,?) ON CONFLICT(singleton) DO NOTHING').bind(id, now),
      db.prepare("UPDATE users SET role='admin' WHERE user_id=? AND changes()=1 AND EXISTS(SELECT 1 FROM admin_bootstrap WHERE singleton=1 AND user_id=?)").bind(id, id)
    ]);
  } else await insert.run();
  let user = await db.prepare('SELECT user_id,email,name,role FROM users WHERE user_id=?').bind(id).first();
  if (!user || !['buyer', 'merchant', 'admin'].includes(user.role)) fail(403, 'forbidden', '账户权限无效。');
  // An email invitation is claimed once; all subsequent access follows the stable
  // Sites ID. A revoked role is never restored merely by an existing binding.
  if (user.role !== 'admin') {
    const pending = await db.prepare('SELECT * FROM merchant_accounts WHERE email=? AND user_id IS NULL AND NOT EXISTS(SELECT 1 FROM merchant_accounts WHERE user_id=?)').bind(email, id).first();
    if (pending) {
      const after = { ...merchantDTO(pending), bound: true, version: pending.version + 1, updatedAt: now };
      await db.batch([
        db.prepare(`UPDATE merchant_accounts SET user_id=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND user_id IS NULL AND version=?
          AND NOT EXISTS(SELECT 1 FROM merchant_accounts WHERE user_id=?) AND EXISTS(SELECT 1 FROM users WHERE user_id=? AND email=? AND role IN ('buyer','merchant'))`)
          .bind(id, now, id, pending.id, pending.version, id, id, email),
        db.prepare("UPDATE users SET role='merchant' WHERE user_id=? AND role IN ('buyer','merchant') AND changes()=1").bind(id),
        db.prepare("INSERT INTO merchant_audit(id,merchant_id,actor_id,action,before_json,after_json,created_at) SELECT ?,?,?,'bound',?,?,? WHERE changes()=1")
          .bind(`AUDIT-${crypto.randomUUID().toUpperCase()}`, pending.id, id, JSON.stringify(merchantDTO(pending)), JSON.stringify(after), now)
      ]);
      user = await db.prepare('SELECT user_id,email,name,role FROM users WHERE user_id=?').bind(id).first();
    }
  }
  const profile = await db.prepare('SELECT * FROM merchant_accounts WHERE user_id=?').bind(id).first();
  const merchant = profile ? merchantDTO(profile) : null;
  const permissions = user.role === 'admin' ? [...MERCHANT_PERMISSIONS]
    : user.role === 'merchant' && merchant?.status === 'enabled' ? merchant.permissions.filter(value => MERCHANT_PERMISSIONS.includes(value)) : [];
  return { id: user.user_id, email: user.email, name: user.name, role: user.role, merchant, permissions };
}

async function manager(request, env, adminOnly = false, permissions = MERCHANT_PERMISSIONS) {
  const user = await identity(request, env);
  if (!user) fail(401, 'sign_in_required', '请先登录商家账户。');
  const required = Array.isArray(permissions) ? permissions : [permissions];
  if (adminOnly ? user.role !== 'admin' : !required.some(permission => hasPermission(user, permission))) fail(403, 'forbidden', '此账户没有所需管理权限。');
  return user;
}

function sameOrigin(request, env) {
  if (env?.AUTH_MODE === 'wechat') return wechatWriteOrigin(request, fail);
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) fail(403, 'origin_rejected', '写入请求必须来自当前站点。');
}
function contentType(request, expected) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (expected && type !== expected) fail(415, 'content_type', `请求需使用 ${expected}。`);
  return type;
}

async function limitedBody(request, limit) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && !/^\d+$/.test(declared)) fail(400, 'body_invalid', '请求长度无效。');
  if (declared !== null && BigInt(declared) > BigInt(limit)) {
    await request.body?.cancel().catch(() => {});
    fail(413, 'too_large', '上传内容超过大小限制。');
  }
  if (!request.body) fail(400, 'body_missing', '请求内容不能为空。');
  const reader = request.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        fail(413, 'too_large', '上传内容超过大小限制。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (declared !== null && BigInt(declared) !== BigInt(length)) fail(400, 'body_invalid', '请求长度与实际内容不一致。');
  if (length === 0) fail(400, 'body_missing', '请求内容不能为空。');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function jsonBody(request, limit = 96 * 1024) {
  contentType(request, 'application/json');
  const bytes = await limitedBody(request, limit);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'json_invalid', 'JSON 请求格式无效。'); }
  if (!object(value)) fail(400, 'json_invalid', '请求必须为 JSON 对象。');
  return value;
}

function rejectUnknown(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.has(key))) fail(400, 'product_invalid', `${label}含有未知字段或格式无效。`);
}

function validateProduct(input, id, expectedVersion) {
  rejectUnknown(input, PRODUCT_KEYS, '商品');
  if (input.id !== id || !PRODUCT_ID.test(id)) fail(400, 'product_invalid', '商品编号与路径不一致或格式无效。');
  if (input.version !== undefined && input.version !== expectedVersion) fail(400, 'version_invalid', '商品版本与预期版本不一致。');
  for (const key of ['name', 'category', 'status', 'image', 'origin', 'subtitle', 'summary', 'storage', 'sizeNote', 'video', 'videoTitle', 'videoNote']) {
    if (typeof input[key] !== 'string') fail(400, 'product_invalid', `商品字段 ${key} 必须为字符串。`);
  }
  if (!IMAGE_ASSETS.has(input.image) || input.video !== '') fail(400, 'asset_invalid', '只能选择已有内置图片，视频请通过云素材编号绑定。');
  for (const key of ['imageMediaId', 'videoMediaId']) {
    if (input[key] !== undefined && input[key] !== '' && (typeof input[key] !== 'string' || !MEDIA_ID.test(input[key]))) fail(400, 'media_invalid', '云素材编号无效。');
  }
  if (!Array.isArray(input.tags) || !Array.isArray(input.facts) || !Array.isArray(input.harvestSteps) || !Array.isArray(input.variants)) fail(400, 'product_invalid', '商品列表字段格式无效。');
  for (const step of input.harvestSteps) rejectUnknown(step, new Set(['title', 'text']), '采收步骤');
  for (const variant of input.variants) rejectUnknown(variant, new Set(['id', 'label', 'weight', 'price', 'hint']), '规格');
  let normalized;
  try { normalized = normalizeCatalogProduct(input); }
  catch (error) { fail(400, 'product_invalid', error.message); }
  return normalized;
}

async function validateBindings(db, product, user, productOwner) {
  for (const [key, kind] of [['imageMediaId', 'image'], ['videoMediaId', 'video']]) {
    if (!product[key]) continue;
    const row = await db.prepare('SELECT owner_id,kind FROM media WHERE id=?').bind(product[key]).first();
    if (!row || row.kind !== kind || (user.role !== 'admin' && row.owner_id !== user.id) || (user.role !== 'admin' && row.owner_id !== productOwner)) {
      fail(403, 'media_forbidden', '素材不存在、类型不匹配或不属于当前商家。');
    }
  }
}

function productFromRow(row) { return { ...JSON.parse(row.product_json), version: row.version }; }
async function catalog(db, user = null) {
  const result = user
    ? await db.prepare('SELECT product_json,version,updated_at FROM products WHERE (?=\'admin\' OR owner_id=?) ORDER BY created_at,id').bind(user.role, user.id).all()
    : await db.prepare(`SELECT product_json,version,updated_at FROM products WHERE status='published' AND ${visibleSellerSQL('products.owner_id')} ORDER BY created_at,id`).all();
  const rows = result.results || [];
  return { products: rows.map(productFromRow), updatedAt: rows.reduce((latest, row) => row.updated_at > latest ? row.updated_at : latest, '') || null };
}

async function putProduct(request, env, id) {
  sameOrigin(request, env);
  const user = await manager(request, env, false, 'products'), db = requireDB(env), body = await jsonBody(request);
  rejectUnknown(body, new Set(['product', 'expectedVersion']), '请求');
  const expected = body.expectedVersion;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) fail(400, 'version_invalid', 'expectedVersion 必须是非负安全整数。');
  const existing = await db.prepare('SELECT owner_id,version FROM products WHERE id=?').bind(id).first();
  if (existing && user.role !== 'admin' && existing.owner_id !== user.id) fail(403, 'forbidden', '只能管理自己的商品。');
  if ((existing && expected !== existing.version) || (!existing && expected !== 0)) fail(409, 'version_conflict', '商品已被修改或不存在，请刷新后重新编辑。');
  const product = validateProduct(body.product, id, expected);
  await validateBindings(db, product, user, existing?.owner_id || user.id);
  const now = isoNow(), serialized = JSON.stringify(product);
  let saved;
  if (!existing) {
    saved = await db.prepare(`INSERT INTO products(id,owner_id,product_json,status,version,image_media_id,video_media_id,created_at,updated_at,updated_by)
      SELECT ?,?,?,?,1,?,?,?,?,? WHERE (SELECT count(*) FROM products)<200 AND ${managementGuard('products')} ON CONFLICT(id) DO NOTHING
      RETURNING product_json,version,updated_at`).bind(id, user.id, serialized, product.status, product.imageMediaId || null, product.videoMediaId || null, now, now, user.id, user.id).first();
    if (!saved) {
      const duplicate = await db.prepare('SELECT id FROM products WHERE id=?').bind(id).first();
      fail(duplicate ? 409 : 422, duplicate ? 'version_conflict' : 'catalog_limit', duplicate ? '商品已创建，请刷新后重新编辑。' : '当前目录最多支持200款商品。');
    }
  } else {
    saved = await db.prepare(`UPDATE products SET product_json=?,status=?,version=version+1,image_media_id=?,video_media_id=?,updated_at=?,updated_by=?
      WHERE id=? AND version=? AND (owner_id=? OR EXISTS(SELECT 1 FROM users WHERE user_id=? AND role='admin')) AND ${managementGuard('products')} RETURNING product_json,version,updated_at`)
      .bind(serialized, product.status, product.imageMediaId || null, product.videoMediaId || null, now, user.id, id, expected, user.id, user.id, user.id).first();
    if (!saved) fail(409, 'version_conflict', '商品已被其他操作修改，请刷新后重新编辑。');
  }
  return json({ product: productFromRow(saved), version: saved.version });
}

async function seed(request, env) {
  sameOrigin(request, env);
  const user = await manager(request, env, true), db = requireDB(env);
  const body = await jsonBody(request);
  if (Object.keys(body).length) fail(400, 'seed_invalid', '初始化请求只接受空对象。');
  const now = isoNow();
  const statements = BASE_CATALOG.map(input => {
    const product = normalizeCatalogProduct(input);
    return db.prepare(`INSERT INTO products(id,owner_id,product_json,status,version,image_media_id,video_media_id,created_at,updated_at,updated_by)
      SELECT ?,?,?,?,1,NULL,NULL,?,?,? WHERE (SELECT count(*) FROM products)<200 ON CONFLICT(id) DO NOTHING`)
      .bind(product.id, user.id, JSON.stringify(product), product.status, now, now, user.id);
  });
  const results = await db.batch(statements);
  return json({ inserted: results.reduce((count, result) => count + (result.meta?.changes || 0), 0), ...await catalog(db, user) });
}

function decodeHeader(request, name, maximum) {
  const raw = request.headers.get(name);
  if (!raw || raw.length > maximum * 12) fail(400, 'metadata_required', `${name} 必填且长度需在限制内。`);
  let value;
  try { value = decodeURIComponent(raw).trim(); } catch { fail(400, 'metadata_invalid', `${name} 编码无效。`); }
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail(400, 'metadata_invalid', `${name} 内容无效或过长。`);
  return value;
}

function hasSignature(bytes, type) {
  const starts = values => values.every((value, index) => bytes[index] === value);
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (type === 'image/jpeg') return bytes.length >= 4 && starts([255, 216, 255]) && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  if (type === 'image/png') return bytes.length >= 33 && starts([137, 80, 78, 71, 13, 10, 26, 10]) && ascii(12, 16) === 'IHDR' && new DataView(bytes.buffer, bytes.byteOffset).getUint32(16) > 0 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(20) > 0;
  if (type === 'image/gif') return bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6)) && (bytes[6] || bytes[7]) && (bytes[8] || bytes[9]);
  if (type === 'image/webp') return bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' && new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true) + 8 === bytes.length;
  if (type === 'video/mp4') {
    if (bytes.length < 16 || ascii(4, 8) !== 'ftyp') return false;
    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    return size >= 16 && size <= bytes.length && ['isom', 'iso2', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].includes(ascii(8, 12));
  }
  if (type === 'video/webm') return bytes.length >= 12 && starts([26, 69, 223, 163]) && ascii(4, Math.min(bytes.length, 4096)).includes('webm');
  return false;
}

async function upload(request, env, url) {
  sameOrigin(request, env);
  const user = await manager(request, env, false, 'products'), db = requireDB(env), bucket = requireBucket(env), kind = url.searchParams.get('kind');
  if (!['image', 'video'].includes(kind)) fail(400, 'kind_invalid', '素材类型必须为 image 或 video。');
  const type = contentType(request);
  if (!TYPES[kind].has(type)) fail(415, 'content_type', '不支持此素材格式。');
  const name = decodeHeader(request, 'X-File-Name', 180), source = decodeHeader(request, 'X-Media-Source', 500);
  if (/[\/\\]/u.test(name)) fail(400, 'metadata_invalid', '文件名不得包含目录路径。');
  const bytes = await limitedBody(request, LIMITS[kind]);
  if (!hasSignature(bytes, type)) fail(415, 'signature_invalid', '文件内容与声明格式不匹配。');
  const id = `CLOUD-${crypto.randomUUID()}`, objectKey = `cloud-media/${id}`, now = isoNow();
  await bucket.put(objectKey, bytes, { httpMetadata: { contentType: type }, customMetadata: { mediaId: id } });
  try {
    const saved = await db.prepare(`INSERT INTO media(id,owner_id,object_key,name,mime_type,kind,size,source,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${managementGuard('products')}`)
      .bind(id, user.id, objectKey, name, type, kind, bytes.byteLength, source, now, user.id).run();
    if (!saved.meta?.changes) fail(403, 'forbidden', '上传期间管理权限已变化，素材未保存。');
  } catch (error) {
    // A failed catalog write must never report success. Unreferenced uploads remain private.
    await bucket.delete(objectKey).catch(() => {});
    throw error;
  }
  return json({ id, url: `${PREFIX}/media/${id}`, name, type, size: bytes.byteLength, kind, source }, 201);
}

function singleRange(header, size) {
  if (!header || !/^bytes=/i.test(header) || header.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  const total = BigInt(size);
  let start, end;
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (!suffix) return false;
    start = suffix >= total ? 0n : total - suffix; end = total - 1n;
  } else {
    start = BigInt(match[1]); end = match[2] ? BigInt(match[2]) : total - 1n;
    if (start >= total || end < start) return false;
    if (end >= total) end = total - 1n;
  }
  return { offset: Number(start), length: Number(end - start + 1n) };
}

async function readMedia(request, env, id) {
  if (!MEDIA_ID.test(id)) fail(404, 'not_found', '素材不存在。');
  const db = requireDB(env), bucket = requireBucket(env);
  const row = await db.prepare('SELECT * FROM media WHERE id=?').bind(id).first();
  if (!row) fail(404, 'not_found', '素材不存在。');
  const published = await db.prepare(`SELECT id FROM products WHERE status='published' AND (image_media_id=? OR video_media_id=?) AND ${visibleSellerSQL('products.owner_id')} LIMIT 1`).bind(id, id).first();
  if (!published) {
    const user = await identity(request, env);
    if (!user || (user.role !== 'admin' && (user.id !== row.owner_id || !hasPermission(user, 'products')))) fail(404, 'not_found', '素材不存在或当前账户无权读取。');
  }
  const head = await bucket.head(row.object_key);
  if (!head) fail(404, 'not_found', '素材文件不存在。');
  if (head.size !== row.size) fail(503, 'media_unavailable', '素材文件暂不可用。');
  const etag = head.httpEtag;
  const ifRange = request.headers.get('If-Range');
  const range = request.method === 'GET' && (!ifRange || (etag && ifRange === etag)) ? singleRange(request.headers.get('Range'), row.size) : null;
  if (range === false) fail(416, 'range_invalid', '请求的素材范围无效。', { 'Content-Range': `bytes */${row.size}`, 'Accept-Ranges': 'bytes' });
  const headers = {
    ...HEADERS, 'Content-Type': row.mime_type, 'Content-Length': String(range ? range.length : row.size),
    'Accept-Ranges': 'bytes', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`
  };
  if (etag) headers.ETag = etag;
  if (range) headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`;
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  const result = await bucket.get(row.object_key, range ? { range } : undefined);
  if (!result) fail(404, 'not_found', '素材文件不存在。');
  return new Response(result.body, { status: range ? 206 : 200, headers });
}

function method(request, methods) {
  if (!methods.includes(request.method)) fail(405, 'method_not_allowed', '此接口不支持该请求方式。', { Allow: methods.join(', ') });
}

export async function handleApi(request, env, options = {}) {
  try {
    const url = new URL(request.url), path = url.pathname;
    const checkOrigin = input => sameOrigin(input, env);
    const authResponse = await handleWechatAuthApi(request, env, { requireDB, jsonBody, fail, json, method, providerFetch: options.wechatProviderFetch });
    if (authResponse) return authResponse;
    // The one-time Sites maintenance operation is not exposed by a public API.
    const setupResponse = env.AUTH_MODE === 'wechat' ? null : await handleDemoInventorySetup(request, env, { requireDB, sameOrigin: checkOrigin, jsonBody, fail, json });
    if (setupResponse) return setupResponse;
    if (path === `${PREFIX}/session`) {
      method(request, ['GET']);
      const user = await identity(request, env);
      if (env.AUTH_MODE === 'wechat') return json(wechatSessionDTO(user));
      return json({ user: user ? { id: user.id, email: user.email, name: user.name } : null, role: user?.role || 'anonymous', canManage: !!user?.permissions.length, permissions: user?.permissions || [], merchant: user?.merchant || null, signInUrl: SIGN_IN, signOutUrl: SIGN_OUT });
    }
    const merchantResponse = await handleMerchantApi(request, env, { manager, requireDB, sameOrigin: checkOrigin, jsonBody, fail, json, method });
    if (merchantResponse) return merchantResponse;
    const inventoryResponse = await handleInventoryApi(request, env, { manager, requireDB, sameOrigin: checkOrigin, jsonBody, fail, json, method });
    if (inventoryResponse) return inventoryResponse;
    const buyerStateResponse = await handleBuyerStateApi(request, env, { identity, requireDB, sameOrigin: checkOrigin, jsonBody, fail, json, method });
    if (buyerStateResponse) return buyerStateResponse;
    const orderResponse = await handleOrderApi(request, env, { identity, manager, requireDB, sameOrigin: checkOrigin, jsonBody, fail, json, method });
    if (orderResponse) return orderResponse;
    const storefrontResponse = await handleStorefrontApi(request, env, { requireDB, json, method });
    if (storefrontResponse) return storefrontResponse;
    if (path === `${PREFIX}/products`) { method(request, ['GET']); return json(await catalog(requireDB(env))); }
    if (path === `${PREFIX}/admin/products`) { method(request, ['GET']); return json(await catalog(requireDB(env), await manager(request, env, false, 'products'))); }
    if (path === `${PREFIX}/admin/seed`) { method(request, ['POST']); return await seed(request, env); }
    const productMatch = new RegExp(`^${PREFIX}/admin/products/([a-z0-9-]+)$`).exec(path);
    if (productMatch) { method(request, ['PUT']); return await putProduct(request, env, productMatch[1]); }
    if (path === `${PREFIX}/media`) { method(request, ['POST']); return await upload(request, env, url); }
    const mediaMatch = new RegExp(`^${PREFIX}/media/([^/]+)$`).exec(path);
    if (mediaMatch) { method(request, ['GET', 'HEAD']); return await readMedia(request, env, mediaMatch[1]); }
    fail(404, 'not_found', '接口不存在。');
  } catch (error) {
    if (error instanceof ApiError) {
      const response = json({ error: { code: error.code, message: error.message } }, error.status, error.headers);
      return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
    const response = json({ error: { code: 'unavailable', message: '云端服务暂不可用，未确认保存成功，请稍后重试。' } }, 503);
    return request.method === 'HEAD' ? new Response(null, { status: 503, headers: response.headers }) : response;
  }
}
