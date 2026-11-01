import { inventoryJSON } from './inventory-api.js';

const PATH = '/api/v1/maintenance/demo-inventory';
const OPERATION = 'demo-inventory-v1';
const ACTOR = 'system:demo-inventory-v1';
const PRODUCTS = ['jingtai-apple', 'goji', 'pear', 'potato', 'corn', 'onion'];
const REASON = '按用户明确要求，一次性配置完整流程测试用模拟库存；不代表真实货源或可售余量。';
const ELIGIBLE_FROM = `FROM products p
  JOIN admin_bootstrap a ON a.singleton=1 AND a.user_id=p.owner_id
  JOIN users u ON u.user_id=p.owner_id AND u.role='admin'`;
const ELIGIBLE = `p.status='published'
  AND NOT EXISTS(SELECT 1 FROM merchant_accounts WHERE user_id=p.owner_id AND status='disabled')
  AND json_type(p.product_json,'$.origin')='text' AND instr(json_extract(p.product_json,'$.origin'),'模拟')>0
  AND json_type(p.product_json,'$.summary')='text' AND instr(json_extract(p.product_json,'$.summary'),'模拟')>0
  AND json_type(p.product_json,'$.variants')='array' AND json_array_length(p.product_json,'$.variants')=2
  AND (SELECT count(DISTINCT json_extract(value,'$.id')) FROM json_each(p.product_json,'$.variants')
    WHERE json_extract(value,'$.id') IN ('small','family'))=2
  AND NOT EXISTS(SELECT 1 FROM product_inventory WHERE product_id=p.id)
  AND NOT EXISTS(SELECT 1 FROM inventory_events WHERE product_id=p.id)`;

async function tokensMatch(actual, expected) {
  const encode = value => new TextEncoder().encode(value);
  const [a, b] = await Promise.all([actual, expected].map(value => crypto.subtle.digest('SHA-256', encode(value))));
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

// Explicit maintenance operation, disabled without a short-lived deployment secret.
// This never runs on reads, login, deployment, catalog initialization or migrations.
export async function handleDemoInventorySetup(request, env, helpers) {
  if (new URL(request.url).pathname !== PATH) return null;
  const { requireDB, sameOrigin, jsonBody, fail, json } = helpers;
  const secret = env.DEMO_INVENTORY_SETUP_TOKEN, expires = env.DEMO_INVENTORY_SETUP_EXPIRES_AT;
  const expiry = typeof expires === 'string' ? Date.parse(expires) : NaN, now = Date.now();
  const enabled = typeof secret === 'string' && /^[a-f0-9]{64}$/i.test(secret) && Number.isFinite(expiry)
    && new Date(expiry).toISOString() === expires && expiry > now && expiry - now <= 24 * 60 * 60 * 1000;
  const supplied = request.headers.get('X-Demo-Setup-Token');
  if (!enabled || request.method !== 'POST' || !supplied) fail(404, 'not_found', '接口不存在。');
  if (!/^[a-f0-9]{64}$/i.test(supplied) || !await tokensMatch(supplied, secret)) fail(403, 'setup_forbidden', '模拟库存配置凭据无效。');
  sameOrigin(request);
  if (Object.keys(await jsonBody(request)).length) fail(400, 'setup_invalid', '一次性模拟库存配置只接受空对象。');
  const db = requireDB(env);
  const completed = await db.prepare('SELECT request_nonce,summary_json FROM setup_operations WHERE operation_key=?').bind(OPERATION).first();
  if (completed) return json({ ...JSON.parse(completed.summary_json), replayed: true });

  const nonce = crypto.randomUUID().toUpperCase(), time = new Date().toISOString();
  const claim = 'EXISTS(SELECT 1 FROM setup_operations WHERE operation_key=? AND request_nonce=?)';
  const claimValues = [OPERATION, nonce];
  const statements = [db.prepare(`INSERT INTO setup_operations(operation_key,request_nonce,summary_json,created_at)
    SELECT ?,?,'{}',? WHERE EXISTS(SELECT 1 ${ELIGIBLE_FROM}
      WHERE p.id IN (${PRODUCTS.map(id => `'${id}'`).join(',')}) AND ${ELIGIBLE})
    ON CONFLICT(operation_key) DO NOTHING`).bind(OPERATION, nonce, time)];
  statements.push(db.prepare(`INSERT INTO users(user_id,email,name,role,created_at,updated_at)
    SELECT ?,'demo-inventory@system.invalid','一次性模拟库存配置（系统）','buyer',?,? WHERE ${claim}
    ON CONFLICT(user_id) DO NOTHING`).bind(ACTOR, time, time, ...claimValues));

  const events = PRODUCTS.map(productId => ({ productId, eventId: `STOCK-${crypto.randomUUID().toUpperCase()}` }));
  for (const { productId, eventId } of events) {
    const batchId = `BATCH-${crypto.randomUUID().toUpperCase()}`;
    // Every predicate is rechecked inside the same transaction, after its claim.
    // Neither configured zero stock nor a previously tracked/deleted batch is reset.
    statements.push(db.prepare(`INSERT INTO product_inventory(product_id,small_stock,family_stock,batch_id,batch_code,harvest_date,note,version,updated_at,updated_by)
      SELECT p.id,20,12,?,?,'',?,1,?,? ${ELIGIBLE_FROM}
      WHERE p.id=? AND ${ELIGIBLE} AND ${claim}
      AND EXISTS(SELECT 1 FROM users WHERE user_id=? AND role='buyer' AND email='demo-inventory@system.invalid')
      ON CONFLICT(product_id) DO NOTHING`)
      .bind(batchId, `DEMO-SETUP-V1-${productId.toUpperCase()}`, REASON, time, ACTOR, productId, ...claimValues, ACTOR));
    statements.push(db.prepare(`INSERT INTO inventory_events(id,product_id,actor_id,action,reason,order_id,before_json,after_json,created_at)
      SELECT ?,i.product_id,?,'adjusted',?,NULL,NULL,${inventoryJSON('i')},? FROM product_inventory i
      WHERE i.product_id=? AND i.batch_id=? AND i.updated_by=? AND i.version=1 AND ${claim}`)
      .bind(eventId, ACTOR, REASON, time, productId, batchId, ACTOR, ...claimValues));
  }
  // Persist the actual inserted subset in the stock transaction, not a stale read.
  statements.push(db.prepare(`WITH requested(product_id,event_id) AS (VALUES ${events.map(() => '(?,?)').join(',')})
    UPDATE setup_operations SET summary_json=json_object(
      'seededIds',json((SELECT json_group_array(product_id) FROM requested r WHERE EXISTS(SELECT 1 FROM inventory_events e WHERE e.id=r.event_id))),
      'skippedIds',json((SELECT json_group_array(product_id) FROM requested r WHERE NOT EXISTS(SELECT 1 FROM inventory_events e WHERE e.id=r.event_id))))
    WHERE operation_key=? AND request_nonce=?`)
    .bind(...events.flatMap(({ productId, eventId }) => [productId, eventId]), ...claimValues));
  await db.batch(statements);
  const saved = await db.prepare('SELECT request_nonce,summary_json FROM setup_operations WHERE operation_key=?').bind(OPERATION).first();
  if (!saved) fail(409, 'setup_no_eligible_products', '没有符合条件的未配置模拟商品；未新增库存，请先核对商品和已有批次。');
  return json({ ...JSON.parse(saved.summary_json), replayed: saved.request_nonce !== nonce });
}
