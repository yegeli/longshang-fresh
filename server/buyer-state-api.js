import { ADDRESSES } from '../public/model.js';

const BASE = '/api/v1/me/shopping';
const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ORDER_ID = /^DEMO-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const ADDRESS_IDS = new Set(ADDRESSES.map(address => address.id));
const emptyState = () => ({ cart: [], favorites: [], recent: [], preferredAddress: 'gansu' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key));
const sku = item => `${item.productId}::${item.variant}`;

// Shared authentication/body helpers keep this route inside the existing API's
// error boundary. No client field selects the owner of a shopping record.
export async function handleBuyerStateApi(request, env, helpers) {
  const path = new URL(request.url).pathname;
  if (path !== BASE && path !== `${BASE}/consume-order`) return null;
  const { identity, requireDB, sameOrigin, jsonBody, fail, json, method } = helpers;
  method(request, path === BASE ? ['GET', 'PUT'] : ['POST']);
  const user = await identity(request, env);
  if (!user) fail(401, 'sign_in_required', '请先登录，再同步购物车、收藏与示例地区偏好。');
  const db = requireDB(env);
  const invalid = () => fail(400, 'shopping_invalid', '购物资料格式无效；只可保存商品编号、规格、数量、勾选状态与示例地区。');
  function validateState(value, reject = invalid) {
    if (!keys(value, ['cart', 'favorites', 'recent', 'preferredAddress']) || !Array.isArray(value.cart) || value.cart.length > 12
      || !ADDRESS_IDS.has(value.preferredAddress)) reject();
    const seen = new Set();
    const cart = value.cart.map(row => {
      if (!keys(row, ['productId', 'variant', 'quantity', 'selected']) || typeof row.productId !== 'string' || !PRODUCT_ID.test(row.productId)
        || !['small', 'family'].includes(row.variant) || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 10 || typeof row.selected !== 'boolean'
        || seen.has(sku(row))) reject();
      seen.add(sku(row));
      return { productId: row.productId, variant: row.variant, quantity: row.quantity, selected: row.selected };
    });
    const list = input => {
      if (!Array.isArray(input) || input.length > 20 || input.some(id => typeof id !== 'string' || !PRODUCT_ID.test(id)) || new Set(input).size !== input.length) reject();
      return [...input];
    };
    return { cart, favorites: list(value.favorites), recent: list(value.recent), preferredAddress: value.preferredAddress };
  }
  const version = value => {
    if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail(400, 'version_invalid', 'expectedVersion 必须为有效的非负整数版本。');
    return value;
  };
  const lookup = () => db.prepare('SELECT state_json,version,updated_at FROM buyer_shopping WHERE user_id=?').bind(user.id).first();
  const dto = row => row ? { state: validateState(JSON.parse(row.state_json), () => fail(503, 'unavailable', '云端购物资料暂不可读取，请稍后重试。')), version: row.version, updatedAt: row.updated_at }
    : { state: emptyState(), version: 0, updatedAt: null };
  const conflict = () => fail(409, 'version_conflict', '购物资料已在其他设备更新，请重新读取并核对后重做本次操作。');
  if (request.method === 'GET') return json(dto(await lookup()));
  sameOrigin(request);
  const body = await jsonBody(request);
  if (path === BASE) {
    if (!keys(body, ['expectedVersion', 'state'])) invalid();
    const expected = version(body.expectedVersion), state = validateState(body.state), time = new Date().toISOString();
    const statement = expected === 0
      ? db.prepare(`INSERT INTO buyer_shopping(user_id,state_json,version,updated_at)
          SELECT ?,?,1,? WHERE NOT EXISTS(SELECT 1 FROM buyer_shopping WHERE user_id=?)`).bind(user.id, JSON.stringify(state), time, user.id)
      : db.prepare('UPDATE buyer_shopping SET state_json=?,version=version+1,updated_at=? WHERE user_id=? AND version=?')
          .bind(JSON.stringify(state), time, user.id, expected);
    if (Number((await statement.run()).meta?.changes) !== 1) conflict();
    return json(dto(await lookup()));
  }
  if (!keys(body, ['orderId', 'expectedVersion'])) invalid();
  const expected = version(body.expectedVersion);
  if (typeof body.orderId !== 'string' || !ORDER_ID.test(body.orderId)) fail(404, 'not_found', '订单不存在或当前账户无权访问。');
  const orderRow = await db.prepare('SELECT order_json FROM orders WHERE id=? AND buyer_id=?').bind(body.orderId, user.id).first();
  if (!orderRow) fail(404, 'not_found', '订单不存在或当前账户无权访问。');
  const consumed = () => db.prepare('SELECT order_id FROM buyer_order_consumptions WHERE order_id=? AND buyer_id=?').bind(body.orderId, user.id).first();
  if (await consumed()) return json({ ...dto(await lookup()), consumed: true });
  const previous = dto(await lookup());
  if (previous.version !== expected) conflict();
  const order = JSON.parse(orderRow.order_json), items = Array.isArray(order.items) ? order.items : [order];
  const quantities = new Map();
  for (const item of items) {
    if (!item || typeof item.productId !== 'string' || !PRODUCT_ID.test(item.productId) || !['small', 'family'].includes(item.variant)
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) fail(409, 'order_snapshot_invalid', '订单商品快照无法安全核对，请保留购物车并联系演示客服。');
    const quantity = (quantities.get(sku(item)) || 0) + item.quantity;
    if (quantity > 10) fail(409, 'order_snapshot_invalid', '订单商品快照无法安全核对，请保留购物车并联系演示客服。');
    quantities.set(sku(item), quantity);
  }
  if (!items.length) fail(409, 'order_snapshot_invalid', '订单商品快照无法安全核对，请保留购物车并联系演示客服。');
  const next = { ...previous.state, cart: previous.state.cart.flatMap(row => {
    const quantity = row.selected ? quantities.get(sku(row)) || 0 : 0;
    return quantity >= row.quantity ? [] : [{ ...row, quantity: row.quantity - quantity }];
  }) };
  const time = new Date().toISOString();
  const gate = 'NOT EXISTS(SELECT 1 FROM buyer_order_consumptions WHERE order_id=?) AND EXISTS(SELECT 1 FROM orders WHERE id=? AND buyer_id=?)';
  const write = expected === 0
    ? db.prepare(`INSERT INTO buyer_shopping(user_id,state_json,version,updated_at) SELECT ?,?,1,?
        WHERE NOT EXISTS(SELECT 1 FROM buyer_shopping WHERE user_id=?) AND ${gate}`)
        .bind(user.id, JSON.stringify(next), time, user.id, body.orderId, body.orderId, user.id)
    : db.prepare(`UPDATE buyer_shopping SET state_json=?,version=version+1,updated_at=? WHERE user_id=? AND version=? AND ${gate}`)
        .bind(JSON.stringify(next), time, user.id, expected, body.orderId, body.orderId, user.id);
  await db.batch([write,
    db.prepare('INSERT INTO buyer_order_consumptions(order_id,buyer_id,created_at) SELECT ?,?,? WHERE changes()=1').bind(body.orderId, user.id, time)
  ]);
  if (!await consumed()) conflict();
  return json({ ...dto(await lookup()), consumed: true });
}
