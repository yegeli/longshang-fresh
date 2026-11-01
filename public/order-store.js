import { CloudError, apiRequest, getCloudState, requireManager } from './cloud-client.js';
import { orderItems, ADDRESSES } from './model.js';

// Cloud orders never use browser storage. The caller owns its display cache and
// the pending checkout key; no failed request is converted into a local order.
function account(manager = false) {
  const state = getCloudState();
  if (state.mode !== 'cloud' || !state.session?.user?.id || state.error) {
    throw new CloudError('请先登录，再查看或操作云端订单。', 401, 'sign_in_required');
  }
  if (manager) requireManager();
  return state.session.user.id;
}

function unchangedAccount(id, manager) {
  if (account(manager) !== id) throw new CloudError('登录账户已变化，请重新读取订单。', 409, 'account_changed');
}

function invalidResponse() { throw new CloudError('云端订单响应异常，请重新读取；没有保存本机记录。', 0, 'invalid_order_response'); }
const isDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function checkedOrder(order) {
  if (!order || !/^DEMO-[A-Z0-9-]+$/.test(order.id || '') || !Number.isSafeInteger(order.version) || order.version < 1
    || !isDate(order.createdAt) || !isDate(order.updatedAt) || !['created', 'cancelled'].includes(order.status)
    || !ADDRESSES.some(address => address.id === order.address && address.shipping !== null)) invalidResponse();
  const items = orderItems(order);
  if (!items.length || !['quantity', 'subtotal', 'shipping', 'total'].every(key => Number.isSafeInteger(order[key]) && order[key] >= 0)
    || order.quantity !== items.reduce((sum, item) => sum + item.quantity, 0)
    || order.subtotal !== items.reduce((sum, item) => sum + item.subtotal, 0)
    || order.total !== order.subtotal + order.shipping) invalidResponse();
  return order;
}

function route(manager) { return manager ? '/api/v1/admin/orders' : '/api/v1/orders'; }
function orderId(id) {
  if (typeof id !== 'string' || !/^DEMO-[A-Z0-9-]{1,100}$/.test(id)) throw new CloudError('订单编号无效。', 400, 'order_invalid');
  return encodeURIComponent(id);
}

async function request(path, { manager = false, body, method = 'GET' } = {}) {
  const id = account(manager);
  const data = await apiRequest(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  unchangedAccount(id, manager);
  return data;
}

export async function loadCloudOrders({ manager = false } = {}) {
  const id = account(manager), orders = new Map(), cursors = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const data = await request(`${route(manager)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { manager });
    unchangedAccount(id, manager);
    if (!Array.isArray(data.orders) || (data.nextCursor != null && (typeof data.nextCursor !== 'string' || !data.nextCursor))) invalidResponse();
    for (const value of data.orders) {
      const order = checkedOrder(value), previous = orders.get(order.id);
      if (!previous || order.version >= previous.version) orders.set(order.id, order);
    }
    cursor = data.nextCursor ?? null;
    if (!cursor) return { orders: [...orders.values()], lastSyncedAt: new Date().toISOString() };
    if (cursors.has(cursor)) invalidResponse();
    cursors.add(cursor);
  }
  throw new CloudError('订单较多，暂未完整读取，请稍后重试。', 0, 'order_page_limit');
}

export async function loadCloudOrder(id, { manager = false } = {}) {
  const data = await request(`${route(manager)}/${orderId(id)}`, { manager });
  const order = checkedOrder(data.order);
  if (order.id !== id) invalidResponse();
  return order;
}

export async function quoteCloudOrder(items, address) {
  const data = await request('/api/v1/orders/quote', { method: 'POST', body: { items, address } });
  const quote = data.quote;
  if (!quote || !Array.isArray(quote.items) || !quote.items.length || quote.address !== address
    || !Number.isSafeInteger(quote.total) || quote.total < 0 || !quote.productVersions || typeof quote.productVersions !== 'object') invalidResponse();
  return quote;
}

export function createOrderRequestKey() { return `ORDER-${crypto.randomUUID()}`; }

export async function submitCloudOrder(input) {
  const data = await request('/api/v1/orders', { method: 'POST', body: input });
  return checkedOrder(data.order);
}

export async function mutateCloudOrder(id, action, payload, { manager = false } = {}) {
  const actions = manager ? ['ship', 'note', 'aftersale/resolve'] : ['cancel', 'aftersale', 'aftersale/withdraw'];
  if (!actions.includes(action)) throw new CloudError('此身份不能执行该订单操作。', 403, 'forbidden');
  if (!Number.isSafeInteger(payload?.expectedVersion) || payload.expectedVersion < 1) throw new CloudError('请先读取最新订单版本。', 409, 'version_conflict');
  const data = await request(`${route(manager)}/${orderId(id)}/${action}`, { manager, method: 'POST', body: payload });
  const order = checkedOrder(data.order);
  if (order.id !== id) invalidResponse();
  return order;
}
