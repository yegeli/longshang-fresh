import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const root = resolve('miniprogram');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const event = dataset => ({ currentTarget: { dataset } });
function runtime() {
  const storage = new Map(), navigation = [], messages = [], modules = new Map();
  let definition;
  const wx = {
    getStorageSync(key) { return clone(storage.get(key)); },
    setStorageSync(key, value) { storage.set(key, clone(value)); },
    removeStorageSync(key) { storage.delete(key); },
    showModal(options) { options.success({ confirm: true }); },
    showToast(options) { messages.push(options.title); },
    navigateTo(options) { navigation.push(options.url); }, switchTab(options) { navigation.push(options.url); },
    redirectTo(options) { navigation.push(options.url); }, stopPullDownRefresh() {}
  };
  function load(path) {
    path = resolve(path);
    if (!path.endsWith('.js')) path += '.js';
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const context = vm.createContext({ module, exports: module.exports, wx, console, Page: page => { definition = page; },
      require: relative => load(resolve(dirname(path), relative)) });
    vm.runInContext(readFileSync(path, 'utf8'), context, { filename: path });
    return module.exports;
  }
  const market = load(resolve(root, 'services/market.js')).getMarket();
  function page(name, query = {}) {
    definition = undefined;
    const file = resolve(root, 'pages', name, 'index.js');
    modules.delete(file); load(file);
    assert.ok(definition, 'Page() registration missing: ' + name);
    const current = { ...definition, data: clone(definition.data), setData(patch) { Object.assign(this.data, clone(patch)); } };
    current.onLoad(query);
    return current;
  }
  return { wx, market, page, storage, navigation, messages, shared: load(resolve(root, 'pages/_shared.js')) };
}
async function open(runtime, name, query) {
  const page = runtime.page(name, query); await page.onShow();
  assert.equal(page.data.error, '', name + ': ' + page.data.error);
  return page;
}
async function prepareCheckout(runtime) {
  const product = await open(runtime, 'product', { id: 'jingtai-apple' });
  await product.addCart(); assert.equal(product.data.error, '');
  return open(runtime, 'checkout');
}

test('native page journey creates one stock-backed order, ships, receives and resolves after-sale', async () => {
  const r = runtime();
  const home = await open(r, 'home'); assert.equal(home.data.products.length, 6);
  const regions = await open(r, 'regions'); assert.equal(regions.data.regions.length, 2);
  const region = await open(r, 'region', { id: 'gansu-jingtai' }); assert.equal(region.data.products.length, 6);
  const shop = await open(r, 'shop', { id: region.data.shops[0].id }); assert.equal(shop.data.products.length, 6);
  const checkout = await prepareCheckout(r);
  await Promise.all([checkout.submit(), checkout.submit()]);
  const { orders } = await r.market.listOrders(); assert.equal(orders.length, 1);
  assert.match(r.navigation.at(-1), /\/pages\/order\/index\?id=DEMO-/);
  assert.equal((await r.market.getShopping()).state.cart.length, 0);
  const detail = await open(r, 'order', { id: orders[0].id });
  assert.equal(detail.data.order.canMockShip, true);
  await detail.operate(event({ action: 'ship' })); assert.equal(detail.data.order.statusText, '待收货');
  await detail.operate(event({ action: 'receive' })); assert.equal(detail.data.order.statusText, '已完成');
  const after = await open(r, 'aftersale', { id: orders[0].id });
  after.description({ detail: { value: '模拟包装问题' } }); await after.submit();
  await detail.onShow(); assert.equal(detail.data.order.canMockResolve, true);
  await detail.operate(event({ action: 'resolve' })); assert.equal(detail.data.order.statusText, '模拟退款完成');
  assert.equal((await r.market.getInventory()).inventories.find(row => row.productId === 'jingtai-apple').stocks.small, 19);
  const mine = await open(r, 'mine'); assert.equal(mine.data.recentCount, 1);
  const list = await open(r, 'orders'); assert.equal(list.data.orders.length, 1);
  assert.ok((await open(r, 'guide')).data.mode === 'mock');
});

test('lost create response retains original request and page reload retries without a second stock deduction', async () => {
  const r = runtime(); const checkout = await prepareCheckout(r);
  const create = r.market.createOrder.bind(r.market);
  let first = true;
  r.market.createOrder = async payload => { const response = await create(payload); if (first) { first = false; throw Error('模拟响应丢失'); } return response; };
  await checkout.submit(); assert.match(checkout.data.error, /响应丢失/);
  const resumed = await open(r, 'checkout'); assert.equal(resumed.data.hasPending, true);
  await resumed.submit(); assert.equal(resumed.data.error, '');
  assert.equal((await r.market.listOrders()).orders.length, 1);
  assert.equal((await r.market.getInventory()).inventories.find(row => row.productId === 'jingtai-apple').stocks.small, 19);
  assert.equal((await r.market.getShopping()).state.cart.length, 0);
});

test('failed pending-request persistence never sends an order on the first or second tap', async () => {
  const r = runtime(); const checkout = await prepareCheckout(r);
  const persist = r.wx.setStorageSync;
  r.wx.setStorageSync = (key, value) => { if (key.startsWith('longshang-mini-pending:')) throw Error('模拟存储已满'); persist(key, value); };
  await checkout.submit(); await checkout.submit();
  assert.equal((await r.market.listOrders()).orders.length, 0);
  assert.equal(checkout._pending, null);
});

test('post-create cleanup read failure keeps known order success and original recovery request', async () => {
  const r = runtime(); const checkout = await prepareCheckout(r);
  const read = r.wx.getStorageSync;
  r.wx.getStorageSync = key => { if (key.startsWith('longshang-mini-cleanup:')) throw Error('模拟购物车读取失败'); return read(key); };
  await checkout.submit();
  assert.equal(checkout.data.error, '');
  assert.equal((await r.market.listOrders()).orders.length, 1);
  assert.match(r.navigation.at(-1), /cartPending=1/);
  assert.ok([...r.storage.keys()].some(key => key.startsWith('longshang-mini-pending:')));
});

test('order cleanup retry removes only the matching confirmed checkout marker', async () => {
  const r = runtime(); const checkout = await prepareCheckout(r);
  const read = r.wx.getStorageSync;
  r.wx.getStorageSync = key => { if (key.startsWith('longshang-mini-cleanup:')) throw Error('模拟读取失败'); return read(key); };
  await checkout.submit();
  const order = (await r.market.listOrders()).orders[0];
  r.wx.getStorageSync = read;
  const detail = await open(r, 'order', { id: order.id, cartPending: '1' });
  await detail.retryCart();
  assert.equal((await r.market.getShopping()).state.cart.length, 0);
  assert.equal([...r.storage.keys()].some(key => key.startsWith('longshang-mini-pending:')), false);
  assert.equal(detail.data.cartPending, false);
});

test('post-create session-network failure cannot turn confirmed order into a failure', async () => {
  const r = runtime(); const checkout = await prepareCheckout(r);
  const original = r.market.createOrder.bind(r.market);
  r.market.createOrder = async payload => { const result = await original(payload); r.market.getSession = async () => { throw Error('模拟登录状态读取失败'); }; return result; };
  await checkout.submit();
  assert.equal(checkout.data.error, '');
  assert.equal((await r.market.listOrders()).orders.length, 1);
  assert.match(r.navigation.at(-1), /\/pages\/order\/index/);
});

test('after account changes during create, no original order snapshot is applied to new account navigation', async () => {
  const r = runtime(); const checkout = await prepareCheckout(r);
  const original = r.market.createOrder.bind(r.market);
  r.market.createOrder = async payload => { const result = await original(payload); r.market.getSession = async () => ({ user: { id: 'other-buyer' } }); return result; };
  await checkout.submit();
  assert.equal(checkout.data.error, '');
  assert.equal(r.navigation.at(-1), '/pages/mine/index');
  assert.ok(r.messages.includes('订单已生成，请切回原账号查看'));
});

test('obsolete read and unloaded-page response cannot replace newer page data', async () => {
  const r = runtime(); const page = r.page('home'); let resolveFirst, count = 0;
  r.market.getCatalog = () => ++count === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ products: [] });
  const older = page.refresh(); await page.refresh(); resolveFirst({ products: [{ bad: true }] }); await older;
  assert.equal(page.data.products.length, 0); assert.equal(page.data.error, '');
  const unloaded = r.page('home'); let release;
  r.market.getCatalog = () => new Promise(resolve => { release = resolve; });
  const pending = unloaded.refresh(); unloaded.onUnload(); release({ products: [] }); await pending;
  assert.equal(unloaded.data.loading, true);
});

test('cloud order view never exposes mock merchant actions', () => {
  const r = runtime(); r.market.mode = 'cloud';
  const waiting = r.shared.orderView({ id: 'DEMO-X', status: 'created', total: 1, items: [] });
  const after = r.shared.orderView({ id: 'DEMO-X', status: 'created', total: 1, items: [], afterSale: { status: 'submitted' } });
  assert.equal(waiting.canMockShip, false); assert.equal(after.canMockResolve, false);
});

test('checkout recovery stays with its CloudBase environment and function for the same account', async () => {
  const r = runtime();
  r.market.storageNamespace = 'cloudbase:environment-a:market';
  const checkout = await prepareCheckout(r);
  const create = r.market.createOrder.bind(r.market);
  r.market.createOrder = async () => { throw Error('模拟请求未送达'); };
  await checkout.submit();
  const keyA = 'longshang-mini-pending:cloudbase:environment-a:market:native-mock-buyer';
  const stored = r.storage.get(keyA);
  assert.ok(stored?.payload?.idempotencyKey);
  r.market.storageNamespace = 'cloudbase:environment-b:market';
  const environmentB = await open(r, 'checkout');
  assert.equal(environmentB.data.hasPending, false);
  assert.equal(environmentB._pending, null);
  r.market.storageNamespace = 'cloudbase:environment-a:another-function';
  assert.equal((await open(r, 'checkout')).data.hasPending, false);
  r.market.storageNamespace = 'cloudbase:environment-a:market';
  const resumed = await open(r, 'checkout');
  assert.equal(resumed.data.hasPending, true);
  assert.equal(resumed._pending.payload.idempotencyKey, stored.payload.idempotencyKey);
  r.market.createOrder = create;
  await resumed.submit();
  assert.equal(resumed.data.error, '');
  assert.equal((await r.market.listOrders()).orders.length, 1);
});

test('order cleanup removes only current environment recovery markers and leaves another environment intact', async () => {
  const r = runtime();
  r.market.storageNamespace = 'cloudbase:environment-a:market';
  const checkout = await prepareCheckout(r); await checkout.submit();
  const order = (await r.market.listOrders()).orders[0];
  const account = 'native-mock-buyer';
  const namespaceA = 'cloudbase:environment-a:market:' + account;
  const namespaceB = 'cloudbase:environment-b:market:' + account;
  const marker = { accountId: account, confirmedOrderId: order.id };
  for (const namespace of [namespaceA, namespaceB]) {
    r.storage.set('longshang-mini-cleanup:' + namespace, [order.id]);
    r.storage.set('longshang-mini-pending:' + namespace, clone(marker));
  }
  const detail = await open(r, 'order', { id: order.id });
  assert.equal(detail.data.cartPending, true);
  await detail.retryCart();
  assert.equal(r.storage.has('longshang-mini-pending:' + namespaceA), false);
  assert.deepEqual(r.storage.get('longshang-mini-cleanup:' + namespaceA), []);
  assert.deepEqual(r.storage.get('longshang-mini-pending:' + namespaceB), marker);
  assert.deepEqual(r.storage.get('longshang-mini-cleanup:' + namespaceB), [order.id]);
});

test('home search always uses the complete catalogue and preserves active filters on refresh', async () => {
  const r=runtime(),home=await open(r,'home');
  home.input({detail:{value:'苹果'}});home.search();assert.equal(home.data.products[0].id,'jingtai-apple');
  home.input({detail:{value:'土豆'}});home.search();assert.equal(home.data.products.length,1);assert.equal(home.data.products[0].id,'potato');
  await home.onShow();assert.equal(home.data.products.length,1);assert.equal(home.data.appliedKeyword,'土豆');
  home.input({detail:{value:'  '}});home.search();assert.equal(home.data.products.length,6);
  home.chooseCategory(event({id:'fruit'}));assert.equal(home.data.products.length,2);
  home.input({detail:{value:'景泰 苹果'}});home.search();assert.equal(home.data.products.length,1);
  home.input({detail:{value:'不存在'}});home.search();assert.equal(home.data.products.length,0);
  home.all();assert.equal(home.data.products.length,6);assert.equal(home.data.filtered,false);
});

test('shop category, search and stock filters remain scoped to that shop and recover from no results', async () => {
  const r=runtime(),getStorefront=r.market.getStorefront.bind(r.market);
  r.market.getStorefront=async()=>{const value=await getStorefront();value.shops[0].productIds=['jingtai-apple','goji'];return value;};
  const shop=await open(r,'shop',{id:'shop-native-demo'});assert.equal(shop.data.products.length,2);
  shop.input({detail:{value:'土豆'}});shop.search();assert.equal(shop.data.products.length,0);
  shop.input({detail:{value:'枸杞'}});shop.search();assert.equal(shop.data.products[0].id,'goji');
  shop.all();shop.chooseCategory(event({id:'fruit'}));assert.equal(shop.data.products[0].id,'jingtai-apple');
  const data=r.storage.get('longshang-native-mock-v1');data.inventories['jingtai-apple'].stocks={small:0,family:0};r.storage.set('longshang-native-mock-v1',data);
  await shop.onShow();shop.toggleStock({detail:{value:true}});assert.equal(shop.data.products.length,0);
  shop.chooseCategory(event({id:'all'}));assert.equal(shop.data.products[0].id,'goji');
  await shop.onShow();assert.equal(shop.data.inStock,true);assert.equal(shop.data.products.length,1);
  shop.all();assert.equal(shop.data.products.length,2);assert.equal(shop.data.count,2);
});
