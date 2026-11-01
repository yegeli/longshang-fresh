import { managementGuard, visibleSellerSQL } from './merchant-access.js';

const PREFIX = '/api/v1';
const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const MAX_STOCK = Number.MAX_SAFE_INTEGER;
export function inventoryDTO(row, productId = row?.product_id) {
  return { productId, configured: !!row?.product_id, stocks: { small: row?.small_stock || 0, family: row?.family_stock || 0 },
    batchId: row?.batch_id || '', batchCode: row?.batch_code || '', harvestDate: row?.harvest_date || '', note: row?.note || '',
    version: row?.version || 0, updatedAt: row?.updated_at || null };
}
// Aliases and arithmetic expressions are source controlled, never request data.
export function inventoryJSON(alias = 'i', small = `${alias}.small_stock`, family = `${alias}.family_stock`, version = `${alias}.version`, time = `${alias}.updated_at`) {
  return `json_object('productId',${alias}.product_id,'configured',json('true'),'stocks',json_object('small',${small},'family',${family}),
    'batchId',${alias}.batch_id,'batchCode',${alias}.batch_code,'harvestDate',${alias}.harvest_date,'note',${alias}.note,'version',${version},'updatedAt',${time})`;
}
export async function handleInventoryApi(request, env, helpers) {
  const url = new URL(request.url), path = url.pathname;
  const admin = path === `${PREFIX}/admin/inventory` || path.startsWith(`${PREFIX}/admin/inventory/`);
  if (!admin && path !== `${PREFIX}/inventory`) return null;
  const { manager, requireDB, sameOrigin, jsonBody, fail, json, method } = helpers;
  const db = requireDB(env), user = admin ? await manager(request, env, false, 'products') : null;
  const base = `${PREFIX}/${admin ? 'admin/' : ''}inventory`;
  if (path === base) {
    method(request, ['GET']);
    const condition = admin ? "(?='admin' OR p.owner_id=?)" : `p.status='published' AND ${visibleSellerSQL('p.owner_id')}`;
    const statement = db.prepare(`SELECT p.id AS catalog_id,i.* FROM products p LEFT JOIN product_inventory i ON i.product_id=p.id WHERE ${condition} ORDER BY p.created_at,p.id`);
    const rows = (await (admin ? statement.bind(user.role, user.id) : statement).all()).results || [];
    const inventories = rows.map(row => inventoryDTO(row, row.catalog_id));
    return json({ inventories, updatedAt: inventories.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, '') || null });
  }
  const match = new RegExp(`^${base}/([^/]+)(/history)?$`).exec(path);
  if (!match || !PRODUCT_ID.test(match[1])) fail(404, 'not_found', '库存不存在或无权管理。');
  const id = match[1];
  const product = await db.prepare('SELECT owner_id FROM products WHERE id=?').bind(id).first();
  if (!product || (user.role !== 'admin' && product.owner_id !== user.id)) fail(404, 'not_found', '库存不存在或无权管理。');
  if (match[2]) {
    method(request, ['GET']);
    const rows = (await db.prepare(`SELECT e.*,u.name AS actor_name FROM inventory_events e JOIN users u ON u.user_id=e.actor_id
      WHERE e.product_id=? ORDER BY e.created_at DESC,e.rowid DESC LIMIT 50`).bind(id).all()).results || [];
    return json({ events: rows.map(row => ({ id: row.id, productId: id, action: row.action, reason: row.reason, orderId: row.order_id,
      actorName: row.actor_name, createdAt: row.created_at, before: row.before_json ? JSON.parse(row.before_json) : null, after: JSON.parse(row.after_json) })) });
  }
  method(request, ['PUT']); sameOrigin(request);
  const body = await jsonBody(request);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(body) || Object.keys(body).some(key => !['expectedVersion','stocks','batchCode','harvestDate','note','reason'].includes(key))) fail(400, 'inventory_invalid', '库存请求包含未知字段或格式无效。');
  const expected = body.expectedVersion;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected >= MAX_STOCK) fail(400, 'version_invalid', '库存版本无效，请重新读取。');
  if (!object(body.stocks) || Object.keys(body.stocks).length !== 2 || !['small','family'].every(key => Number.isSafeInteger(body.stocks[key]) && body.stocks[key] >= 0 && body.stocks[key] <= 999999)) fail(400, 'stock_invalid', '两种规格的可售数量须为0至999999的整数份。');
  const text = (key, max, required) => {
    if (typeof body[key] !== 'string' || /[\u0000-\u001f\u007f]/.test(body[key])) fail(400, 'inventory_invalid', '批次信息格式无效。');
    const value = body[key].trim();
    if (value.length > max || (required && !value)) fail(400, 'inventory_invalid', '请填写有效的批次信息和调整原因。');
    return value;
  };
  const batchCode = text('batchCode',80,true), harvestDate = text('harvestDate',10,false), note = text('note',300,false), reason = text('reason',200,true);
  if (harvestDate && (!/^\d{4}-\d{2}-\d{2}$/.test(harvestDate) || Number.isNaN(Date.parse(harvestDate)) || new Date(harvestDate).toISOString().slice(0,10) !== harvestDate)) fail(400, 'inventory_invalid', '采摘日期须为有效的年月日，或留空。');
  const previous = await db.prepare('SELECT * FROM product_inventory WHERE product_id=?').bind(id).first();
  if ((previous?.version || 0) !== expected) fail(409, 'version_conflict', '库存已被下单或其他操作修改，请重新读取后保存。');
  const time = new Date().toISOString(), batchId = previous && previous.batch_code === batchCode && previous.harvest_date === harvestDate ? previous.batch_id : `BATCH-${crypto.randomUUID().toUpperCase()}`;
  const after = { productId:id,configured:true,stocks:body.stocks,batchId,batchCode,harvestDate,note,version:expected+1,updatedAt:time };
  const access = `EXISTS(SELECT 1 FROM products p WHERE p.id=? AND (p.owner_id=? OR EXISTS(SELECT 1 FROM users WHERE user_id=? AND role='admin'))) AND ${managementGuard('products')}`;
  const write = previous
    ? db.prepare(`UPDATE product_inventory SET small_stock=?,family_stock=?,batch_id=?,batch_code=?,harvest_date=?,note=?,version=version+1,updated_at=?,updated_by=? WHERE product_id=? AND version=? AND ${access}`)
      .bind(body.stocks.small,body.stocks.family,batchId,batchCode,harvestDate,note,time,user.id,id,expected,id,user.id,user.id,user.id)
    : db.prepare(`INSERT INTO product_inventory(product_id,small_stock,family_stock,batch_id,batch_code,harvest_date,note,version,updated_at,updated_by)
      SELECT ?,?,?,?,?,?,?,1,?,? WHERE ${access} ON CONFLICT(product_id) DO NOTHING`)
      .bind(id,body.stocks.small,body.stocks.family,batchId,batchCode,harvestDate,note,time,user.id,id,user.id,user.id,user.id);
  const results = await db.batch([write, db.prepare(`INSERT INTO inventory_events(id,product_id,actor_id,action,reason,order_id,before_json,after_json,created_at)
    SELECT ?,?,?,'adjusted',?,NULL,?,?,? WHERE changes()=1`).bind(`STOCK-${crypto.randomUUID().toUpperCase()}`,id,user.id,reason,previous ? JSON.stringify(inventoryDTO(previous)) : null,JSON.stringify(after),time)]);
  if (!results[0].meta?.changes) fail(409, 'version_conflict', '库存或管理权限已变化，请重新读取；本次未覆盖。');
  return json({ inventory: inventoryDTO(await db.prepare('SELECT * FROM product_inventory WHERE product_id=?').bind(id).first()) });
}
