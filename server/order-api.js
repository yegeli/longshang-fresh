import { ADDRESSES, createAfterSale, updateAfterSale, shipOrder, saveOrderNote, resolveAfterSale } from '../public/model.js';
import { hasPermission, managementGuard, visibleSellerSQL } from './merchant-access.js';
import { inventoryDTO, inventoryJSON, MAX_STOCK } from './inventory-api.js';

const PREFIX = '/api/v1';
const ORDER_ID = /^DEMO-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PAGE_SIZE = 100;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const now = () => new Date().toISOString();
const uuid = prefix => `${prefix}-${crypto.randomUUID().toUpperCase()}`;

// Shared HTTP/auth helpers are injected to preserve the API's existing error boundary.
export async function handleOrderApi(request, env, helpers) {
  const url = new URL(request.url), path = url.pathname;
  const isAdminPath = path === `${PREFIX}/admin/orders` || path.startsWith(`${PREFIX}/admin/orders/`);
  if (!isAdminPath && path !== `${PREFIX}/orders` && !path.startsWith(`${PREFIX}/orders/`)) return null;
  const { identity, manager, requireDB, sameOrigin, jsonBody, fail, json, method } = helpers;
  const base = `${PREFIX}/${isAdminPath ? 'admin/' : ''}orders`;
  const user = isAdminPath ? await manager(request, env, false, ['orders', 'aftersales']) : await identity(request, env);
  if (!user) fail(401, 'sign_in_required', '请先登录，再查看或创建云端模拟订单。');
  const db = requireDB(env);
  const allowed = (body, keys) => {
    if (!object(body) || Object.keys(body).some(key => !keys.includes(key))) fail(400, 'order_invalid', '订单请求包含未知字段或格式无效。');
  };
  const version = value => {
    if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail(400, 'version_invalid', 'expectedVersion 必须为有效的正整数版本。');
    return value;
  };
  const afterSaleOnly = isAdminPath && !hasPermission(user, 'orders');
  const authorize = row => row && (isAdminPath ? user.role === 'admin' || (row.seller_id === user.id && (!afterSaleOnly || JSON.parse(row.order_json).afterSale)) : row.buyer_id === user.id);
  const dto = row => {
    const order = JSON.parse(row.order_json);
    if (!isAdminPath) delete order.merchantNote;
    delete order._stockReleaseToken;
    return { ...order, version: row.version, updatedAt: row.updated_at };
  };
  const lookup = async id => {
    if (!ORDER_ID.test(id)) fail(404, 'not_found', '订单不存在或当前账户无权访问。');
    const row = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
    if (!authorize(row)) fail(404, 'not_found', '订单不存在或当前账户无权访问。');
    return row;
  };
  const readBody = async () => { sameOrigin(request); return jsonBody(request); };

  function selection(body) {
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 12) fail(400, 'items_invalid', '请选择1至12种有效商品规格。');
    const seen = new Set();
    const items = body.items.map(item => {
      allowed(item, ['productId', 'variant', 'quantity']);
      if (typeof item.productId !== 'string' || !PRODUCT_ID.test(item.productId) || !['small', 'family'].includes(item.variant)
        || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) fail(400, 'items_invalid', '商品编号、规格或数量无效；每种规格限1至10份。');
      const key = `${item.productId}:${item.variant}`;
      if (seen.has(key)) fail(400, 'items_invalid', '同一商品规格不能重复，请合并数量后下单。');
      seen.add(key);
      return { productId: item.productId, variant: item.variant, quantity: item.quantity };
    }).sort((a, b) => `${a.productId}:${a.variant}`.localeCompare(`${b.productId}:${b.variant}`, 'en'));
    const address = ADDRESSES.find(value => value.id === body.address && value.shipping !== null);
    if (!address) fail(400, 'address_invalid', '请选择甘肃或陕西的示例收货地区；无需提供真实个人资料。');
    return { items, address: address.id };
  }

  async function quoteFor(selected) {
    const ids = [...new Set(selected.items.map(item => item.productId))];
    const rows = (await db.prepare(`SELECT id,owner_id,product_json,version,image_media_id FROM products WHERE status='published' AND ${visibleSellerSQL('products.owner_id')} AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results || [];
    if (rows.length !== ids.length) fail(409, 'product_unavailable', '选中商品已下架或不存在，请刷新商品后重新确认。');
    if (new Set(rows.map(row => row.owner_id)).size !== 1) fail(422, 'mixed_merchants', '当前模拟订单仅支持同一商家的商品，请按商家分开下单。');
    const inventoryRows = (await db.prepare(`SELECT * FROM product_inventory WHERE product_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results || [];
    const inventories = new Map(inventoryRows.map(row => [row.product_id, inventoryDTO(row)]));
    const byId = new Map(rows.map(row => [row.id, row]));
    const items = selected.items.map(item => {
      const row = byId.get(item.productId), product = JSON.parse(row.product_json), inventory = inventories.get(item.productId);
      if (!inventory || inventory.stocks[item.variant] < item.quantity) fail(409, 'stock_insufficient', '所选规格库存不足或尚未配置，请刷新后调整数量。');
      const variant = product.variants.find(value => value.id === item.variant);
      if (!variant || !Number.isSafeInteger(variant.price) || variant.price < 1) fail(409, 'product_unavailable', '商品规格已变更，请刷新商品后重新确认。');
      return { productId: row.id, product: product.name, image: product.image,
        ...(row.image_media_id ? { imageMediaId: row.image_media_id } : {}),
        batchId: inventory.batchId, batchCode: inventory.batchCode, harvestDate: inventory.harvestDate, batchNote: inventory.note,
        variant: variant.id, variantLabel: variant.label, weight: variant.weight,
        unitPrice: variant.price, quantity: item.quantity, subtotal: variant.price * item.quantity };
    });
    const address = ADDRESSES.find(value => value.id === selected.address);
    const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
    return { quote: { items, quantity: items.reduce((sum, item) => sum + item.quantity, 0), subtotal, shipping: address.shipping,
      total: subtotal + address.shipping, address: address.id, productVersions: Object.fromEntries(rows.sort((a, b) => a.id.localeCompare(b.id, 'en')).map(row => [row.id, row.version])),
      inventoryVersions: Object.fromEntries(ids.sort().map(id => [id, inventories.get(id).version])) }, sellerId: rows[0].owner_id, inventories };
  }

  if (path === base && request.method === 'GET') {
    const cursor = url.searchParams.get('cursor');
    if ([...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) fail(400, 'cursor_invalid', '分页参数无效。');
    let after = null;
    if (cursor !== null) {
      try {
        if (!/^[A-Za-z0-9_-]{1,220}$/.test(cursor)) throw new Error();
        after = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
        if (!Array.isArray(after) || after.length !== 2 || typeof after[0] !== 'string' || new Date(after[0]).toISOString() !== after[0] || !ORDER_ID.test(after[1])) throw new Error();
      } catch { fail(400, 'cursor_invalid', '分页参数无效，请重新读取订单列表。'); }
    }
    const constraints = isAdminPath ? (user.role === 'admin' ? [] : ['seller_id=?']) : ['buyer_id=?'];
    const values = constraints.length ? [user.id] : [];
    if (afterSaleOnly) constraints.push("json_type(order_json,'$.afterSale')='object'");
    if (after) { constraints.push('(created_at < ? OR (created_at = ? AND id < ?))'); values.push(after[0], after[0], after[1]); }
    const rows = (await db.prepare(`SELECT * FROM orders ${constraints.length ? `WHERE ${constraints.join(' AND ')}` : ''} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(...values, PAGE_SIZE + 1).all()).results || [];
    const page = rows.slice(0, PAGE_SIZE), last = page.at(-1);
    const nextCursor = rows.length > PAGE_SIZE ? btoa(JSON.stringify([last.created_at, last.id])).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') : null;
    return json({ orders: page.map(dto), updatedAt: now(), nextCursor });
  }

  if (!isAdminPath && path === `${base}/quote`) {
    method(request, ['POST']);
    const body = await readBody(); allowed(body, ['items', 'address']);
    return json({ quote: (await quoteFor(selection(body))).quote });
  }

  if (!isAdminPath && path === base && request.method === 'POST') {
    const body = await readBody(); allowed(body, ['items', 'address', 'expectedTotal', 'productVersions', 'inventoryVersions', 'idempotencyKey']);
    const selected = selection(body), ids = [...new Set(selected.items.map(item => item.productId))].sort();
    if (typeof body.idempotencyKey !== 'string' || !REQUEST_KEY.test(body.idempotencyKey)) fail(400, 'idempotency_invalid', '请提供8至128位有效的重复提交保护编号。');
    if (!Number.isSafeInteger(body.expectedTotal) || body.expectedTotal < 1 || !object(body.productVersions)
      || Object.keys(body.productVersions).length !== ids.length || ids.some(id => !Object.hasOwn(body.productVersions, id) || !Number.isSafeInteger(body.productVersions[id]) || body.productVersions[id] < 1 || body.productVersions[id] > Number.MAX_SAFE_INTEGER)) fail(400, 'quote_invalid', '请先获取并确认有效的云端报价。');
    const hasInventoryVersions = Object.hasOwn(body, 'inventoryVersions');
    if (hasInventoryVersions && (!object(body.inventoryVersions) || Object.keys(body.inventoryVersions).length !== ids.length || ids.some(id => !Number.isSafeInteger(body.inventoryVersions[id]) || body.inventoryVersions[id] < 1 || body.inventoryVersions[id] >= MAX_STOCK))) fail(400, 'quote_invalid', '库存报价版本无效，请重新读取。');
    const requestJson = JSON.stringify({ ...selected, expectedTotal: body.expectedTotal, productVersions: Object.fromEntries(ids.map(id => [id, body.productVersions[id]])),
      ...(hasInventoryVersions ? { inventoryVersions: Object.fromEntries(ids.map(id => [id, body.inventoryVersions[id]])) } : {}) });
    const replay = async () => {
      const previous = await db.prepare('SELECT * FROM orders WHERE buyer_id=? AND request_key=?').bind(user.id, body.idempotencyKey).first();
      if (!previous) return null;
      if (previous.request_json !== requestJson) fail(409, 'idempotency_conflict', '此提交编号已用于另一笔订单，请勿修改重试内容。');
      return json({ order: dto(previous), replayed: true });
    };
    const previous = await replay(); if (previous) return previous;
    if (!hasInventoryVersions) fail(400, 'quote_invalid', '请重新获取包含库存版本的报价后下单。');
    const { quote, sellerId, inventories } = await quoteFor(selected);
    if (quote.total !== body.expectedTotal || ids.some(id => quote.productVersions[id] !== body.productVersions[id] || quote.inventoryVersions[id] !== body.inventoryVersions[id])) fail(409, 'quote_changed', '商品价格或资料已变化，请重新读取报价并确认后下单。');
    const first = quote.items[0], count = new Set(quote.items.map(item => item.productId)).size, time = now();
    const order = { id: uuid('DEMO'), createdAt: time, ...first, product: count > 1 ? `${first.product}等${count}款商品` : first.product,
      items: quote.items, quantity: quote.quantity, subtotal: quote.subtotal, shipping: quote.shipping, total: quote.total,
      address: quote.address, status: 'created', afterSaleHistory: [] };
    const quantities = id => Object.fromEntries(['small','family'].map(variant => [variant, selected.items.filter(item => item.productId === id && item.variant === variant).reduce((sum,item) => sum+item.quantity,0)]));
    const conditions = ids.map(() => "(p.id=? AND p.version=? AND p.status='published' AND p.owner_id=? AND EXISTS(SELECT 1 FROM product_inventory i WHERE i.product_id=p.id AND i.version=? AND i.small_stock>=? AND i.family_stock>=?))");
    const guardValues = ids.flatMap(id => [id, quote.productVersions[id], sellerId, quote.inventoryVersions[id], quantities(id).small, quantities(id).family]);
    const statements = [db.prepare(`INSERT INTO orders(id,buyer_id,seller_id,request_key,request_json,order_json,version,created_at,updated_at)
      SELECT ?,?,?,?,?,?,1,?,? WHERE (SELECT count(*) FROM products p WHERE (${conditions.join(' OR ')}) AND ${visibleSellerSQL('p.owner_id')})=?
      ON CONFLICT(buyer_id,request_key) DO NOTHING`)
      .bind(order.id,user.id,sellerId,body.idempotencyKey,requestJson,JSON.stringify(order),time,time,...guardValues,ids.length)];
    for (const productId of ids) {
      const amount = quantities(productId), before = inventories.get(productId);
      const after = {...before,stocks:{small:before.stocks.small-amount.small,family:before.stocks.family-amount.family},version:before.version+1,updatedAt:time};
      statements.push(db.prepare(`INSERT INTO inventory_events(id,product_id,actor_id,action,reason,order_id,before_json,after_json,created_at)
        SELECT ?,?,?,'reserved',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=?)`)
        .bind(uuid('STOCK'),productId,user.id,'模拟下单扣减可售数量',order.id,JSON.stringify(before),JSON.stringify(after),time,order.id));
      statements.push(db.prepare(`UPDATE product_inventory SET small_stock=small_stock-?,family_stock=family_stock-?,version=version+1,updated_at=?,updated_by=?
        WHERE product_id=? AND EXISTS(SELECT 1 FROM orders WHERE id=?)`).bind(amount.small,amount.family,time,user.id,productId,order.id));
    }
    await db.batch(statements);
    const saved = await db.prepare('SELECT * FROM orders WHERE id=?').bind(order.id).first();
    if (!saved) { const retried = await replay(); if (retried) return retried; fail(409, 'quote_changed', '库存或商品在下单时发生变化，请重新获取报价后确认。'); }
    return json({ order: dto(saved), replayed: false }, 201);
  }

  if (path === base) { method(request, isAdminPath ? ['GET'] : ['GET', 'POST']); }
  const match = new RegExp(`^${base}/([^/]+)(?:/(cancel|aftersale(?:/withdraw|/resolve)?|ship|note))?$`).exec(path);
  if (!match) fail(404, 'not_found', '接口不存在。');
  const [, id, action] = match;
  if (!action) { method(request, ['GET']); return json({ order: dto(await lookup(id)) }); }
  const actions = isAdminPath ? ['ship', 'note', 'aftersale/resolve'] : ['cancel', 'aftersale', 'aftersale/withdraw'];
  if (!actions.includes(action)) fail(404, 'not_found', '接口不存在。');
  const permission = action === 'aftersale/resolve' ? 'aftersales' : 'orders';
  if (isAdminPath && !hasPermission(user, permission)) fail(403, 'forbidden', '此账户没有所需订单或售后权限。');
  method(request, ['POST']);
  const body = await readBody();
  allowed(body, { cancel: ['expectedVersion'], aftersale: ['expectedVersion', 'type', 'reason', 'description', 'hasEvidence'],
    'aftersale/withdraw': ['expectedVersion'], ship: ['expectedVersion', 'carrier', 'tracking'], note: ['expectedVersion', 'note'], 'aftersale/resolve': ['expectedVersion', 'reply'] }[action]);
  const expected = version(body.expectedVersion), row = await lookup(id);
  if (row.version !== expected) fail(409, 'version_conflict', '订单已在其他设备更新，请刷新后重新操作；本次未覆盖。');
  const order = JSON.parse(row.order_json), refunded = order.afterSale?.status === 'resolved' && order.afterSale.type === 'refund';
  let next;
  try {
    if (action === 'cancel') {
      if (order.status !== 'created' || order.fulfillment?.status === 'shipped' || order.afterSale?.status === 'submitted' || refunded) throw new Error('订单已取消、已发货、正在售后或已模拟退款，不能取消。');
      next = { ...order, status: 'cancelled' };
    } else if (action === 'aftersale') {
      if (refunded) throw new Error('整单模拟退款已完成，不能再次申请售后。');
      if ((order.afterSaleHistory?.length || 0) >= 100) throw new Error('此订单已达到模拟售后申请次数上限。');
      next = createAfterSale(order, body, uuid('AFTER'));
    } else if (action === 'aftersale/withdraw') next = updateAfterSale(order, 'withdrawn');
    else if (action === 'ship') next = shipOrder(order, body.carrier, body.tracking);
    else if (action === 'note') next = saveOrderNote(order, body.note);
    else if (action === 'aftersale/resolve') next = resolveAfterSale(order, body.reply);
  } catch (error) { fail(409, 'order_state_invalid', error.message); }
  if (action.startsWith('aftersale')) next.afterSaleHistory = [...(order.afterSaleHistory || []), { ...next.afterSale }];
  const ownership = isAdminPath ? " AND (seller_id=? OR EXISTS(SELECT 1 FROM users WHERE user_id=? AND role='admin'))" : ' AND buyer_id=?';
  const access = isAdminPath ? ` AND ${managementGuard(permission)}` : '';
  const time = now();
  // Only new inventory-backed orders can release stock. A unique token gates
  // every follow-up statement, so a losing version race can never restock twice.
  const backed = action === 'cancel' && Array.isArray(order.items) && order.items.length && order.items.every(item => typeof item.batchId === 'string' && item.batchId.startsWith('BATCH-'));
  if (backed) {
    const releaseToken = uuid('RELEASE'), ids = [...new Set(order.items.map(item => item.productId))];
    const quantities = id => Object.fromEntries(['small','family'].map(variant => [variant,order.items.filter(item => item.productId === id && item.variant === variant).reduce((sum,item) => sum+item.quantity,0)]));
    const guards = ids.map(() => 'EXISTS(SELECT 1 FROM product_inventory i WHERE i.product_id=? AND i.batch_id=? AND i.small_stock<=? AND i.family_stock<=? AND i.version<?)');
    const guardValues = ids.flatMap(productId => { const q=quantities(productId); return [productId,order.items.find(item=>item.productId===productId).batchId,MAX_STOCK-q.small,MAX_STOCK-q.family,MAX_STOCK]; });
    const eligible = guards.join(' AND ');
    const releaseGate = status => `EXISTS(SELECT 1 FROM orders o WHERE o.id=? AND json_extract(o.order_json,'$._stockReleaseToken')=? AND json_extract(o.order_json,'$.stockRelease.status')='${status}')`;
    const statements = [db.prepare(`UPDATE orders SET order_json=json_set(json(?),'$._stockReleaseToken',?,'$.stockRelease',
      json(CASE WHEN ${eligible} THEN json_object('status','released','message','取消成功，同批次库存已回补。')
      ELSE json_object('status','review','message','取消成功，批次已变化或库存需核对，整单未自动回补，请联系采购者。') END)),
      version=version+1,updated_at=? WHERE id=? AND version=?${ownership}${access}`)
      .bind(JSON.stringify(next),releaseToken,...guardValues,time,id,expected,user.id)];
    for (const productId of ids) {
      const q = quantities(productId);
      statements.push(db.prepare(`INSERT INTO inventory_events(id,product_id,actor_id,action,reason,order_id,before_json,after_json,created_at)
        SELECT ?,?,?,'released',?,?,${inventoryJSON('i')},${inventoryJSON('i','i.small_stock+?','i.family_stock+?','i.version+1','?')},?
        FROM product_inventory i WHERE i.product_id=? AND ${releaseGate('released')}`)
        .bind(uuid('STOCK'),productId,user.id,'取消未发货模拟订单，同批次回补',id,q.small,q.family,time,time,productId,id,releaseToken));
      statements.push(db.prepare(`UPDATE product_inventory SET small_stock=small_stock+?,family_stock=family_stock+?,version=version+1,updated_at=?,updated_by=?
        WHERE product_id=? AND ${releaseGate('released')}`).bind(q.small,q.family,time,user.id,productId,id,releaseToken));
      statements.push(db.prepare(`INSERT INTO inventory_events(id,product_id,actor_id,action,reason,order_id,before_json,after_json,created_at)
        SELECT ?,?,?,'release_review',?,?,${inventoryJSON('i')},${inventoryJSON('i')},?
        FROM product_inventory i WHERE i.product_id=? AND ${releaseGate('review')}`)
        .bind(uuid('STOCK'),productId,user.id,'取消成功，批次变化或安全范围需核对；整单不自动回补',id,time,productId,id,releaseToken));
    }
    await db.batch(statements);
    const saved = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
    if (!saved || JSON.parse(saved.order_json)._stockReleaseToken !== releaseToken) fail(409, 'version_conflict', '订单已在其他设备更新，请刷新后重新操作；本次未覆盖。');
    return json({order:dto(saved)});
  }
  const saved = await db.prepare(`UPDATE orders SET order_json=?,version=version+1,updated_at=? WHERE id=? AND version=?${ownership}${access} RETURNING *`)
    .bind(JSON.stringify(next), time, id, expected, user.id, ...(isAdminPath ? [user.id, user.id] : [])).first();
  if (!saved) fail(409, 'version_conflict', '订单已在其他设备更新，请刷新后重新操作；本次未覆盖。');
  return json({ order: dto(saved) });
}
