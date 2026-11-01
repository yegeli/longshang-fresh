require('./compat');
const model = require('./generated/model');
const defaultConfig = require('../config');
const MOCK_KEY = 'longshang-native-mock-v1';
const clone = value => JSON.parse(JSON.stringify(value));
const emptyShopping = () => ({ cart: [], favorites: [], recent: [], preferredAddress: 'gansu' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const error = (code, message, status) => Object.assign(new Error(message), { code, status: status || 0 });
const fail = (code, message, status) => { throw error(code, message, status); };
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
  const value = Math.floor(Math.random() * 16); return (char === 'x' ? value : (value & 3) | 8).toString(16);
}).toUpperCase();
const now = () => new Date().toISOString();
const PRODUCTS = model.BASE_CATALOG.map(product => ({ ...model.normalizeCatalogProduct({ ...product, status: 'published' }), version: 1 }));

function validOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i.test(value)
    || /(?:^|\.)chatgpt\.site(?::443)?\/?$/i.test(value.replace(/^https:\/\//i, ''))
    || /^https:\/\/(?:localhost|127\.|0\.|\[)/i.test(value)) fail('api_config_invalid', '请配置独立微信 API 的 HTTPS 根地址，不能使用网页演示站点。');
  return value.replace(/\/$/, '').replace(/:443$/, '');
}
function validateShopping(value) {
  if (!object(value) || Object.keys(value).length !== 4 || !['cart','favorites','recent','preferredAddress'].every(key => Object.prototype.hasOwnProperty.call(value, key))
    || !model.ADDRESSES.some(item => item.id === value.preferredAddress) || !Array.isArray(value.cart) || value.cart.length > 12) fail('shopping_invalid', '购物资料格式无效。');
  const seen = new Set();
  for (const row of value.cart) {
    const key = row && row.productId + '::' + row.variant;
    if (!object(row) || Object.keys(row).length !== 4 || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(row.productId)
      || !['small','family'].includes(row.variant) || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 10
      || typeof row.selected !== 'boolean' || seen.has(key)) fail('shopping_invalid', '购物车规格或数量无效。');
    seen.add(key);
  }
  for (const key of ['favorites','recent']) if (!Array.isArray(value[key]) || value[key].length > 20 || new Set(value[key]).size !== value[key].length
    || value[key].some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(id))) fail('shopping_invalid', '收藏或足迹格式无效。');
  return clone(value);
}
function version(value) { if (!Number.isSafeInteger(value) || value < 0) fail('version_invalid', '版本无效，请刷新后重试。'); return value; }

function createMarket(wxApi, settings) {
  const config = { ...defaultConfig, ...settings };
  if (!['mock','cloud'].includes(config.mode)) fail('mode_invalid', '请选择明确的模拟或云端运行模式。');
  if (!wxApi || typeof wxApi.getStorageSync !== 'function' || typeof wxApi.setStorageSync !== 'function') fail('runtime_missing', '请在微信小程序中运行。');
  const cloud = config.mode === 'cloud', origin = cloud ? validOrigin(config.apiBase) : '';
  const authKey = cloud ? 'longshang-native-auth:' + origin : '';
  let generation = 0, auth = null, loginFlight = null;
  if (cloud) {
    const stored = wxApi.getStorageSync(authKey);
    if (object(stored) && typeof stored.token === 'string' && /^wxs_[a-f0-9]{64}$/.test(stored.token)
      && typeof stored.expiresAt === 'string' && Date.parse(stored.expiresAt) > Date.now()) auth = clone(stored);
    else if (stored !== undefined && stored !== null && stored !== '') wxApi.removeStorageSync(authKey);
  }
  const clearAuth = () => {
    auth = null; generation++;
    // A storage failure must not interrupt a 401 callback and leave its Promise
    // pending. Expired/revoked server sessions stay unusable if local removal fails.
    try { wxApi.removeStorageSync(authKey); } catch (_) { /* Runtime identity is already cleared. */ }
  };
  const hasAuth = () => {
    if (auth && Date.parse(auth.expiresAt) <= Date.now()) clearAuth();
    return !!auth;
  };
  const request = (path, method, data, options) => {
    if (!/^\/api\/v1\/[a-z0-9/_-]+$/i.test(path)) return Promise.reject(error('path_invalid', '接口路径无效。'));
    const publicRequest = !!(options && options.public), authenticated = hasAuth();
    if (!publicRequest && !authenticated) return Promise.reject(error('sign_in_required', '请先使用微信登录。', 401));
    const cursor = options && options.cursor;
    if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,220}$/.test(cursor)) return Promise.reject(error('cursor_invalid', '订单分页资料无效。'));
    const revision = generation, token = auth && auth.token;
    return new Promise((resolve, reject) => {
      wxApi.request({ url: origin + path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), method: method || 'GET', data,
        header: { Accept: 'application/json', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        timeout: Math.min(30000, Math.max(1000, config.requestTimeout || 15000)), enableHttp2: true,
        success: response => {
          if (revision !== generation) return reject(error('stale_session', '账号已切换，请重新读取。'));
          let result = response.data;
          try { if (typeof result === 'string') result = JSON.parse(result); }
          catch (_) { return reject(error('response_invalid', '云端响应无法读取，请稍后重试。')); }
          if (!object(result)) return reject(error('response_invalid', '云端响应格式无效。'));
          if (response.statusCode < 200 || response.statusCode >= 300) {
            if (response.statusCode === 401 && token && auth && auth.token === token) clearAuth();
            const remote = result.error || {};
            return reject(error(typeof remote.code === 'string' ? remote.code : 'request_failed', typeof remote.message === 'string' ? remote.message : '云端请求失败，请稍后重试。', response.statusCode));
          }
          resolve(result);
        },
        fail: () => reject(error('network_error', '云端连接未完成，请检查网络并重试；不会切回本机模拟。'))
      });
    });
  };
  function readMock() {
    const saved = wxApi.getStorageSync(MOCK_KEY);
    if (saved !== undefined && saved !== null && saved !== '') {
      if (!object(saved) || saved.schema !== 1 || !object(saved.inventories) || !Array.isArray(saved.orders) || !object(saved.shopping) || !Array.isArray(saved.consumed)) fail('mock_data_invalid', '本机模拟资料异常，请保留记录并联系开发者。');
      return clone(saved);
    }
    const updatedAt = now();
    const initial = { schema: 1, inventories: Object.fromEntries(PRODUCTS.map(product => [product.id, {
      productId: product.id, configured: true, stocks: { small: 20, family: 12 }, batchId: 'BATCH-' + uuid(),
      batchCode: 'DEMO-NATIVE-' + product.id.toUpperCase(), harvestDate: '', note: '本机小程序模拟库存，非真实货源。', version: 1, updatedAt
    }])), orders: [], shopping: { state: emptyShopping(), version: 0, updatedAt: null }, consumed: [] };
    wxApi.setStorageSync(MOCK_KEY, clone(initial)); return initial;
  }
  function mutateMock(action) {
    const state = readMock(), result = action(state);
    wxApi.setStorageSync(MOCK_KEY, clone(state));
    return clone(result);
  }
  function lookupOrder(state, id) {
    const index = state.orders.findIndex(row => row.order.id === id);
    if (index < 0) fail('not_found', '订单不存在。', 404);
    return state.orders[index];
  }
  function checkVersion(order, expected) { if (version(expected) !== order.version) fail('version_conflict', '资料已变化，请刷新后重试。', 409); }
  function quoteMock(state, items, address) {
    if (!Array.isArray(items) || !items.length || items.length > 12 || !model.ADDRESSES.some(row => row.id === address && row.shipping !== null)) fail('quote_invalid', '请选择商品和支持的示例收货地区。');
    const seen = new Set();
    for (const row of items) {
      if (!object(row) || Object.keys(row).length !== 3) fail('items_invalid', '下单商品只接受编号、规格和数量。');
      const key = row.productId + '::' + row.variant, product = PRODUCTS.find(item => item.id === row.productId);
      if (!product || !['small','family'].includes(row.variant) || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 10 || seen.has(key)) fail('items_invalid', '商品规格或数量无效。');
      seen.add(key);
      if (state.inventories[row.productId].stocks[row.variant] < row.quantity) fail('stock_insufficient', '所选规格库存不足，请调整数量。', 409);
    }
    model.setCatalog(PRODUCTS);
    const q = model.quoteCart(items.map(row => ({ ...row, selected: true })), address);
    const ids = [...new Set(items.map(row => row.productId))].sort();
    return { ...q, address, items: q.items.map(row => {
      const batch = state.inventories[row.productId];
      return { ...row, batchId: batch.batchId, batchCode: batch.batchCode, harvestDate: batch.harvestDate, batchNote: batch.note };
    }), productVersions: Object.fromEntries(ids.map(id => [id, 1])), inventoryVersions: Object.fromEntries(ids.map(id => [id, state.inventories[id].version])) };
  }
  function mutation(id, expected, action, value) {
    return mutateMock(state => {
      const record = lookupOrder(state, id), order = record.order;
      checkVersion(order, expected);
      let next;
      if (action === 'cancel') {
        if (order.status !== 'created' || order.fulfillment || order.receipt || order.afterSale && (order.afterSale.status === 'submitted' || order.afterSale.status === 'resolved' && order.afterSale.type === 'refund')) fail('order_state_invalid', '当前订单不能取消。', 409);
        const original = order.items.every(item => state.inventories[item.productId] && state.inventories[item.productId].batchId === item.batchId);
        if (original) {
          for (const productId of new Set(order.items.map(item => item.productId))) {
            const inventory = state.inventories[productId];
            for (const item of order.items.filter(row => row.productId === productId)) inventory.stocks[item.variant] += item.quantity;
            inventory.version++; inventory.updatedAt = now();
          }
        }
        next = { ...order, status: 'cancelled', inventoryRelease: { status: original ? 'released' : 'review' } };
      } else if (action === 'receive') next = model.receiveOrder(order);
      else if (action === 'ship') next = model.shipOrder(order, '演示物流', 'DEMO-NATIVE-' + uuid());
      else if (action === 'aftersale') {
        if (order.afterSale && order.afterSale.status === 'resolved' && order.afterSale.type === 'refund') fail('order_state_invalid', '该订单已完成模拟退款。', 409);
        next = model.createAfterSale(order, value, 'AFTER-' + uuid());
      } else if (action === 'withdraw') next = model.updateAfterSale(order, 'withdrawn');
      else if (action === 'resolve') next = model.resolveAfterSale(order, value || '已完成模拟处理，无真实退款或补发。');
      if (['aftersale','withdraw','resolve'].includes(action)) next.afterSaleHistory = [...(order.afterSaleHistory || []), clone(next.afterSale)];
      record.order = { ...next, version: order.version + 1, updatedAt: now() };
      return { order: record.order };
    });
  }
  const market = {
    mode: config.mode,
    addresses: clone(model.ADDRESSES),
    getAddresses: () => clone(model.ADDRESSES), money: model.money, newRequestKey: () => 'NATIVE-' + uuid(),
    assetUrl(path) {
      if (typeof path !== 'string' || !path) return '';
      if (/^\/?assets\/[a-z0-9-]+\.jpg$/i.test(path)) {
        const name = path.split('/').pop();
        return '/assets/' + (['apples.jpg','goji.jpg','pear.jpg','potato.jpg','corn.jpg','onion.jpg'].includes(name) ? name : 'apples.jpg');
      }
      if (cloud && /^\/api\/v1\/media\/CLOUD-[a-f0-9-]{36}$/i.test(path)) return origin + path;
      if (cloud && path.startsWith(origin + '/api/v1/media/') && /^CLOUD-[a-f0-9-]{36}$/i.test(path.slice((origin + '/api/v1/media/').length))) return path;
      return '';
    },
    imageFor(product) { return cloud && product && product.imageMediaId ? this.assetUrl('/api/v1/media/' + product.imageMediaId) : this.assetUrl(product && product.image); },
    videoFor(product) { return cloud && product && product.videoMediaId ? this.assetUrl('/api/v1/media/' + product.videoMediaId) : ''; },
    async getCatalog() { return cloud ? request('/api/v1/products', 'GET', undefined, { public: true }) : { products: clone(PRODUCTS), updatedAt: null }; },
    async getInventory() { return cloud ? request('/api/v1/inventory', 'GET', undefined, { public: true }) : { inventories: Object.values(readMock().inventories), updatedAt: null }; },
    async getStorefront() {
      if (cloud) return request('/api/v1/storefront', 'GET', undefined, { public: true });
      const ids = PRODUCTS.map(row => row.id), shopId = 'shop-native-demo';
      return { regions: [
        { id: 'gansu-jingtai', name: '甘肃 · 景泰', province: '甘肃', subtitle: '从家乡的果园与农田出发', description: '模拟产区与采购资料，货源待核实。', image: 'assets/apples.jpg', preview: false, productIds: ids, shopIds: [shopId] },
        { id: 'shaanxi-dingbian', name: '陕西 · 定边（筹备示意）', province: '陕西', subtitle: '筹备示意 · 暂无在售商品', description: '仅为未来产区结构示意，暂无在售商品。', image: 'assets/potato.jpg', preview: true, productIds: [], shopIds: [] }
      ], shops: [{ id: shopId, name: '景泰好物示范店', procurementName: '示范采购员', regionIds: ['gansu-jingtai'], regionLabel: '甘肃 · 景泰（模拟）', description: '本机模拟店铺，不代表真实供货与采购合作。', image: 'assets/apples.jpg', simulation: true, preview: false, productIds: ids }], updatedAt: null };
    },
    async getSession() {
      if (!cloud) return { user: { id: 'native-mock-buyer', name: '模拟体验用户', email: '' }, role: 'buyer', canManage: false, permissions: [], merchant: null, authProvider: 'mock' };
      if (!hasAuth()) return { user: null, role: 'anonymous', permissions: [], canManage: false, merchant: null, authProvider: 'wechat' };
      return request('/api/v1/session');
    },
    async login() {
      if (!cloud) return { session: await market.getSession(), expiresAt: null };
      if (loginFlight) return loginFlight;
      generation++; const revision = generation; auth = null; wxApi.removeStorageSync(authKey);
      loginFlight = new Promise((resolve, reject) => wxApi.login({ timeout: 10000, success: result => result.code ? resolve(result.code) : reject(error('login_failed', '微信登录未完成，请重试。')), fail: () => reject(error('login_failed', '微信登录未完成，请重试。')) }))
        .then(code => request('/api/v1/auth/wechat/login', 'POST', { code }, { public: true })).then(result => {
          if (revision !== generation) fail('stale_session', '登录已取消，请重试。');
          if (!/^wxs_[a-f0-9]{64}$/.test(result.token || '') || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now() || !result.session || !result.session.user) fail('response_invalid', '登录响应格式无效。');
          const next = { token: result.token, expiresAt: result.expiresAt };
          wxApi.setStorageSync(authKey, next); auth = next;
          return { session: result.session, expiresAt: result.expiresAt };
        }).finally(() => { loginFlight = null; });
      return loginFlight;
    },
    async logout() {
      if (!cloud) return;
      if (hasAuth()) {
        const revision = generation;
        await request('/api/v1/auth/wechat/logout', 'POST', {});
        if (generation === revision) clearAuth();
      } else clearAuth();
    },
    async getShopping() { return cloud ? request('/api/v1/me/shopping') : readMock().shopping; },
    async updateShopping(state, expectedVersion) {
      validateShopping(state); version(expectedVersion);
      if (cloud) return request('/api/v1/me/shopping', 'PUT', { state, expectedVersion });
      return mutateMock(data => { if (data.shopping.version !== expectedVersion) fail('version_conflict', '购物资料已变化，请刷新后重试。', 409); data.shopping = { state: clone(state), version: expectedVersion + 1, updatedAt: now() }; return data.shopping; });
    },
    async quote(items, address) { return cloud ? request('/api/v1/orders/quote', 'POST', { items, address }) : { quote: quoteMock(readMock(), items, address) }; },
    async createOrder(payload) {
      if (cloud) return request('/api/v1/orders', 'POST', payload);
      return mutateMock(state => {
        if (!object(payload) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(payload.idempotencyKey || '')) fail('idempotency_invalid', '请保留有效的提交编号。');
        if (Object.keys(payload).length !== 6 || !['items','address','expectedTotal','productVersions','inventoryVersions','idempotencyKey'].every(key => Object.prototype.hasOwnProperty.call(payload,key))) fail('quote_invalid', '下单请求格式无效。');
        const sorted = value => object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : null;
        const productVersions = sorted(payload.productVersions), inventoryVersions = sorted(payload.inventoryVersions);
        const canonical = JSON.stringify({ items: payload.items, address: payload.address, expectedTotal: payload.expectedTotal, productVersions, inventoryVersions });
        const previous = state.orders.find(row => row.requestKey === payload.idempotencyKey);
        if (previous) { if (previous.requestJson !== canonical) fail('idempotency_conflict', '提交编号已用于其他内容，请核对原订单。', 409); return { order: previous.order, replayed: true }; }
        const q = quoteMock(state, payload.items, payload.address);
        if (q.total !== payload.expectedTotal || JSON.stringify(q.productVersions) !== JSON.stringify(productVersions) || JSON.stringify(q.inventoryVersions) !== JSON.stringify(inventoryVersions)) fail('quote_changed', '报价或库存已变化，请重新确认。', 409);
        const time = now(), first = q.items[0];
        const order = { ...first, id: 'DEMO-' + uuid(), createdAt: time, updatedAt: time, version: 1, items: q.items, quantity: q.quantity,
          product: new Set(q.items.map(row => row.productId)).size > 1 ? first.product + '等好物' : first.product,
          subtotal: q.subtotal, shipping: q.shipping, total: q.total, address: q.address, status: 'created', afterSaleHistory: [] };
        for (const id of Object.keys(q.inventoryVersions)) {
          const inventory = state.inventories[id];
          for (const row of q.items.filter(item => item.productId === id)) inventory.stocks[row.variant] -= row.quantity;
          inventory.version++; inventory.updatedAt = time;
        }
        state.orders.unshift({ requestKey: payload.idempotencyKey, requestJson: canonical, order });
        return { order, replayed: false };
      });
    },
    async listOrders() {
      if (!cloud) return { orders: readMock().orders.map(row => row.order), nextCursor: null };
      const orders = [], cursors = new Set(), ids = new Set();
      let cursor, updatedAt = null;
      for (let page = 0; page < 100; page++) {
        const result = await request('/api/v1/orders', 'GET', undefined, cursor ? { cursor } : undefined);
        if (!Array.isArray(result.orders)) fail('response_invalid', '订单列表格式无效。');
        for (const order of result.orders) {
          if (!order || typeof order.id !== 'string' || ids.has(order.id)) fail('response_invalid', '订单列表重复，请重新读取。');
          ids.add(order.id); orders.push(order);
        }
        updatedAt = result.updatedAt;
        if (!result.nextCursor) return { orders, updatedAt, nextCursor: null };
        if (cursors.has(result.nextCursor)) fail('cursor_invalid', '订单分页重复，请重新读取。');
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      fail('pagination_limit', '订单历史过多，请缩小查询范围后重试。');
    },
    async getOrder(id) { return cloud ? request('/api/v1/orders/' + encodeURIComponent(id)) : { order: lookupOrder(readMock(), id).order }; },
    async cancelOrder(id, expectedVersion) { return cloud ? request('/api/v1/orders/' + encodeURIComponent(id) + '/cancel', 'POST', { expectedVersion }) : mutation(id, expectedVersion, 'cancel'); },
    async receiveOrder(id, expectedVersion) { return cloud ? request('/api/v1/orders/' + encodeURIComponent(id) + '/receive', 'POST', { expectedVersion }) : mutation(id, expectedVersion, 'receive'); },
    async createAfterSale(id, input) { return cloud ? request('/api/v1/orders/' + encodeURIComponent(id) + '/aftersale', 'POST', input) : mutation(id, input.expectedVersion, 'aftersale', input); },
    async withdrawAfterSale(id, expectedVersion) { return cloud ? request('/api/v1/orders/' + encodeURIComponent(id) + '/aftersale/withdraw', 'POST', { expectedVersion }) : mutation(id, expectedVersion, 'withdraw'); },
    async mockShipOrder(id, expectedVersion) { if (cloud) fail('mock_only', '云端订单需要有权限的商家在后台发货。', 403); return mutation(id, expectedVersion, 'ship'); },
    async mockResolveAfterSale(id, expectedVersion, reply) { if (cloud) fail('mock_only', '云端售后需要有权限的商家在后台处理。', 403); return mutation(id, expectedVersion, 'resolve', reply); },
    async consumeOrder(orderId, expectedVersion) {
      if (cloud) return request('/api/v1/me/shopping/consume-order', 'POST', { orderId, expectedVersion });
      return mutateMock(state => {
        if (state.consumed.includes(orderId)) return { ...state.shopping, consumed: true };
        if (state.shopping.version !== expectedVersion) fail('version_conflict', '购物车已变化，请刷新后重试清理。', 409);
        const order = lookupOrder(state, orderId).order, quantities = new Map(order.items.map(row => [row.productId + '::' + row.variant, row.quantity]));
        state.shopping.state.cart = state.shopping.state.cart.flatMap(row => {
          const count = row.selected ? quantities.get(row.productId + '::' + row.variant) || 0 : 0;
          return count >= row.quantity ? [] : [{ ...row, quantity: row.quantity - count }];
        });
        state.shopping.version++; state.shopping.updatedAt = now(); state.consumed.push(orderId);
        return { ...state.shopping, consumed: true };
      });
    }
  };
  return market;
}

let singleton;
function getMarket() { if (!singleton) singleton = createMarket(wx, defaultConfig); return singleton; }
module.exports = { createMarket, getMarket };
for (const key of ['getAddresses','assetUrl','imageFor','videoFor','getCatalog','getInventory','getStorefront','getSession','login','logout','getShopping','updateShopping','quote','createOrder','listOrders','getOrder','cancelOrder','receiveOrder','createAfterSale','withdrawAfterSale','mockShipOrder','mockResolveAfterSale','consumeOrder','newRequestKey']) module.exports[key] = (...args) => getMarket()[key](...args);
module.exports.money = model.money;
module.exports.addresses = clone(model.ADDRESSES);
