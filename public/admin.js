import { CATALOG, getProduct, money, STORAGE_KEY, ADDRESSES, validOrders, orderItems, createOrder, createAfterSale, shipOrder, saveOrderNote, resolveAfterSale } from './model.js';
import { CATALOG_KEY, readCatalog, saveProduct, setProductStatus, newProductTemplate, parsePrice, refreshCatalog, getProductVersion } from './catalog-store.js';
import { hydrateMedia, imageFor, videoFor, saveMedia, mediaErrorFor } from './media-store.js';
import { initializeCloudMode, getCloudState, isCloudMode, apiRequest, authHref, hasPermission, managementScopeKey } from './cloud-client.js';
import { loadCloudOrders, loadCloudOrder, mutateCloudOrder } from './order-store.js';
import { loadMerchants, loadMerchant, saveMerchant, loadMerchantAudit } from './merchant-store.js';
import { loadInventories, saveInventory, loadInventoryHistory } from './inventory-store.js';
import { esc, icon } from './ui.js';

const app = document.querySelector('#admin-app');
const nav = document.querySelector('#admin-nav');
const alerts = document.querySelector('#admin-alerts');
const drawerRoot = document.querySelector('#drawer-root');
const toastElement = document.querySelector('#admin-toast');
const SEED_KEY = 'longshang-admin-samples-v1';
const categoryNames = { fruit: '水果鲜食', dried: '枸杞干货', vegetable: '田间蔬菜' };
const productStatuses = { published: '在售', draft: '草稿', offline: '已下架' };
const afterStatuses = { submitted: '待处理', resolved: '已完成', withdrawn: '已撤回' };
const afterReasons = { damaged: '破损或品质问题', spec: '规格不符', delivery: '配送问题', other: '其他问题' };
const viewNames = { overview: '经营概览', products: '商品管理', orders: '订单管理', aftersales: '售后管理', merchants: '商家账号', inventory: '库存批次' };
const imagePresets = [
  ['assets/apples.jpg', '苹果'], ['assets/goji.jpg', '枸杞'], ['assets/pear.jpg', '鲜梨'],
  ['assets/potato.jpg', '土豆'], ['assets/corn.jpg', '玉米'], ['assets/onion.jpg', '洋葱']
];
const state = {
  view: 'overview', products: [], orders: [], errors: {}, editor: null, drawer: null,
  productsFilter: { query: '', category: 'all', status: 'all' },
  ordersFilter: { query: '', status: 'all' }, aftersalesFilter: { query: '', status: 'all' },
  externalChanged: false, mediaIssues: [], busy: false, ready: false, syncing: false,
  ordersSyncedAt: '', accountId: null, accessRole: null, scopeKey: null, epoch: 0,
  inventories: [], inventoryEditor: null, inventoryHistory: null, inventoryFilter: { query: '', status: 'all' },
  merchants: [], merchantEditor: null, merchantAudit: null, merchantFilter: { query: '', region: 'all', status: 'all', bound: 'all' }
};
let toastTimer;
let lastFocused;

const clone = value => JSON.parse(JSON.stringify(value));
const dateText = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const textError = error => error?.message || '操作未完成，请重试。';
const lostAccess = error => [401, 403].includes(error?.status) || error?.code === 'account_changed';
const isSample = order => order.id.startsWith('DEMO-SAMPLE-');
const isShipped = order => order.fulfillment?.status === 'shipped';
const isRefunded = order => order.afterSale?.status === 'resolved' && order.afterSale.type === 'refund';
const isWaiting = order => order.status === 'created' && !isShipped(order) && !isRefunded(order);
const orderStatus = order => order.status === 'cancelled' ? 'cancelled' : isRefunded(order) ? 'refunded' : isShipped(order) ? 'shipped' : 'waiting';
const orderStatusName = order => ({ cancelled: '已取消', shipped: '已发货', refunded: '模拟退款完成', waiting: '待发货' })[orderStatus(order)];
const badge = (label, type = '') => `<span class="badge ${type}">${esc(label)}</span>`;
const empty = (title, description) => `<div class="empty-state">${icon('box', 38)}<h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;

function toast(message) {
  clearTimeout(toastTimer); toastElement.textContent = message; toastElement.hidden = false;
  toastTimer = setTimeout(() => { toastElement.hidden = true; }, 3500);
}
function can(permission) { return !isCloudMode() || hasPermission(permission); }
function isAdmin() { return isCloudMode() && getCloudState().session?.role === 'admin'; }
function canView(view) { if (view === 'inventory') return can('products'); return view === 'overview' || (view === 'merchants' ? !isCloudMode() || isAdmin() : can(view)); }
function hasAccess() {
  const cloud = getCloudState();
  return state.ready && (cloud.mode === 'local' || (cloud.mode === 'cloud' && cloud.session?.user && cloud.session.canManage === true && !cloud.error && ['products', 'orders', 'aftersales'].some(permission => hasPermission(permission))));
}
function operationScope() { return { key: state.scopeKey, epoch: state.epoch }; }
function scopeValid(scope) {
  if (isCloudMode() && state.scopeKey !== managementScopeKey()) { verifyCurrentAccount(); if (!hasAccess()) renderGate(); }
  return hasAccess() && scope.key === state.scopeKey && scope.epoch === state.epoch;
}
function wireMediaErrors(scope) {
  scope.querySelectorAll('img').forEach(image => image.addEventListener('error', () => {
    if (image.dataset.mediaFailure) return;
    image.dataset.mediaFailure = 'true';
    image.alt = '素材读取失败，显示内置示意图';
    image.src = image.dataset.fallback || 'assets/orchard.jpg';
    image.insertAdjacentHTML('afterend', '<small class="media-read-error" role="status">素材读取失败，当前为内置示意图。请重新选择并保存。</small>');
  }));
  scope.querySelectorAll('video').forEach(video => video.addEventListener('error', () => {
    if (video.dataset.mediaFailure) return;
    video.dataset.mediaFailure = 'true';
    video.insertAdjacentHTML('afterend', '<small class="media-read-error" role="status">视频暂时无法读取或播放，请重新选择素材。</small>');
  }));
}
function renderSyncStatus() {
  const node = document.querySelector('#cloud-status');
  if (!node) return;
  const cloud = getCloudState(), session = cloud.session;
  const stamp = cloud.lastSyncedAt ? new Date(cloud.lastSyncedAt) : null;
  const time = stamp && Number.isFinite(stamp.getTime()) ? dateText(stamp.toISOString()) : '尚未同步';
  const ordersTime = state.ordersSyncedAt ? dateText(state.ordersSyncedAt) : '尚未读取';
  node.innerHTML = cloud.mode === 'local'
    ? '<span class="sync-dot local"></span><div><strong>本机演示模式</strong><small>商品、订单与售后仅保存在当前浏览器</small></div>'
    : `<span class="sync-dot ${state.syncing ? 'pending' : state.errors.sync || state.errors.orders ? 'failed' : ''}"></span><div><strong>${state.syncing ? '正在读取云端资料…' : state.errors.sync || state.errors.orders ? '云端同步未完成' : '商品、订单与售后 · 云端同步'}</strong><small>商品：${esc(time)} · 订单：${esc(ordersTime)}${session?.user ? ` · ${esc(session.user.name || session.user.email || '已登录')}` : ''}</small></div>${hasAccess() ? '<button class="text-button" data-action="refresh-cloud">刷新</button>' : ''}${session?.user && authHref(session.signOutUrl) ? `<a class="text-button" href="${esc(authHref(session.signOutUrl))}" target="_top">退出</a>` : ''}`;
  const note = document.querySelector('#workspace-mode-note');
  if (note) note.textContent = cloud.mode === 'local' ? '商品、素材、订单与售后保存在当前浏览器，不会同步服务器。' : '商品、素材、模拟订单与售后保存云端，手机和电脑登录同一账号可同步查看。';
  const notice = document.querySelector('#scope-notice');
  if (notice) notice.textContent = cloud.mode === 'local' ? '本机模拟数据，不会真实收款、退款或发货。' : '模拟订单、发货与售后云端同步，不接支付，不会真实发货、退款或补发。';
}
function clearPrivateState() {
  state.epoch++; state.products = []; state.orders = []; state.ordersSyncedAt = ''; state.drawer = null; state.editor = null;
  state.inventories = []; state.inventoryEditor = null; state.inventoryHistory = null; state.inventoryFilter = { query: '', status: 'all' };
  state.merchants = []; state.merchantEditor = null; state.merchantAudit = null; state.mediaIssues = []; state.errors = {};
  state.productsFilter={query:'',category:'all',status:'all'}; state.ordersFilter={query:'',status:'all'}; state.aftersalesFilter={query:'',status:'all'}; state.merchantFilter={query:'',region:'all',status:'all',bound:'all'};
  state.externalChanged = false; state.accountId = null; state.accessRole = null; state.scopeKey = null;
  drawerRoot.innerHTML = ''; document.body.classList.remove('drawer-open');
  // Clear already-rendered private content before any new-account request awaits.
  app.innerHTML = '<div class="initial-state">正在重新读取当前账号的店铺资料…</div>';
  nav.hidden = true; alerts.innerHTML = '';
  clearTimeout(toastTimer); toastElement.textContent = ''; toastElement.hidden = true;
}
function verifyCurrentAccount() {
  const session = getCloudState().session;
  if (isCloudMode() && (!session?.user || !session.canManage || !['admin', 'merchant'].includes(session.role) || !['products','orders','aftersales'].some(permission => hasPermission(permission)))) { clearPrivateState(); return false; }
  const current = isCloudMode() ? session.user.id : 'local';
  const role = isCloudMode() ? session.role : 'local';
  const scope = isCloudMode() ? managementScopeKey() : 'local';
  if (state.scopeKey !== null && state.scopeKey !== scope) clearPrivateState();
  state.accountId = current; state.accessRole = role; state.scopeKey = scope;
  if (!canView(state.view)) state.view = 'overview';
  return true;
}
function renderGate(error = '') {
  nav.hidden = true; drawerRoot.innerHTML = ''; alerts.innerHTML = '';
  document.querySelector('#view-title').textContent = '店铺工作台';
  const cloud = getCloudState(), session = cloud.session;
  const waiting = cloud.mode === 'uninitialized' || (!state.ready && !error);
  const login = authHref(session?.signInUrl || '/signin-with-chatgpt?return_to=%2Fadmin.html');
  const logout = authHref(session?.signOutUrl || '/signout-with-chatgpt?return_to=%2Fadmin.html');
  app.innerHTML = `<section class="auth-card"><div class="auth-emblem">陇</div><span class="eyebrow">LONGSHANG FRESH · 工作台</span><h2>${waiting ? '正在连接店铺…' : error ? '连接暂未完成' : session?.user ? '这个账户尚无管理权限' : '登录，开始打理家乡好物'}</h2><p>${waiting ? '正在确认登录状态和可访问的商品目录。' : error ? esc(error) : session?.user ? '请联系店铺管理员开通权限。买家页面仍可浏览已发布商品。' : '使用平台账户登录，安全管理商品、素材和发布状态。'}</p>${!waiting ? `<div class="auth-actions">${!session?.user ? `<a class="primary" href="${esc(login)}" target="_top">使用 ChatGPT 登录</a>` : `<a class="secondary" href="${esc(logout)}" target="_top">退出并切换账户</a>`}<button class="text-button" data-action="retry-auth">重新连接</button></div>` : '<span class="auth-loading" aria-label="正在读取"></span>'}<a class="auth-buyer" href="./#/home">先去逛逛家乡好物 ↗</a><small>商品与素材为模拟展示 · 无真实支付<br>云端无法连接时不会切回本机管理</small></section>`;
  renderSyncStatus();
}
async function boot(force = false) {
  clearPrivateState();
  state.ready = false; renderGate();
  try {
    await initializeCloudMode({ force });
    state.ready = true;
    if (!verifyCurrentAccount() || !hasAccess()) { renderGate(); return; }
    const scope = operationScope();
    await loadManagementData(scope);
    if (!scopeValid(scope)) return;
    if (!isCloudMode() && !state.errors.orders && !state.errors.catalog) seedSamples();
    await loadMedia(scope);
    if (!scopeValid(scope)) return;
    delete state.errors.sync; render();
  } catch (error) { clearPrivateState(); state.ready = false; state.errors.sync = textError(error); renderGate(textError(error)); }
}
async function loadManagementData(scope) {
  if (can('products')) {
    await refreshCatalog({ admin: isCloudMode() });
    if (!scopeValid(scope)) return;
  }
  loadData();
  if (isCloudMode() && (can('orders') || can('aftersales'))) {
    try { await loadRemoteOrders(scope); } catch (error) { if (lostAccess(error)) throw error; }
  }
  if (!scopeValid(scope)) return;
  if (isAdmin()) {
    try { await refreshMerchants(scope); } catch (error) { if (lostAccess(error)) throw error; }
  }
  if (!scopeValid(scope)) return;
  if (isCloudMode() && can('products')) {
    try { await refreshInventories(scope); } catch (error) { if (lostAccess(error)) throw error; }
  }
  if (!scopeValid(scope)) return;
}
async function refreshRemote({ manual = false } = {}) {
  if (!hasAccess() || !isCloudMode() || state.syncing || state.busy) return;
  if (state.editor) syncEditor(document.querySelector('#product-form'));
  if (state.merchantEditor) syncMerchantEditor(document.querySelector('#merchant-form'));
  if (state.inventoryEditor) syncInventoryEditor(document.querySelector('#inventory-form'));
  const previousScope = state.scopeKey;
  state.syncing = true; renderSyncStatus();
  try {
    await initializeCloudMode({ force: true });
    if (!verifyCurrentAccount() || !hasAccess()) { renderGate(); return; }
    const scope = operationScope();
    await loadManagementData(scope);
    if (!scopeValid(scope)) return;
    await loadMedia(scope);
    if (!scopeValid(scope)) return;
    delete state.errors.sync;
    if (state.drawer && state.orders.find(order => order.id === state.drawer.id)?.version !== state.drawer.expectedVersion) {
      state.drawer.externalChanged = true; renderDrawerNotice();
    }
    if (state.editor) { state.externalChanged = true; renderAlerts(); }
    else if (!state.drawer) render();
    if (manual) toast(state.editor || state.drawer || state.merchantEditor || state.inventoryEditor ? '已读取云端；当前填写内容保留，重新载入前不会覆盖。' : '已更新当前账号可管理的云端资料');
  } catch (error) { state.errors.sync = textError(error); if (lostAccess(error) || !getCloudState().session?.canManage || previousScope !== state.scopeKey) { clearPrivateState(); state.ready = false; renderGate(textError(error)); } else renderAlerts(); }
  finally { state.syncing = false; renderSyncStatus(); }
}
function readOrders() {
  if (isCloudMode()) throw new Error('云端模式不读取本机订单。');
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch { throw new Error('无法读取订单。请检查浏览器的本地存储权限。'); }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error();
    return validOrders(parsed);
  } catch { throw new Error('本浏览器的订单数据格式异常，未覆盖原数据。'); }
}
function writeOrders(orders) {
  if (isCloudMode()) throw new Error('云端订单不能写入本机存储。');
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(orders)); }
  catch { throw new Error('订单保存失败。浏览器存储可能已满或被禁用，本次操作没有完成。'); }
}
function loadData() {
  if (!hasAccess()) return;
  if (can('products')) {
    try { readCatalog(); state.products = [...CATALOG]; delete state.errors.catalog; }
    catch (error) { state.products = []; state.errors.catalog = textError(error); }
  } else state.products = [];
  if (!isCloudMode()) {
    try { state.orders = readOrders(); delete state.errors.orders; }
    catch (error) { state.errors.orders = textError(error); }
  }
}
async function loadRemoteOrders(scope = operationScope()) {
  if (!can('orders') && !can('aftersales')) return;
  try {
    const data = await loadCloudOrders({ manager: true });
    if (!scopeValid(scope)) return;
    const existing = new Map(state.orders.map(order => [order.id, order]));
    // An older in-flight read must not undo a write that just succeeded.
    state.orders = data.orders.map(order => existing.get(order.id)?.version > order.version ? existing.get(order.id) : order);
    state.ordersSyncedAt = data.lastSyncedAt;
    delete state.errors.orders;
  } catch (error) { if (scopeValid(scope)) state.errors.orders = `订单与售后未同步：${textError(error)}`; throw error; }
}
async function loadMedia(scope = operationScope()) {
  try {
    const issues = await hydrateMedia([...state.products, ...state.orders.flatMap(orderItems)]) || [];
    if (!scopeValid(scope)) return;
    state.mediaIssues = issues; delete state.errors.media;
  } catch { if (scopeValid(scope)) state.errors.media = '素材暂时无法读取，请稍后重试。'; }
}
function seedSamples() {
  try {
    if (localStorage.getItem(SEED_KEY)) return;
    const current = readOrders();
    const ids = new Set(current.map(order => order.id));
    const available = state.products.filter(product => (product.status || 'published') === 'published');
    if (!available.length) return;
    const now = Date.now();
    const spec = [
      ['DEMO-SAMPLE-001', 'jingtai-apple', 2, 'gansu', 2],
      ['DEMO-SAMPLE-002', 'pear', 1, 'shaanxi', 10],
      ['DEMO-SAMPLE-003', 'potato', 1, 'gansu', 5]
    ];
    const added = spec.filter(([id]) => !ids.has(id)).map(([id, productId, quantity, address, hours], index) => {
      const product = available.find(item => item.id === productId) || available[index % available.length];
      const createdAt = new Date(now - hours * 3600000).toISOString();
      let order = createOrder({ productId: product.id, variant: product.variants[0].id, quantity, address }, id, createdAt);
      order = saveOrderNote(order, '后台示例订单，无真实客户；可体验备注、模拟发货或售后。');
      if (id === 'DEMO-SAMPLE-002') order = shipOrder(order, '演示物流', 'DEMO-SAMPLE-TRACK-002', new Date(now - 8 * 3600000).toISOString());
      if (id === 'DEMO-SAMPLE-003') order = createAfterSale(order, { type: 'refund', reason: 'damaged', description: '示例问题：收到的外箱有挤压，希望按整单金额体验模拟退款。', hasEvidence: false }, 'AFTER-SAMPLE-003', new Date(now - 3 * 3600000).toISOString());
      return order;
    });
    const merged = validOrders([...current, ...added]);
    if (added.length) writeOrders(merged);
    state.orders = merged;
    localStorage.setItem(SEED_KEY, '1');
  } catch (error) { state.errors.samples = `示例订单初始化未完成：${textError(error)}`; }
}
function renderAlerts() {
  const errors = Object.values(state.errors);
  alerts.innerHTML = errors.map(error => `<div class="alert error" role="alert">${icon('chat', 18)}<p>${esc(error)}</p><button data-action="retry-data">重新读取</button></div>`).join('') +
    (state.externalChanged ? `<div class="alert warning">${icon('clock', 18)}<p>已读取更新，当前表单内容仍保留。保存时会校验编辑版本，避免覆盖其他人的修改。</p><button data-action="reload-editor">放弃当前修改并重新载入</button></div>` : '');
}
function render() {
  if (!hasAccess()) { renderGate(); return; }
  if (!verifyCurrentAccount() || !hasAccess()) { renderGate(); return; }
  if (!canView(state.view)) state.view = 'overview';
  nav.hidden = false; renderSyncStatus();
  const title = state.inventoryEditor ? '设置库存与批次' : state.merchantEditor ? (state.merchantEditor.isNew ? '添加商家' : '编辑商家账号') : state.editor ? (state.editor.isNew ? '新增商品' : '编辑商品') : viewNames[state.view];
  document.querySelector('#view-title').textContent = title;
  document.title = `${title} · 陇上鲜集管理后台`;
  nav.querySelectorAll('[data-view]').forEach(button => {
    button.hidden = !canView(button.dataset.view);
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  renderAlerts();
  app.innerHTML = state.editor ? productEditor() : ({ overview, products: productsPage, orders: ordersPage, aftersales: aftersalesPage, merchants: merchantsPage, inventory: inventoryPage })[state.view]();
  wireMediaErrors(app); renderDrawer();
}
function sectionIntro(kicker, title, copy, action = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${esc(kicker)}</span><h2>${esc(title)}</h2><p>${esc(copy)}</p></div>${action}</div>`;
}
function overview() {
  const active = can('orders') ? state.orders.filter(order => order.status !== 'cancelled') : [];
  const metrics = [];
  if (can('products')) metrics.push([state.products.filter(p => (p.status || 'published') === 'published').length, '在售商品', 'products', 'leaf']);
  if (can('orders')) metrics.push([active.length, '有效演示订单', 'orders', 'orders'], [active.filter(isWaiting).length, '待发货订单', 'waiting', 'truck']);
  if (can('aftersales')) metrics.push([state.orders.filter(order => order.afterSale?.status === 'submitted').length, '待处理售后', 'pending', 'chat']);
  const merchant = getCloudState().session?.merchant;
  return `${sectionIntro('STORE AT A GLANCE', merchant ? `${merchant.name}，把好物认真打理。` : '把每一份好物，认真打理。', merchant ? `${merchant.region} · 仅显示已分配给你的管理内容。` : '从商品上架到订单服务，在这里看见店铺的每一步。', can('products') ? '<button class="primary" data-action="new-product">＋ 新增商品</button>' : '')}
    <div class="metric-grid">${metrics.map(([number, label, target, i]) => `<button class="metric-card" data-action="metric" data-target="${target}"><span>${esc(label)} ${icon(i, 20)}</span><strong>${number}<small>${target === 'products' ? '款' : '笔'}</small></strong><em>进入管理 ${icon('arrow', 13)}</em></button>`).join('')}</div>
    <p class="local-scope-note">${isCloudMode() ? '仅显示当前账号获准管理的云端资料，手机和电脑登录同一账号可同步。' : '订单与售后为本机模拟。'} 所有订单、发货与售后均为模拟，不代表真实收入。</p>
    ${can('orders') ? `<section class="panel"><div class="panel-heading"><div><h3>最近的订单</h3><p>核对订单后可保存备注与模拟发货。</p></div><button class="text-button" data-view="orders">查看全部 ${icon('arrow', 14)}</button></div>${orderTable([...state.orders].sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 5))}</section>` : can('aftersales') ? `<section class="panel permission-welcome"><h3>专注处理售后</h3><p>当前账号只会读取已发生售后的订单，核对申请后留下清楚的模拟处理意见。</p><button class="secondary" data-view="aftersales">前往售后管理</button></section>` : `<section class="panel permission-welcome"><h3>先把一款好物介绍清楚</h3><p>完善商品规格、价格、图片和产地视频，保存后可在买家页面查看。</p><button class="secondary" data-view="products">前往商品管理</button></section>`}`;
}
const inventoryStatuses = { unconfigured: '未设置库存', empty: '有规格缺货', low: '有规格库存偏低', ready: '库存充足' };
function inventoryFor(productId) {
  return state.inventories.find(item => item.productId === productId) || { productId, configured:false, stocks:{small:0,family:0},batchId:'',batchCode:'',harvestDate:'',note:'',version:0,updatedAt:null };
}
function inventoryStatus(item) {
  if (!item.configured) return 'unconfigured';
  if (Object.values(item.stocks).some(value => value === 0)) return 'empty';
  return Object.values(item.stocks).some(value => value <= 5) ? 'low' : 'ready';
}
async function refreshInventories(scope = operationScope()) {
  if (!isCloudMode() || !can('products')) return;
  try {
    const data = await loadInventories({admin:true});
    if (!scopeValid(scope)) return;
    const previous = new Map(state.inventories.map(item => [item.productId,item]));
    state.inventories = data.inventories.map(item => previous.get(item.productId)?.version > item.version ? previous.get(item.productId) : item);
    delete state.errors.inventory;
    if (state.inventoryEditor && inventoryFor(state.inventoryEditor.productId).version !== state.inventoryEditor.expectedVersion) state.inventoryEditor.externalChanged=true;
  } catch (error) { if (scopeValid(scope)) state.errors.inventory=`库存与批次未同步：${textError(error)}`; throw error; }
}
function inventoryPage() {
  if (!isCloudMode()) return `${sectionIntro('INVENTORY & HARVEST', '库存批次', '按规格记录可售余量，让采收介绍跟随订单。')}<section class="panel permission-welcome"><h3>库存管理需要连接云端</h3><p>本机演示不扣减或回补云端库存。请在云端以有商品管理权限的账号登录后设置。</p></section>`;
  if (!can('products')) return '';
  if (state.inventoryEditor) return inventoryEditorPage();
  if (state.inventoryHistory) return inventoryHistoryPage();
  const f=state.inventoryFilter;
  const list=state.products.filter(product => (!f.query || [product.name,product.origin,inventoryFor(product.id).batchCode].join(' ').toLowerCase().includes(f.query.toLowerCase())) && (f.status==='all' || inventoryStatus(inventoryFor(product.id))===f.status));
  const missing=state.products.filter(product=>!inventoryFor(product.id).configured).length;
  return `${sectionIntro('INVENTORY & HARVEST', '先核实余量，再把好物送出去。', '每种规格按“份”管理当前可售余量，不是农场总产量；所有数量与采收资料仍为模拟。')}
    <section class="inventory-explainer"><strong>${missing ? `${missing} 款商品还未设置库存` : '库存与模拟订单在云端联动'}</strong><p>未配置或对应规格为 0 时不能新下单。模拟下单扣减余量，符合条件的取消只回补一次；售后不会自动回库。更换批次后，旧批次取消会留下待核对记录。</p></section>
    <section class="panel"><form class="filter-bar" id="search-inventory"><label class="search-control">${icon('search',18)}<input name="query" value="${esc(f.query)}" placeholder="搜索商品、产地或批次" aria-label="搜索商品、产地或批次" maxlength="80"></label><label class="select-control"><span>库存状态</span><select data-filter="inventory" name="status">${options(inventoryStatuses,f.status,'全部库存')}</select></label><button type="submit" class="secondary">搜索</button><button type="button" class="text-button" data-action="reset-inventory-filter">重置</button></form><div class="table-caption">共 ${list.length} 款商品<span>按商品规格管理 · 余量单位：份</span></div>${list.length ? `<div class="table-wrap"><table class="admin-table inventory-table"><thead><tr><th>商品</th><th>两种规格可售余量</th><th>当前采收批次</th><th>库存状态</th><th>操作</th></tr></thead><tbody>${list.map(product=>{ const item=inventoryFor(product.id), status=inventoryStatus(item); return `<tr><td data-label="商品"><div class="merchant-identity"><strong>${esc(product.name)}</strong><small>${esc(product.origin)} · ${esc(productStatuses[product.status] || product.status)}</small></div></td><td data-label="可售余量"><div class="inventory-counts">${product.variants.map(variant=>`<span>${esc(variant.label)}<b>${item.stocks[variant.id]}<small>份</small></b></span>`).join('')}</div></td><td data-label="采收批次"><strong class="inventory-batch">${esc(item.batchCode || '待填写')}</strong><small class="cell-note">${esc(item.harvestDate || '未填写采收日期')}</small></td><td data-label="状态">${badge(inventoryStatuses[status], status==='ready'?'published':'warning')}</td><td data-label="操作"><div class="row-actions"><button class="text-button" data-action="edit-inventory" data-id="${esc(product.id)}" ${state.errors.inventory?'disabled':''}>${item.configured?'调整库存':'设置库存'}</button><button class="text-button" data-action="inventory-history" data-id="${esc(product.id)}">库存记录</button></div></td></tr>`;}).join('')}</tbody></table></div>` : empty('没有符合条件的商品','先在商品管理中添加商品，或调整筛选条件。')}</section>`;
}
function inventoryEditorFrom(productId) {
  const item=inventoryFor(productId);
  return {productId,base:clone(item),expectedVersion:item.version,dirty:false,conflict:false,externalChanged:false,error:'',values:{small:String(item.stocks.small),family:String(item.stocks.family),batchCode:item.batchCode,harvestDate:item.harvestDate,note:item.note,reason:''}};
}
function openInventoryEditor(productId) {
  if (!isCloudMode() || !can('products') || state.errors.inventory || !state.products.some(item=>item.id===productId) || !mayLeaveEditor()) return;
  state.view='inventory'; state.inventoryEditor=inventoryEditorFrom(productId); closeDrawer(); render();
}
function inventoryEditorPage() {
  const e=state.inventoryEditor,v=e.values,product=state.products.find(item=>item.id===e.productId);
  return `<div class="editor-heading"><button type="button" class="text-button back-button" data-action="back-inventory">${icon('back',16)} 返回库存列表</button><span>${e.dirty?'有未保存的修改':'点击保存才会写入云端'}</span></div>${sectionIntro('CURRENT AVAILABLE STOCK', product?.name || '设置库存', '填写当前还可以出售的份数；订单已经扣减的份数不应重复计入。')}<form id="inventory-form" class="merchant-editor inventory-editor"><section class="panel form-panel"><div class="form-section-heading"><span>01</span><div><h3>两种规格的可售余量</h3><p>数量为整数份数，0 表示该规格暂时缺货。</p></div></div><div class="inventory-template"><button type="button" class="secondary small" data-action="inventory-template">填入模拟库存 20 / 12</button><small>只填写表单，不会自动保存；正式供货前应重新核实。</small></div><div class="form-grid">${(product?.variants || []).map(variant=>field(`${variant.label} · 可售份数`,variant.id,v[variant.id],'type="number" required min="0" max="999999" step="1" inputmode="numeric"')).join('')}</div><p class="field-help">每次人工设置为 0–999999 份。取消回补可能使当前余量高于此上限，展示数量以云端为准，请核对后再调整。</p></section>
    <section class="panel form-panel"><div class="form-section-heading"><span>02</span><div><h3>当前采收批次</h3><p>将当前批次和介绍保存在新订单快照中，之后修改不会改变旧订单。</p></div></div><div class="form-grid">${field('批次编号','batchCode',v.batchCode,'required maxlength="80" placeholder="例如 DEMO-JINGTAI-20261101"')}${field('采收日期（可留空）','harvestDate',v.harvestDate,'type="date"')}<div class="full-width">${textarea('批次介绍（模拟）','note',v.note,300)}</div><div class="full-width">${textarea('本次调整原因','reason',v.reason,200)}</div></div><p class="form-warning">更换批次编号或采收日期会开始新批次。旧批次订单取消时不会加到新批次库存，需在库存记录中核对；售后退款或补发也不会自动回库。</p></section>
    <section class="panel merchant-save-panel">${e.conflict || e.externalChanged ? `<div class="drawer-sync-note changed"><p>${e.conflict?'库存已在下单或其他设备操作后变化，当前填写内容已保留。':'云端余量有更新，当前填写内容仍保留，保存时会检查版本。'}请先复制需要的内容，再放弃当前填写并重新读取。</p><button type="button" class="text-button" data-action="reload-inventory">放弃当前填写并重新读取</button></div>`:''}<div id="inventory-form-error" class="field-error" role="alert">${esc(e.error)}</div><button type="submit" class="primary" ${state.busy||e.conflict?'disabled':''}>${state.busy?'正在保存…':'保存库存与批次'}</button><button type="button" class="text-button" data-action="back-inventory">返回列表</button><small>只保存模拟库存，不接支付。</small></section></form>`;
}
function syncInventoryEditor(form) {
  const e=state.inventoryEditor;if(!e||!form)return;
  const data=new FormData(form);
  for(const name of ['small','family','batchCode','harvestDate','note','reason']) if(data.has(name)) e.values[name]=String(data.get(name));
}
function fillInventoryTemplate() {
  const e=state.inventoryEditor;if(!isCloudMode()||!can('products')||!e)return;
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  e.values={small:'20',family:'12',batchCode:`DEMO-${e.productId.toUpperCase()}-${date.replaceAll('-','')}`,harvestDate:date,note:'模拟采收批次：规格与采摘情况待真实货源核实。',reason:'初始化模拟可售库存'};
  e.dirty=true;render();
}
async function saveInventoryForm(form) {
  const e=state.inventoryEditor;if(!isCloudMode()||!can('products')||!e||state.busy||e.conflict)return;
  syncInventoryEditor(form);const v=e.values,stocks={small:Number(v.small),family:Number(v.family)};
  if(['small','family'].some(key=>!String(v[key]).trim()||!Number.isSafeInteger(stocks[key])||stocks[key]<0||stocks[key]>999999)) {e.error='两种规格的可售余量必须是 0–999999 的整数份数。';render();return;}
  const input={stocks,batchCode:v.batchCode.trim(),harvestDate:v.harvestDate.trim(),note:v.note.trim(),reason:v.reason.trim()};
  if(!input.batchCode||input.batchCode.length>80||!input.reason||input.reason.length>200||input.note.length>300) {e.error='请填写批次编号和调整原因，并核对各字段的长度。';render();return;}
  if(input.harvestDate && (!/^\d{4}-\d{2}-\d{2}$/.test(input.harvestDate)||Number.isNaN(Date.parse(`${input.harvestDate}T00:00:00Z`))||new Date(`${input.harvestDate}T00:00:00Z`).toISOString().slice(0,10)!==input.harvestDate)) {e.error='请输入有效的采收日期，或留空。';render();return;}
  if(e.base.configured&&(input.batchCode!==e.base.batchCode||input.harvestDate!==e.base.harvestDate)&&!window.confirm('确定更换当前采收批次吗？旧批次订单取消后不会自动加到新库存，需要另行核对。'))return;
  const scope=operationScope();state.busy=true;e.error='';render();
  try {
    const item=await saveInventory(e.productId,input,{expectedVersion:e.expectedVersion});
    if(!scopeValid(scope)||state.inventoryEditor!==e)return;
    state.inventories=[...state.inventories.filter(value=>value.productId!==item.productId),item];delete state.errors.inventory;
    state.inventoryEditor=null;toast('库存与批次已保存到云端');
  } catch(error) {
    if(!scopeValid(scope)||state.inventoryEditor!==e)return;
    if(lostAccess(error)){clearPrivateState();state.ready=false;renderGate(textError(error));return;}
    e.conflict=error.status===409&&(!error.code||error.code==='version_conflict');e.error=e.conflict?'库存版本已变化，请保留需要的填写内容后重新读取。':`保存未完成：${textError(error)}`;
  } finally {state.busy=false;if(scopeValid(scope))render();}
}
async function reloadInventoryEditor() {
  const e=state.inventoryEditor;if(!isCloudMode()||!can('products')||!e||state.busy||!window.confirm('重新读取将放弃尚未保存的库存与批次资料，确定继续吗？'))return;
  const scope=operationScope();state.busy=true;
  try {await refreshInventories(scope);if(scopeValid(scope)&&state.inventoryEditor===e)state.inventoryEditor=inventoryEditorFrom(e.productId);}
  catch(error){if(scopeValid(scope)){if(lostAccess(error)){clearPrivateState();state.ready=false;renderGate(textError(error));}else e.error=textError(error);}}
  finally {state.busy=false;if(scopeValid(scope))render();}
}
function inventorySnapshot(value) {
  if(!value?.configured)return '尚未设置库存';
  return `规格一 ${value.stocks?.small ?? 0} 份 · 规格二 ${value.stocks?.family ?? 0} 份 · ${value.batchCode || '未填写批次'}${value.harvestDate?` · ${value.harvestDate}`:''}`;
}
function inventoryHistoryPage() {
  const history=state.inventoryHistory;
  return `<div class="editor-heading"><button type="button" class="text-button back-button" data-action="back-inventory">${icon('back',16)} 返回库存列表</button></div>${sectionIntro('STOCK ACTIVITY',`${history.name} · 库存记录`,'最近 50 条调整、下单扣减与取消回补记录；换批次的取消需要人工核对。', `<button type="button" class="secondary" data-action="inventory-history" data-id="${esc(history.productId)}">刷新记录</button>`)}<section class="panel merchant-audit inventory-history">${history.error?`<p class="field-error" role="alert">${esc(history.error)}</p><button type="button" class="secondary" data-action="inventory-history" data-id="${esc(history.productId)}">重新读取</button>`:history.events===null?'<p class="initial-state">正在读取库存记录…</p>':history.events.length?`<ol>${history.events.map(event=>`<li class="${event.action==='release_review'?'inventory-review':''}"><div><strong>${esc(({adjusted:'人工调整库存',reserved:'模拟下单扣减',released:'取消订单回补',release_review:'旧批次取消 · 待核对'})[event.action]||event.action)}</strong><time>${esc(dateText(event.createdAt))}</time></div><small>操作人：${esc(event.actorName||'系统')}${event.orderId?` · 订单 ${esc(event.orderId)}`:''}</small><p>${esc(event.reason||'')}</p><p><b>变更前</b>${esc(inventorySnapshot(event.before))}</p><p><b>变更后</b>${esc(inventorySnapshot(event.after))}</p>${event.action==='release_review'?'<p class="inventory-review-note">没有自动增加新批次库存。请核对原批次余量，确认后在库存页人工调整并填写原因。</p>':''}</li>`).join('')}</ol>`:empty('暂无库存记录','首次保存库存后，调整与模拟订单的库存变动会显示在这里。')}</section>`;
}
async function openInventoryHistory(productId) {
  if(!isCloudMode()||!can('products')||!state.products.some(item=>item.id===productId)||!mayLeaveEditor())return;
  const history={productId,name:state.products.find(item=>item.id===productId).name,events:null,error:''},scope=operationScope();
  state.view='inventory';state.inventoryHistory=history;render();
  try {const events=await loadInventoryHistory(productId);if(scopeValid(scope)&&state.inventoryHistory===history)history.events=events;}
  catch(error){if(scopeValid(scope)&&state.inventoryHistory===history){if(lostAccess(error)){clearPrivateState();state.ready=false;renderGate(textError(error));return;}history.error=textError(error);}}
  if(scopeValid(scope))render();
}
const permissionNames = { products: '商品与素材', orders: '订单与模拟发货', aftersales: '售后处理' };
const merchantStatusNames = { enabled: '已启用', disabled: '已停用' };
function permissionText(value) { return (Array.isArray(value) ? value : []).map(name => permissionNames[name] || name).join('、') || '未分配权限'; }
async function refreshMerchants(scope = operationScope()) {
  if (!isAdmin()) return;
  try {
    const data = await loadMerchants();
    if (!scopeValid(scope)) return;
    state.merchants = data.merchants; delete state.errors.merchants;
  } catch (error) { if (scopeValid(scope)) state.errors.merchants = `商家账号未同步：${textError(error)}`; throw error; }
}
function merchantsPage() {
  if (!isCloudMode()) return `${sectionIntro('MERCHANT ACCOUNTS', '商家账号', '为不同地区的采购者分配管理权限。')}<section class="panel permission-welcome"><h3>需要云端管理员登录</h3><p>当前为本机演示，不能创建真实商家账号。请连接云端并使用管理员账户登录后添加采购者。</p><p>添加的是平台业务档案，不会创建 ChatGPT 账号、设置密码或发送邀请邮件。</p></section>`;
  if (!isAdmin()) return '';
  if (state.merchantEditor) return merchantEditorPage();
  if (state.merchantAudit) return merchantAuditPage();
  const f = state.merchantFilter;
  const list = state.merchants.filter(item => (f.region === 'all' || item.region === f.region) && (f.status === 'all' || item.status === f.status) && (f.bound === 'all' || String(item.bound) === f.bound) && (!f.query || [item.name,item.email,item.region].join(' ').toLowerCase().includes(f.query.toLowerCase())));
  const regions = Object.fromEntries([...new Set(state.merchants.map(item => item.region))].map(value => [value,value]));
  return `${sectionIntro('MERCHANT ACCOUNTS', '让每个产地，都有人认真负责。', '管理员添加采购者业务档案，按工作内容分配权限；采购者只能管理归属自己的资料。', '<button class="primary" data-action="new-merchant">＋ 添加商家</button>')}
  <section class="merchant-explainer"><strong>如何开通采购者</strong><p>先添加商家使用的登录邮箱。采购者首次使用该邮箱的受信账户登录时，会绑定稳定账号 ID；绑定后不可更改邮箱。添加档案不会创建 ChatGPT 账号、密码或发送邮件。</p><p>真实采购者还需要获得站点访问许可；账号档案不会自动修改网站的分享范围。</p></section>
  <section class="panel"><form class="filter-bar" id="search-merchants"><label class="search-control">${icon('search',18)}<input name="query" value="${esc(f.query)}" placeholder="搜索商家、邮箱、地区" aria-label="搜索商家、邮箱、地区" maxlength="80"></label><label class="select-control"><span>地区</span><select data-filter="merchant" name="region">${options(regions,f.region,'全部地区')}</select></label><label class="select-control"><span>状态</span><select data-filter="merchant" name="status">${options(merchantStatusNames,f.status,'全部状态')}</select></label><label class="select-control"><span>绑定</span><select data-filter="merchant" name="bound">${options({true:'已绑定',false:'待首次登录'},f.bound,'全部绑定情况')}</select></label><button class="secondary" type="submit">搜索</button><button class="text-button" type="button" data-action="reset-merchant-filter">重置</button></form>
  <div class="table-caption">共 ${list.length} 位商家<span>最多管理 200 位 · 保存后在云端同步</span></div>${list.length ? `<div class="table-wrap"><table class="admin-table merchants-table"><thead><tr><th>商家与登录邮箱</th><th>地区</th><th>管理权限</th><th>状态 / 绑定</th><th>操作</th></tr></thead><tbody>${list.map(item => `<tr><td data-label="商家"><div class="merchant-identity"><strong>${esc(item.name)}</strong><small>${esc(item.email)}</small></div></td><td data-label="地区">${esc(item.region)}</td><td data-label="权限"><div class="merchant-permissions">${item.permissions.length ? item.permissions.map(name => badge(permissionNames[name] || name)).join(' ') : badge('未分配权限','warning')}</div></td><td data-label="状态"><div class="badge-stack">${badge(merchantStatusNames[item.status] || item.status,item.status === 'enabled' ? 'published' : 'offline')}${badge(item.bound ? '已绑定' : '待首次登录',item.bound ? '' : 'warning')}</div></td><td data-label="操作"><div class="row-actions"><button class="text-button" data-action="edit-merchant" data-id="${esc(item.id)}">编辑</button><button class="text-button" data-action="audit-merchant" data-id="${esc(item.id)}">操作记录</button></div></td></tr>`).join('')}</tbody></table></div>` : empty(state.errors.merchants ? '商家账号暂时无法读取' : '还没有符合条件的商家',state.errors.merchants ? '请重新读取云端后再继续。' : '可以添加景泰采购者，或先用模拟模板体验填写。')}</section>`;
}
function merchantEditorFrom(item = null) {
  return { isNew: !item, base: item ? clone(item) : null, expectedVersion: item?.version, dirty: false, conflict: false, error: '', values: { name: item?.name || '', email: item?.email || '', region: item?.region || '', status: item?.status || 'enabled', permissions: [...(item?.permissions || ['products','orders','aftersales'])] } };
}
function merchantEditorPage() {
  const e = state.merchantEditor, v = e.values;
  return `<div class="editor-heading"><button class="text-button back-button" data-action="back-merchants">${icon('back',16)} 返回商家列表</button><span>${e.dirty ? '有未保存的修改' : '点击保存才会写入云端'}</span></div><form id="merchant-form" class="merchant-editor"><section class="panel form-panel"><div class="form-section-heading"><span>01</span><div><h3>${e.isNew ? '添加商家业务档案' : '编辑商家业务档案'}</h3><p>不创建 ChatGPT 账户、不设置密码、不发送邮件。</p></div></div>${e.isNew ? '<div class="merchant-templates"><span>填入模拟资料</span><button type="button" class="secondary small" data-action="merchant-template" data-template="jingtai">景泰采购员</button><button type="button" class="secondary small" data-action="merchant-template" data-template="dingbian">定边采购员</button><small>模拟邮箱不能用于真实登录，后续请改为采购者的实际登录邮箱。</small></div>' : ''}<div class="form-grid">${field('商家 / 采购者名称','name',v.name,'required maxlength="80" autocomplete="off"')}${field('负责地区','region',v.region,'required maxlength="100" placeholder="例如：甘肃省白银市景泰县"')}${field('用于首次绑定的登录邮箱','email',v.email,`type="email" required maxlength="254" autocomplete="off" ${e.base?.bound ? 'readonly aria-readonly="true"' : ''}`)}<label class="field"><span>账号状态</span><select name="status">${Object.entries(merchantStatusNames).map(([value,label]) => `<option value="${value}" ${v.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div><p class="field-help">${e.base?.bound ? '该档案已绑定稳定账号 ID，邮箱不可修改。' : '尚未绑定时可以更正邮箱。首次以该邮箱的受信账户登录后绑定稳定账号 ID。'}采购者还需单独获得站点访问许可。</p></section>
  <section class="panel form-panel"><div class="form-section-heading"><span>02</span><div><h3>按工作内容分配权限</h3><p>每项权限均只适用于该商家自己的商品与订单；未勾选的内容不会开放。</p></div></div><div class="permission-options">${Object.entries(permissionNames).map(([name,label]) => `<label><input type="checkbox" name="permission-${name}" ${v.permissions.includes(name) ? 'checked' : ''}><span><strong>${label}</strong><small>${({products:'上架、改价、更换商品图片与视频',orders:'查看自己的订单，备注与模拟发货',aftersales:'只查看有售后的订单，处理模拟退款或补发'})[name]}</small></span></label>`).join('')}</div><p class="form-warning">停用后将禁止该采购者进入后台，并停止其商品的新购买；历史订单仍保留，由管理员继续查看和处理。未分配任何权限也无法进入后台。</p></section>
  <section class="panel merchant-save-panel">${e.conflict ? '<div class="drawer-sync-note changed"><p>该商家档案已在其他设备更新，当前填写内容已保留。请先复制需要的内容，再放弃当前填写并重新读取。</p><button type="button" class="text-button" data-action="reload-merchant">放弃当前填写并重新读取</button></div>' : ''}<div class="field-error" id="merchant-form-error" role="alert">${esc(e.error)}</div><button type="submit" class="primary" ${state.busy || e.conflict ? 'disabled' : ''}>${state.busy ? '正在保存…' : e.isNew ? '保存商家档案' : '保存修改'}</button><button type="button" class="text-button" data-action="back-merchants">返回列表</button><small>仅保存模拟业务档案，不接入支付。</small></section></form>`;
}
function syncMerchantEditor(form) {
  const e = state.merchantEditor;
  if (!e || !form) return;
  const data = new FormData(form);
  for (const name of ['name','region','status']) if (data.has(name)) e.values[name] = String(data.get(name));
  if (!e.base?.bound && data.has('email')) e.values.email = String(data.get('email'));
  e.values.permissions = Object.keys(permissionNames).filter(name => data.has(`permission-${name}`));
}
function fillMerchantTemplate(name) {
  const e = state.merchantEditor;
  if (!e?.isNew || !isAdmin()) return;
  const templates = { jingtai: {name:'景泰采购员',region:'甘肃省白银市景泰县',email:'jingtai-buyer@example.test'}, dingbian: {name:'定边采购员',region:'陕西省榆林市定边县',email:'dingbian-buyer@example.test'} };
  if (!templates[name]) return;
  e.values = { ...e.values, ...templates[name] }; e.dirty = true; render();
}
async function saveMerchantForm(form) {
  const e = state.merchantEditor;
  if (!isAdmin() || !e || state.busy || e.conflict) return;
  syncMerchantEditor(form);
  if (e.values.status === 'disabled' && e.base?.status !== 'disabled' && !window.confirm('确定停用这个商家吗？停用后将禁止进入后台，并停止其商品的新购买。历史订单仍会保留，由管理员继续查看和处理。')) return;
  const scope = operationScope(); state.busy = true; e.error = ''; render();
  try {
    const merchant = await saveMerchant({ ...e.values, name:e.values.name.trim(),region:e.values.region.trim(),email:e.values.email.trim() }, {id:e.base?.id || '',expectedVersion:e.expectedVersion});
    if (!scopeValid(scope) || state.merchantEditor !== e) return;
    state.merchants = e.isNew ? [...state.merchants,merchant] : state.merchants.map(item => item.id === merchant.id ? merchant : item);
    state.merchantEditor = null; toast('商家档案已保存到云端');
  } catch (error) {
    if (!scopeValid(scope)) return;
    if (lostAccess(error)) { clearPrivateState(); state.ready = false; renderGate(textError(error)); return; }
    e.conflict = !e.isNew && error.status === 409 && (!error.code || error.code === 'version_conflict'); e.error = e.conflict ? '商家档案版本发生变化。填写内容已保留，请重新读取后再保存。' : `保存未完成：${textError(error)}`;
  } finally { state.busy = false; if (scopeValid(scope)) render(); }
}
async function reloadMerchantEditor() {
  const e = state.merchantEditor;
  if (!isAdmin() || !e?.base || state.busy || !window.confirm('重新读取将放弃尚未保存的商家资料，确定继续吗？')) return;
  const scope = operationScope(); state.busy = true;
  try { const item = await loadMerchant(e.base.id); if (scopeValid(scope) && state.merchantEditor === e) state.merchantEditor = merchantEditorFrom(item); }
  catch (error) { if (scopeValid(scope)) { if (lostAccess(error)) { clearPrivateState(); state.ready=false; renderGate(textError(error)); } else e.error=textError(error); } }
  finally { state.busy=false; if (scopeValid(scope)) render(); }
}
function auditSnapshot(value) {
  if (!value) return '无（新建前）';
  return `${value.name || ''} · ${value.region || ''} · ${value.email || ''} · ${merchantStatusNames[value.status] || value.status || ''} · ${permissionText(value.permissions)}${value.version ? ` · 版本 ${value.version}` : ''}`;
}
function merchantAuditPage() {
  const audit = state.merchantAudit;
  return `<div class="editor-heading"><button class="text-button back-button" data-action="back-merchants">${icon('back',16)} 返回商家列表</button></div>${sectionIntro('ACCOUNT ACTIVITY',`${audit.name} · 操作记录`,'记录管理员对商家档案与权限的修改。')}<section class="panel merchant-audit">${audit.error ? `<p class="field-error" role="alert">${esc(audit.error)}</p><button class="secondary" data-action="audit-merchant" data-id="${esc(audit.id)}">重新读取记录</button>` : audit.events === null ? '<p class="initial-state">正在读取操作记录…</p>' : audit.events.length ? `<ol>${audit.events.map(event => `<li><div><strong>${esc(({created:'添加商家',updated:'修改商家',bound:'首次登录绑定',create:'添加商家',update:'修改商家',bind:'首次登录绑定'})[event.action] || event.action)}</strong><time>${esc(dateText(event.createdAt))}</time></div><small>操作人：${esc(event.actorName || '管理员')}</small><p><b>修改前</b>${esc(auditSnapshot(event.before))}</p><p><b>修改后</b>${esc(auditSnapshot(event.after))}</p></li>`).join('')}</ol>` : empty('暂无操作记录','该商家的后续档案修改会显示在这里。')}</section>`;
}
async function openMerchantAudit(id) {
  if (!isAdmin() || !mayLeaveEditor()) return;
  const merchant = state.merchants.find(item => item.id === id);
  if (!merchant) return;
  const audit = {id,name:merchant.name,events:null,error:''}, scope = operationScope();
  state.view='merchants'; state.merchantAudit=audit; render();
  try { const events = await loadMerchantAudit(id); if (scopeValid(scope) && state.merchantAudit === audit) audit.events=events; }
  catch (error) { if (scopeValid(scope) && state.merchantAudit === audit) { if (lostAccess(error)) { clearPrivateState(); state.ready=false; renderGate(textError(error)); } else audit.error=textError(error); } }
  if (scopeValid(scope) && state.merchantAudit === audit) render();
}
function searchToolbar(kind, placeholder, extra = '') {
  const filter = state[`${kind}Filter`];
  return `<form class="filter-bar" id="search-${kind}"><label class="search-control">${icon('search', 18)}<input name="query" value="${esc(filter.query)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" maxlength="80"></label>${extra}<button class="secondary" type="submit">搜索</button><button class="text-button" type="button" data-action="reset-filter" data-kind="${kind}">重置</button></form>`;
}
function options(values, current, allLabel) {
  return `<option value="all">${esc(allLabel)}</option>${Object.entries(values).map(([id,label]) => `<option value="${esc(id)}" ${current === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}`;
}
function productsPage() {
  const f = state.productsFilter;
  const list = state.products.filter(p => (f.category === 'all' || f.category === p.category) && (f.status === 'all' || f.status === (p.status || 'published')) && (!f.query || [p.name,p.origin,p.subtitle].join(' ').toLowerCase().includes(f.query.toLowerCase())));
  return `${sectionIntro('PRODUCTS', '把家乡好物摆上货架', isCloudMode() ? '先完善商品信息，再到库存批次设置可售余量；未设库存不能下单。' : '编辑商品信息与规格，保存后可到买家页面查看。', '<button class="primary" data-action="new-product">＋ 新增商品</button>')}
  <section class="panel">${searchToolbar('products', '搜索商品名称、产地', `<label class="select-control"><span>分类</span><select data-filter="products" name="category" aria-label="商品分类">${options(categoryNames, f.category, '全部分类')}</select></label><label class="select-control"><span>状态</span><select data-filter="products" name="status" aria-label="商品状态">${options(productStatuses, f.status, '全部状态')}</select></label>`)}
  ${isCloudMode() && !state.products.length && getCloudState().session?.role === 'admin' ? '<div class="cloud-seed"><p>云端目录尚为空，可初始化六款模拟商品；不会覆盖已有记录。</p><button class="secondary" data-action="seed-cloud">初始化示例商品</button></div>' : ''}<div class="table-caption">共 ${list.length} 款商品<span>${isCloudMode() ? '商品状态同步到云端买家目录。' : '上架、下架均只影响本浏览器的买家演示。'}</span></div>${list.length ? `<div class="table-wrap"><table class="admin-table products-table"><thead><tr><th>商品</th><th>分类</th><th>规格价格</th><th>状态</th><th>操作</th></tr></thead><tbody>${list.map(p => `<tr><td data-label="商品"><div class="table-product"><img src="${esc(imageFor(p))}" alt="${esc(p.name)}" data-fallback="${esc(p.image)}"><div><strong>${esc(p.name)}</strong><small>${esc(p.origin)}</small><em>${p.imageMediaId ? (isCloudMode() ? '云端图片' : '本机图片') : '内置图片'}${p.video || p.videoMediaId ? ' · 含视频' : ''}</em></div></div></td><td data-label="分类">${esc(categoryNames[p.category] || p.category)}</td><td data-label="规格价格"><div class="variant-price">${p.variants.map(v => `<span>${esc(v.label)} <b>¥${money(v.price)}</b></span>`).join('')}</div></td><td data-label="状态">${badge(productStatuses[p.status || 'published'], p.status || 'published')}</td><td data-label="操作"><div class="row-actions"><button class="text-button" data-action="edit-product" data-id="${esc(p.id)}">编辑</button>${isCloudMode()?`<button class="text-button" data-action="edit-inventory" data-id="${esc(p.id)}">库存</button>`:''}<button class="text-button ${p.status === 'published' || !p.status ? 'muted-action' : ''}" data-action="toggle-product" data-id="${esc(p.id)}" data-status="${p.status === 'published' || !p.status ? 'offline' : 'published'}">${p.status === 'published' || !p.status ? '下架' : '上架'}</button></div></td></tr>`).join('')}</tbody></table></div>` : empty('没有找到商品', '试试更换关键词或筛选条件，也可以新增一款商品。')}</section>`;
}
function editorFrom(product, isNew = false) {
  const base = clone(product);
  return { base, isNew, expectedVersion: isNew ? 0 : getProductVersion(base.id), dirty: false, values: { name: base.name, category: base.category, origin: base.origin, subtitle: base.subtitle, summary: base.summary, storage: base.storage, videoTitle: base.videoTitle || '苹果采摘过程', videoNote: base.videoNote || '演示素材，非产地证明', mediaSource: '自行拍摄的模拟素材', smallLabel: base.variants[0]?.label || '尝鲜装', smallWeight: base.variants[0]?.weight || '', smallPrice: money(base.variants[0]?.price || 0), familyLabel: base.variants[1]?.label || '家庭装', familyWeight: base.variants[1]?.weight || '', familyPrice: money(base.variants[1]?.price || 0) }, error: '', mediaErrors: {}, pending: { image: false, video: false }, sequences: { image: 0, video: 0 }, imagePreview: imageFor(base), videoPreview: videoFor(base) };
}
function field(label, name, value, attributes = '') {
  return `<label class="field"><span>${esc(label)}</span><input name="${name}" value="${esc(value || '')}" ${attributes}></label>`;
}
function textarea(label, name, value, maxlength = 1000) {
  return `<label class="field"><span>${esc(label)}</span><textarea name="${name}" rows="3" maxlength="${maxlength}">${esc(value || '')}</textarea></label>`;
}
function productEditor() {
  const e = state.editor, v = e.values;
  const mediaIssue = mediaErrorFor(e.base);
  return `<div class="editor-heading"><button class="text-button back-button" data-action="back-products">${icon('back', 16)} 返回商品列表</button><span>${e.dirty ? '有未保存的修改' : '填写后保存才会更新买家页面'}</span></div>
  <form id="product-form" class="product-editor"><div class="editor-main"><section class="panel form-panel"><div class="form-section-heading"><span>01</span><div><h3>商品基本信息</h3><p>清楚的名称、产地与介绍，让顾客更容易做选择。</p></div></div><div class="form-grid">${field('商品名称', 'name', v.name, 'required maxlength="40" autocomplete="off"')}<label class="field"><span>商品分类</span><select name="category">${Object.entries(categoryNames).map(([id,label]) => `<option value="${id}" ${v.category === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${field('产地说明', 'origin', v.origin, 'maxlength="100"')}${field('商品副标题', 'subtitle', v.subtitle, 'maxlength="120"')}<div class="full-width">${textarea('商品简介', 'summary', v.summary, 1000)}</div><div class="full-width">${textarea('储存与食用说明', 'storage', v.storage, 1000)}</div></div></section>
  <section class="panel form-panel"><div class="form-section-heading"><span>02</span><div><h3>两种规格与价格</h3><p>价格单位为元，最多两位小数。规格和净重请写清楚。</p></div></div><div class="variant-edit-grid">${[['small','规格一'],['family','规格二']].map(([key,label]) => `<fieldset class="variant-fieldset"><legend>${label}</legend>${field('规格名称', `${key}Label`, v[`${key}Label`], 'required maxlength="40"')}${field('重量或数量', `${key}Weight`, v[`${key}Weight`], 'required maxlength="60"')}${field('销售价格 元', `${key}Price`, v[`${key}Price`], 'required inputmode="decimal" autocomplete="off" placeholder="例如 29.90"')}</fieldset>`).join('')}</div></section>
  <section class="panel form-panel"><div class="form-section-heading"><span>03</span><div><h3>商品图片与介绍视频</h3><p>可选内置素材，也可选择真实本地文件。${isCloudMode() ? '文件将上传云端素材库；保存商品后才会绑定到买家页面。' : '文件只保存在本浏览器，不会上传服务器；保存商品后才会在买家端生效。'}</p></div></div>${textarea('素材来源与授权说明（选择文件时随素材保存）', 'mediaSource', v.mediaSource, 500)}<p class="field-help">上传前请填写实际来源。替换文件时可修改说明；请勿上传无权使用或含个人隐私的内容。</p>${mediaIssue ? `<p class="form-warning">${esc(mediaIssue)}</p>` : ''}<div class="media-editor"><div class="media-image-block"><div class="preview-image"><img src="${esc(e.imagePreview || e.base.image || 'assets/apples.jpg')}" alt="当前商品图片预览" data-fallback="${esc(e.base.image || 'assets/orchard.jpg')}"><span>${e.base.imageMediaId ? (isCloudMode() ? '云端图片预览' : '本机图片预览') : '内置素材预览'}</span></div><div class="media-label"><h4>商品图片</h4><label class="upload-button">${e.pending.image ? '正在验证图片…' : '选择本地图片'}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-media="image" aria-label="选择本地商品图片"></label></div><p class="field-help">JPG、PNG、WebP、GIF，最大 5MB。</p>${e.mediaErrors.image ? `<p class="field-error" role="alert">${esc(e.mediaErrors.image)}</p>` : ''}<div class="preset-images" aria-label="内置商品图片">${imagePresets.map(([src,label]) => `<button type="button" class="${!e.base.imageMediaId && e.base.image === src ? 'selected' : ''}" data-action="preset-image" data-image="${src}" aria-label="选择${label}内置图片"><img src="${src}" alt=""><span>${label}</span></button>`).join('')}</div></div>
  <div class="media-video-block"><div class="media-label"><h4>介绍视频</h4><label class="upload-button">${e.pending.video ? '正在验证视频…' : '选择本地视频'}<input type="file" accept="video/mp4,video/webm" data-media="video" aria-label="选择本地商品介绍视频"></label></div><p class="field-help">MP4、WebM，最大 30MB。建议先压缩成适合手机播放的短视频。</p><div class="video-preset-row"><button type="button" class="text-button" data-action="clear-video">不使用视频</button></div>${e.mediaErrors.video ? `<p class="field-error" role="alert">${esc(e.mediaErrors.video)}</p>` : ''}<div class="video-preview">${e.videoPreview ? `<video src="${esc(e.videoPreview)}" controls playsinline preload="metadata" aria-label="当前介绍视频预览"></video>` : '<div class="no-video">暂未选择视频</div>'}</div>${field('视频标题', 'videoTitle', v.videoTitle, 'maxlength="100"')}${textarea('视频说明', 'videoNote', v.videoNote, 300)}</div></div></section></div>
  <aside class="editor-aside"><section class="panel save-panel"><span class="eyebrow">保存并预览</span><h3>${e.isNew ? '让一款好物亮相' : '更新这份商品信息'}</h3><p>${isCloudMode()?'草稿不进入在售列表；上架后还需在库存批次设置可售余量，买家才能模拟下单。':'草稿不进入在售列表，暂不可选购；上架后买家页面可选购。'}演示素材需与实际商品描述区分。</p><div class="save-status">当前状态 ${badge(productStatuses[e.base.status || 'draft'], e.base.status || 'draft')}</div><div id="product-form-error" class="field-error" role="alert">${esc(e.error)}</div><button type="submit" class="primary wide" name="saveMode" value="published" ${e.pending.image || e.pending.video || state.busy ? 'disabled' : ''}>保存并上架</button><button type="submit" class="secondary wide" name="saveMode" value="draft" ${e.pending.image || e.pending.video || state.busy ? 'disabled' : ''}>保存草稿</button><button type="button" class="text-button wide" data-action="back-products">返回列表</button><small>选择文件后的预览不是商品保存结果，请完成上面的保存。</small></section></aside></form>`;
}
function matchesOrder(order, filter) {
  const searchable = [order.id, ...orderItems(order).map(item => item.product)].join(' ').toLowerCase();
  return (!filter.query || searchable.includes(filter.query.toLowerCase())) && (filter.status === 'all' || orderStatus(order) === filter.status);
}
function orderTable(orders) {
  if (!orders.length) return `${empty(state.errors.orders ? '订单暂时无法读取' : '暂时没有订单', state.errors.orders ? '请点击上方重新读取，确认成功后再处理订单。' : isCloudMode() ? '去买家页面模拟下单，再回到这里刷新处理。不会自动导入本机示例订单。' : '在买家页面生成演示订单后，可回到这里处理。')}${isCloudMode() && !state.errors.orders ? '<a class="cloud-order-link" href="./#/home" target="_blank" rel="noopener">去买家页面模拟下单 ↗</a>' : ''}`;
  return `<div class="table-wrap"><table class="admin-table orders-table"><thead><tr><th>订单与商品</th><th>订单金额</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${orders.map(order => `<tr><td data-label="订单"><div class="order-cell"><button class="order-id" data-action="open-order" data-id="${esc(order.id)}">${esc(order.id)}</button><p>${esc(orderItems(order).map(item => `${item.product} ×${item.quantity}`).join('、'))}</p>${isSample(order) ? '<small>后台示例 · 无真实客户</small>' : '<small>买家端演示订单</small>'}</div></td><td data-label="订单金额"><strong class="table-money">¥${money(order.total)}</strong><small class="cell-note">含演示运费 ¥${money(order.shipping)}</small></td><td data-label="状态"><div class="badge-stack">${badge(orderStatusName(order), orderStatus(order))}${order.afterSale?.status === 'submitted' ? badge('售后待处理', 'warning') : ''}</div></td><td data-label="创建时间">${dateText(order.createdAt)}</td><td data-label="操作"><button class="text-button" data-action="open-order" data-id="${esc(order.id)}">查看详情 ${icon('arrow', 13)}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function ordersPage() {
  const f = state.ordersFilter;
  const list = state.orders.filter(order => matchesOrder(order, f)).sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return `${sectionIntro(isCloudMode() ? 'CLOUD DEMO ORDERS' : 'LOCAL DEMO ORDERS', isCloudMode() ? '云端模拟订单' : '本机模拟订单', isCloudMode() ? '买家下单、商家备注与模拟发货统一保存云端，刷新即可同步。' : '仅核对本浏览器的模拟订单、备注与发货记录。')}<section class="panel">${searchToolbar('orders', '搜索订单号或商品', `<label class="select-control"><span>状态</span><select data-filter="orders" name="status" aria-label="订单状态">${options({ waiting:'待发货', shipped:'已发货', cancelled:'已取消', refunded:'模拟退款完成' }, f.status, '全部状态')}</select></label>`)}<div class="table-caption">共 ${list.length} 笔订单<span>演示订单，不对应真实收款或客户。</span></div>${orderTable(list)}</section>`;
}
function aftersalesPage() {
  const f = state.aftersalesFilter;
  const list = state.orders.filter(order => order.afterSale && (f.status === 'all' || f.status === order.afterSale.status) && (!f.query || [order.id,order.afterSale.id,...orderItems(order).map(item => item.product)].join(' ').toLowerCase().includes(f.query.toLowerCase()))).sort((a,b) => Date.parse(b.afterSale.updatedAt) - Date.parse(a.afterSale.updatedAt));
  return `${sectionIntro(isCloudMode() ? 'CLOUD DEMO AFTER SALES' : 'LOCAL DEMO AFTER SALES', isCloudMode() ? '云端模拟售后' : '本机模拟售后', isCloudMode() ? '买家申请、撤回与商家处理意见保存云端，同一账号跨设备可查看进度。' : '看清本机模拟问题、核对整单金额，再留下处理意见。')}<section class="panel">${searchToolbar('aftersales', '搜索订单号、售后号或商品', `<label class="select-control"><span>状态</span><select data-filter="aftersales" name="status" aria-label="售后状态">${options(afterStatuses, f.status, '全部状态')}</select></label>`)}<div class="table-caption">共 ${list.length} 笔售后<span>模拟退款和补发均不会产生真实资金或物流操作。</span></div>${list.length ? `<div class="table-wrap"><table class="admin-table after-table"><thead><tr><th>售后申请</th><th>方式与原因</th><th>整单金额</th><th>状态</th><th>操作</th></tr></thead><tbody>${list.map(order => `<tr><td data-label="售后申请"><div class="order-cell"><button class="order-id" data-action="open-after" data-id="${esc(order.id)}">${esc(order.afterSale.id)}</button><p>${esc(order.product)}</p><small>${esc(order.id)}</small></div></td><td data-label="方式与原因"><div>${order.afterSale.type === 'refund' ? '整单模拟退款' : '整单模拟补发'}</div><small class="cell-note">${afterReasons[order.afterSale.reason]}</small></td><td data-label="整单金额"><strong class="table-money">¥${money(order.total)}</strong></td><td data-label="状态">${badge(afterStatuses[order.afterSale.status], order.afterSale.status)}</td><td data-label="操作"><button class="text-button" data-action="open-after" data-id="${esc(order.id)}">${order.afterSale.status === 'submitted' ? '去处理' : '查看记录'} ${icon('arrow', 13)}</button></td></tr>`).join('')}</tbody></table></div>` : empty(state.errors.orders ? '售后暂时无法读取' : '暂时没有售后记录', state.errors.orders ? '请重新读取云端订单，未确认成功时不要重复操作。' : '买家端提交演示售后后，会在这里显示。')}</section>`;
}
function itemList(order) {
  return `<div class="drawer-items">${orderItems(order).map(item => `<div class="drawer-item"><img src="${esc(imageFor(item))}" alt="${esc(item.product)}"><div><strong>${esc(item.product)}</strong><p>${esc(item.variantLabel)} · ${esc(item.weight)}</p><small>¥${money(item.unitPrice)} × ${item.quantity}</small>${item.batchCode?`<p class="order-batch-snapshot">下单批次 ${esc(item.batchCode)}${item.harvestDate?` · ${esc(item.harvestDate)}`:''}</p>`:''}</div><b>¥${money(item.subtotal)}</b></div>`).join('')}</div>`;
}
function bill(order) {
  return `<dl class="drawer-bill"><div><dt>商品金额</dt><dd>¥${money(order.subtotal)}</dd></div><div><dt>演示运费</dt><dd>¥${money(order.shipping)}</dd></div><div class="bill-total"><dt>整单合计</dt><dd>¥${money(order.total)}</dd></div></dl>`;
}
function renderDrawer() {
  if (state.drawer && !can(state.drawer.type === 'after' ? 'aftersales' : 'orders')) { state.drawer=null; drawerRoot.innerHTML=''; document.body.classList.remove('drawer-open'); return; }
  const d = state.drawer;
  document.body.classList.toggle('drawer-open', !!d);
  if (!d) { drawerRoot.innerHTML = ''; return; }
  // Preserve the exact read/version that the merchant opened, even when the list refreshes.
  const order = d.order;
  if (!order) { state.drawer = null; drawerRoot.innerHTML = ''; document.body.classList.remove('drawer-open'); return; }
  const address = ADDRESSES.find(item => item.id === order.address);
  const isAfter = d.type === 'after';
  drawerRoot.innerHTML = `<div class="drawer-overlay"><button class="drawer-backdrop" data-action="close-drawer" aria-label="关闭详情"></button><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1"><header class="drawer-heading"><div><span class="eyebrow">${isAfter ? 'AFTER SALES' : 'ORDER DETAIL'}</span><h2 id="drawer-title">${isAfter ? '售后处理详情' : '订单详情'}</h2></div><button class="icon-button" data-action="close-drawer" aria-label="关闭详情">${icon('close', 22)}</button></header><div class="drawer-body"><div id="drawer-sync-notice"></div><div class="detail-status"><div>${badge(isAfter ? afterStatuses[order.afterSale?.status] : orderStatusName(order), isAfter ? order.afterSale?.status : orderStatus(order))}<strong>${esc(isAfter ? order.afterSale?.id : order.id)}</strong></div><p>${isSample(order) ? '后台示例订单，无真实客户。' : isCloudMode() ? `买家端云订单 · 版本 ${d.expectedVersion} · 不对应真实资金与物流。` : '买家端生成的本浏览器演示订单。'}</p></div>${itemList(order)}${bill(order)}
    ${stockReleaseNotice(order)}${isAfter ? afterDetail(order, d) : `<section class="detail-section"><h3>示例收货信息</h3><div class="address-detail">${icon('pin', 20)}<div><strong>${esc(address?.person || '体验用户')} · ${esc(address?.label || '')}</strong><p>${esc(address?.address || '示例地址')}</p><small>仅示例地区，不含真实收件资料。</small></div></div></section><section class="detail-section"><h3>订单时间</h3><p class="detail-copy">创建于 ${dateText(order.createdAt)}</p>${isShipped(order) ? `<p class="detail-copy">模拟发货于 ${dateText(order.fulfillment.shippedAt)}</p><dl class="shipping-meta"><div><dt>演示物流</dt><dd>${esc(order.fulfillment.carrier)}</dd></div><div><dt>演示单号</dt><dd>${esc(order.fulfillment.tracking)}</dd></div></dl>` : ''}</section><section class="detail-section"><h3>商家备注</h3><form id="order-note-form"><label class="sr-only" for="merchant-note">商家备注，最多300字</label><textarea id="merchant-note" name="note" rows="3" maxlength="300" placeholder="写下需要留意的处理信息…">${esc(d.note)}</textarea><button class="secondary small" type="submit">保存备注</button></form></section>${order.afterSale && can('aftersales') ? `<button class="linked-after" data-action="open-after" data-id="${esc(order.id)}"><div><strong>${afterStatuses[order.afterSale.status]} · ${order.afterSale.type === 'refund' ? '模拟退款' : '模拟补发'}</strong><span>查看问题与处理记录</span></div>${icon('arrow', 17)}</button>` : ''}${isWaiting(order) ? `<section class="detail-section shipping-section"><h3>模拟发货</h3>${order.afterSale?.status === 'submitted' ? '<p class="form-warning">有待处理售后，请先处理或由买家撤回申请。</p>' : `<form id="ship-form"><div class="form-grid">${field('物流名称', 'carrier', d.carrier, 'required maxlength="40"')}${field('演示单号', 'tracking', d.tracking, 'required maxlength="80" placeholder="DEMO-开头的演示单号"')}</div><p class="field-help">仅保存演示物流记录，不会通知快递或生成真实运单。</p><button type="submit" class="primary wide">确认模拟发货</button></form>`}</section>` : ''}`}
    ${isAfter ? '' : afterHistory(order)}<div id="drawer-error" class="field-error" role="alert">${esc(d.error || '')}</div></div></section></div>`;
  renderDrawerNotice();
  drawerRoot.querySelectorAll('[type="submit"]').forEach(button => { button.disabled = state.busy || !!d.conflict; });
  wireMediaErrors(drawerRoot);
}
function renderDrawerNotice() {
  const d = state.drawer, node = document.querySelector('#drawer-sync-notice');
  if (!d || !node || !isCloudMode()) return;
  node.innerHTML = `<div class="drawer-sync-note ${d.externalChanged || d.conflict ? 'changed' : ''}"><p>${d.conflict ? '这笔订单已在其他设备更新，当前填写内容已保留。请先放弃当前填写并重新读取，再决定下一步。' : d.externalChanged ? '云端已有较新记录，当前详情和填写内容仍保留。重新读取会放弃本页尚未保存的内容。' : '当前为打开详情时的记录。发货、备注和售后保存时会校验版本，避免覆盖其他设备的操作。'}</p><button class="text-button" data-action="reload-order">${d.conflict || d.externalChanged ? '放弃当前填写并重新读取' : '重新读取订单详情'}</button></div>`;
}
function afterHistory(order) {
  const history = Array.isArray(order.afterSaleHistory) ? order.afterSaleHistory : [];
  if (!history.length) return '';
  return `<section class="detail-section after-history"><h3>售后历史记录</h3><ol>${history.map(after => `<li><div><strong>${esc(afterStatuses[after.status] || '售后更新')} · ${after.type === 'refund' ? '模拟退款' : '模拟补发'}</strong><time>${dateText(after.updatedAt || after.createdAt)}</time></div><small>${esc(after.id)}</small><p>${esc(after.merchantReply || after.description || (after.status === 'withdrawn' ? '买家已撤回申请。' : '该次售后状态已记录。'))}</p></li>`).join('')}</ol></section>`;
}
function afterDetail(order, d) {
  const after = order.afterSale;
  if (!after) return '';
  return `<section class="detail-section"><h3>申请内容</h3><dl class="after-facts"><div><dt>关联订单</dt><dd>${esc(order.id)}</dd></div><div><dt>申请方式</dt><dd>${after.type === 'refund' ? '整单模拟退款' : '整单模拟补发'}</dd></div><div><dt>申请原因</dt><dd>${afterReasons[after.reason]}</dd></div><div><dt>申请时间</dt><dd>${dateText(after.createdAt)}</dd></div><div><dt>演示凭证</dt><dd>${after.hasEvidence ? '买家标记有演示凭证，不代表上传了真实文件' : '未提供演示凭证'}</dd></div></dl><div class="customer-description">${esc(after.description || '未填写补充描述。')}</div></section><section class="detail-section"><h3>处理意见</h3>${after.status === 'submitted' && can('aftersales') ? `<form id="resolve-form"><label class="sr-only" for="after-reply">售后处理意见，最多300字</label><textarea id="after-reply" name="reply" rows="4" maxlength="300" required placeholder="说明已核对的问题，以及本次模拟处理结果。">${esc(d.reply)}</textarea><p class="field-help">${after.type === 'refund' ? `按整单金额 ¥${money(order.total)} 标记模拟退款完成，不实际退钱。` : '标记模拟补发完成，不生成真实物流或补发包裹。'}</p><button type="submit" class="primary wide">${after.type === 'refund' ? '确认模拟退款完成' : '确认模拟补发完成'}</button></form>` : `<div class="reply-record"><p>${esc(after.merchantReply || (after.status === 'withdrawn' ? '申请已由买家撤回，无需继续处理。' : '该演示售后已标记完成，未填写处理意见。'))}</p><small>更新于 ${dateText(after.updatedAt)}</small></div>`}</section>${afterHistory(order)}${can('orders') ? `<button class="text-button" data-action="open-order" data-id="${esc(order.id)}">${icon('back', 14)} 返回订单详情</button>` : ''}`;
}
function closeDrawer() {
  if (state.busy) return;
  state.drawer = null; renderDrawer(); lastFocused?.focus?.();
}
function openDrawer(type, id) {
  if (!verifyCurrentAccount() || !hasAccess() || !can(type === 'after' ? 'aftersales' : 'orders')) return;
  const order = state.orders.find(item => item.id === id);
  if (!order || (type === 'after' && !order.afterSale)) return;
  lastFocused = document.activeElement;
  state.drawer = { type, id, order: clone(order), expectedVersion: order.version, note: order.merchantNote || '', carrier: '演示物流', tracking: `DEMO-${Date.now().toString(36).toUpperCase()}`, reply: order.afterSale?.merchantReply || '', error: '', externalChanged: false, conflict: false };
  renderDrawer(); drawerRoot.querySelector('.drawer')?.focus();
}
function stockReleaseNotice(order) {
  if (!order.stockRelease?.status) return '';
  const review=order.stockRelease.status==='review';
  return `<section class="stock-release-note ${review?'review':''}"><strong>${review?'取消回补 · 需要核对旧批次':'取消回补记录'}</strong><p>${esc(order.stockRelease.message || (review?'旧批次库存未自动加到新批次，请在库存记录中核对。':'本次取消已完成库存回补。'))}</p></section>`;
}
function mayLeaveEditor() {
  if (state.inventoryEditor?.dirty && !window.confirm('库存修改尚未保存。确定离开并放弃这些修改吗？')) return false;
  state.inventoryEditor=null; state.inventoryHistory=null;
  if (state.merchantEditor?.dirty && !window.confirm('商家资料尚未保存。确定离开并放弃这些修改吗？')) return false;
  state.merchantEditor=null; state.merchantAudit=null;
  if (state.editor?.dirty && !window.confirm('商品修改尚未保存。确定离开并放弃这些修改吗？')) return false;
  state.editor = null; state.externalChanged = false; return true;
}
function changeView(view) {
  if (!hasAccess() || !viewNames[view] || !canView(view) || !mayLeaveEditor()) return;
  closeDrawer(); state.view = view; loadData(); render(); window.scrollTo({ top: 0 });
}
function syncEditor(form) {
  const data = new FormData(form);
  Object.keys(state.editor.values).forEach(key => { if (data.has(key)) state.editor.values[key] = String(data.get(key)); });
}
function markDirty() {
  if (!state.editor) return;
  state.editor.dirty = true;
  const label = document.querySelector('.editor-heading>span');
  if (label) label.textContent = '有未保存的修改';
}
async function chooseFile(input) {
  const e = state.editor, kind = input.dataset.media, file = input.files?.[0];
  if (!can('products') || !e || !file) return;
  const scope = operationScope();
  const sequence = ++e.sequences[kind]; e.pending[kind] = true; delete e.mediaErrors[kind]; markDirty();
  syncEditor(document.querySelector('#product-form')); render();
  try {
    if (!e.values.mediaSource.trim()) throw new Error('请先填写素材来源与授权说明');
    const saved = await saveMedia(file, kind, { source: e.values.mediaSource });
    if (!scopeValid(scope) || state.editor !== e || e.sequences[kind] !== sequence) return;
    e.base[`${kind}MediaId`] = saved.id; e[`${kind}Preview`] = saved.url;
    if (kind === 'video') {
      if (!e.values.videoTitle.trim() || e.values.videoTitle === '采收视频 · 待补充') e.values.videoTitle = isCloudMode() ? '上传视频 · 素材演示' : '本机上传视频';
      if (!e.values.videoNote.trim() || e.values.videoNote === '暂无视频，后续可选择上传模拟素材。') e.values.videoNote = isCloudMode() ? '上传素材，仅供演示，不作为实际产地或品质证明。' : '本机上传素材，仅供演示，不作为实际产地或品质证明。';
    }
  } catch (error) {
    if (!scopeValid(scope) || state.editor !== e || e.sequences[kind] !== sequence) return;
    e.mediaErrors[kind] = `素材没有替换：${textError(error)}`;
  } finally {
    if (scopeValid(scope) && state.editor === e && e.sequences[kind] === sequence) { e.pending[kind] = false; render(); }
  }
}
async function saveEditor(form, mode) {
  const e = state.editor;
  if (!can('products') || !e || e.pending.image || e.pending.video || state.busy) return;
  const scope = operationScope();
  syncEditor(form); const v = e.values; state.busy = true;
  const submitButtons = [...(form.querySelectorAll?.('[type=submit]') || [])];
  submitButtons.forEach(button => { button.disabled = true; button.dataset.originalLabel = button.textContent; button.textContent = '正在保存…'; });
  try {
    const input = { ...e.base, name: v.name.trim(), category: v.category, origin: v.origin.trim(), subtitle: v.subtitle.trim(), summary: v.summary.trim(), storage: v.storage.trim(), status: mode === 'draft' ? 'draft' : 'published', videoTitle: v.videoTitle.trim(), videoNote: v.videoNote.trim() || '演示素材，非产地证明' };
    input.variants = ['small','family'].map((key,index) => ({ ...(e.base.variants[index] || {}), id: key, label: v[`${key}Label`].trim(), weight: v[`${key}Weight`].trim(), price: parsePrice(v[`${key}Price`]) }));
    input.facts = (input.facts || []).map(row => {
      if (row[0] === '产地') return [row[0], input.origin];
      if (['规格', '净含量', '计量与包装'].includes(row[0])) return [row[0], input.variants.map(variant => variant.weight).join(' / ')];
      return row;
    });
    await saveProduct(input, { expectedVersion: e.expectedVersion });
    if (!scopeValid(scope) || state.editor !== e) return;
    state.editor = null; state.externalChanged = false; state.view = 'products'; loadData(); render();
    toast(mode === 'draft' ? '商品草稿已保存' : isCloudMode() ? '商品已保存并上架，请到库存批次核实可售余量' : '商品已保存并上架'); window.scrollTo({ top: 0 });
  } catch (error) {
    if (!scopeValid(scope) || state.editor !== e) return;
    if (lostAccess(error)) { clearPrivateState(); state.ready=false; renderGate(textError(error)); return; }
    e.error = error.status === 409 ? '商品已被其他人修改。你的内容已保留，请复制需要的内容，再点击“放弃当前修改并重新载入”。' : `保存未完成：${textError(error)}`;
    if (error.status === 409) { state.externalChanged = true; renderAlerts(); }
    const errorNode = document.querySelector('#product-form-error'); if (errorNode) errorNode.textContent = e.error;
    toast('保存失败，填写内容已保留');
  } finally { state.busy = false; submitButtons.forEach(button => { button.disabled = false; button.textContent = button.dataset.originalLabel; }); renderSyncStatus(); }
}
function mutateOrder(id, transform) {
  if (isCloudMode()) throw new Error('云端订单必须通过服务器保存。');
  readCatalog();
  const current = readOrders();
  const index = current.findIndex(order => order.id === id);
  if (index < 0) throw new Error('订单已不存在，请重新读取列表。');
  const result = transform(current[index]);
  const next = current.map((order,i) => i === index ? result : order);
  const checked = validOrders(next);
  if (checked.length !== next.length || !checked.some(order => order.id === id)) throw new Error('订单校验未通过，本次操作没有保存。');
  writeOrders(checked); state.orders = checked;
  if (state.drawer?.id === id) state.drawer.order = clone(checked.find(order => order.id === id));
  render();
}
function drawerError(error) {
  const message = error?.status === 409 ? '这笔订单已更新或状态发生变化，填写内容已保留。请先放弃当前填写并重新读取，核对最新状态后再操作。' : textError(error);
  if (state.drawer) {
    state.drawer.error = message;
    if (error?.status === 409) { state.drawer.conflict = true; renderDrawerNotice(); }
  }
  const node = document.querySelector('#drawer-error'); if (node) node.textContent = message;
  toast('操作未完成，请查看详情中的提示');
}
async function reloadDrawer() {
  const d = state.drawer;
  if (!d || !isCloudMode() || !can(d.type === 'after' ? 'aftersales' : 'orders') || state.busy || !window.confirm('重新读取将放弃当前详情中尚未保存的填写内容，确定继续吗？')) return;
  const scope = operationScope(); state.busy = true;
  try {
    const order = await loadCloudOrder(d.id, { manager: true });
    if (!scopeValid(scope) || state.drawer !== d) return;
    state.orders = state.orders.map(value => value.id === order.id ? order : value);
    state.drawer = { ...d, order: clone(order), expectedVersion: order.version, note: order.merchantNote || '', carrier: '演示物流', tracking: `DEMO-${Date.now().toString(36).toUpperCase()}`, reply: order.afterSale?.merchantReply || '', error: '', conflict: false, externalChanged: false };
    state.ordersSyncedAt = new Date().toISOString();
    toast('已重新读取云端订单详情');
  } catch (error) {
    if (!scopeValid(scope) || state.drawer !== d) return;
    if (lostAccess(error)) { clearPrivateState(); state.ready = false; renderGate(textError(error)); }
    else drawerError(error);
  } finally { state.busy = false; if (state.drawer) renderDrawer(); renderSyncStatus(); }
}
async function saveCloudOrderForm(form) {
  const d = state.drawer;
  if (!d || state.busy || !can(form.id === 'resolve-form' ? 'aftersales' : 'orders')) return;
  const scope = operationScope();
  if (d.conflict) { drawerError({ status: 409 }); return; }
  const data = new FormData(form);
  const actions = {
    'order-note-form': ['note', { note: String(data.get('note') || '') }, '商家备注已保存到云端'],
    'ship-form': ['ship', { carrier: String(data.get('carrier') || ''), tracking: String(data.get('tracking') || '') }, '模拟发货记录已保存到云端'],
    'resolve-form': ['aftersale/resolve', { reply: String(data.get('reply') || '') }, '售后已在云端标记模拟处理完成']
  };
  const action = actions[form.id]; if (!action) return;
  state.busy = true; d.error = '';
  const controls = [...drawerRoot.querySelectorAll('input,textarea,button')];
  const disabled = controls.map(node => node.disabled);
  controls.forEach(node => { node.disabled = true; });
  try {
    const order = await mutateCloudOrder(d.id, action[0], { expectedVersion: d.expectedVersion, ...action[1] }, { manager: true });
    if (!scopeValid(scope) || state.drawer !== d) return;
    state.orders = state.orders.map(value => value.id === order.id ? order : value);
    d.order = clone(order); d.expectedVersion = order.version; d.externalChanged = false; d.conflict = false;
    if (form.id === 'order-note-form') d.note = order.merchantNote || '';
    if (form.id === 'resolve-form') d.reply = order.afterSale?.merchantReply || '';
    state.ordersSyncedAt = new Date().toISOString(); delete state.errors.orders;
    toast(action[2]);
  } catch (error) {
    if (!scopeValid(scope) || state.drawer !== d) return;
    if (lostAccess(error)) { clearPrivateState(); state.ready = false; renderGate(textError(error)); }
    else drawerError(error);
  } finally {
    state.busy = false; controls.forEach((node, index) => { node.disabled = disabled[index]; });
    if (state.drawer === d) render();
    renderSyncStatus();
  }
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-view],[data-action]');
  if (!button || button.disabled) return;
  if (button.dataset.action === 'retry-auth') { await boot(true); return; }
  if (!verifyCurrentAccount() || !hasAccess()) { renderGate(); return; }
  if (button.dataset.action === 'refresh-cloud') { await refreshRemote({ manual: true }); return; }
  if (state.busy) return;
  if (button.dataset.view) { changeView(button.dataset.view); return; }
  const { action, id } = button.dataset;
  if (['new-product','edit-product','toggle-product','reload-editor','preset-image','clear-video','back-products'].includes(action) && !can('products')) return;
  if (['edit-inventory','inventory-template','reload-inventory','inventory-history','back-inventory'].includes(action) && (!can('products') || !isCloudMode())) return;
  if (action === 'edit-inventory') { openInventoryEditor(id); return; }
  if (action === 'inventory-template') { fillInventoryTemplate(); return; }
  if (action === 'reload-inventory') { await reloadInventoryEditor(); return; }
  if (action === 'inventory-history') { await openInventoryHistory(id); return; }
  if (action === 'back-inventory') { changeView('inventory'); return; }
  if (action === 'reset-inventory-filter') { state.inventoryFilter={query:'',status:'all'}; render(); return; }
  if (['new-merchant','edit-merchant','merchant-template','reload-merchant','audit-merchant'].includes(action) && !isAdmin()) return;
  if (action === 'new-merchant') { if (!mayLeaveEditor()) return; state.merchantEditor=merchantEditorFrom(); state.view='merchants'; render(); return; }
  if (action === 'edit-merchant') { if (!mayLeaveEditor()) return; const merchant=state.merchants.find(item => item.id === id); if (merchant) { state.merchantEditor=merchantEditorFrom(merchant); state.view='merchants'; render(); } return; }
  if (action === 'merchant-template') { fillMerchantTemplate(button.dataset.template); return; }
  if (action === 'back-merchants') { changeView('merchants'); return; }
  if (action === 'reload-merchant') { await reloadMerchantEditor(); return; }
  if (action === 'audit-merchant') { await openMerchantAudit(id); return; }
  if (action === 'reset-merchant-filter') { state.merchantFilter={query:'',region:'all',status:'all',bound:'all'}; render(); return; }
  if (action === 'new-product') {
    if (!mayLeaveEditor()) return;
    const product = newProductTemplate(`local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`);
    state.editor = editorFrom(product, true); state.view = 'products'; render(); window.scrollTo({ top: 0 });
  } else if (action === 'edit-product') {
    if (!mayLeaveEditor()) return;
    loadData(); const product = state.products.find(item => item.id === id);
    if (!product) { toast('这款商品已不存在'); return; }
    state.editor = editorFrom(product); state.view = 'products'; render(); window.scrollTo({ top: 0 });
  } else if (action === 'back-products') changeView('products');
  else if (action === 'toggle-product') {
    const scope = operationScope(); state.busy = true; button.disabled = true;
    try { readCatalog(); await setProductStatus(id, button.dataset.status, { expectedVersion: getProductVersion(id) }); if (!scopeValid(scope)) return; loadData(); render(); toast(button.dataset.status === 'published' ? '商品已上架' : '商品已下架'); }
    catch (error) { if (!scopeValid(scope)) return; if (lostAccess(error)) { clearPrivateState(); state.ready=false; renderGate(textError(error)); return; } state.errors.action = `商品状态没有保存：${textError(error)}`; renderAlerts(); }
    finally { state.busy = false; button.disabled = false; }
  } else if (action === 'reset-filter') {
    const f = state[`${button.dataset.kind}Filter`]; Object.keys(f).forEach(key => { f[key] = key === 'query' ? '' : 'all'; }); render();
  } else if (action === 'metric') {
    if (button.dataset.target === 'waiting') { state.ordersFilter.status = 'waiting'; changeView('orders'); }
    else if (button.dataset.target === 'pending') { state.aftersalesFilter.status = 'submitted'; changeView('aftersales'); }
    else changeView(button.dataset.target);
  } else if (action === 'open-order') openDrawer('order', id);
  else if (action === 'open-after') openDrawer('after', id);
  else if (action === 'close-drawer') closeDrawer();
  else if (action === 'reload-order') await reloadDrawer();
  else if (action === 'retry-data') {
    if (isCloudMode()) { await refreshRemote({ manual: true }); return; }
    loadData(); loadMedia().then(() => { if (!state.editor) render(); else renderAlerts(); });
    if (!state.editor) render(); else renderAlerts();
  } else if (action === 'seed-cloud') {
    if (!isAdmin()) return;
    try { await apiRequest('/api/v1/admin/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await refreshRemote({ manual: true }); toast('示例商品初始化完成，已有商品保持原样'); }
    catch (error) { state.errors.sync = textError(error); renderAlerts(); }
  } else if (action === 'reload-editor') {
    if (!state.editor || !window.confirm('重新载入将放弃当前未保存的内容，确定继续吗？')) return;
    const id = state.editor.base.id, scope=operationScope();
    try { await refreshCatalog({ admin: isCloudMode() }); if (!scopeValid(scope)) return; loadData(); await loadMedia(scope); if (!scopeValid(scope)) return; const latest = state.products.find(p => p.id === id); state.editor = latest ? editorFrom(latest) : null; state.externalChanged = false; render(); }
    catch (error) { state.errors.sync = textError(error); renderAlerts(); }
  } else if (action === 'dismiss-external') { state.externalChanged = false; renderAlerts(); }
  else if (action === 'preset-image' && state.editor) {
    syncEditor(document.querySelector('#product-form')); const e = state.editor;
    ++e.sequences.image; e.pending.image = false; e.base.imageMediaId = ''; delete e.mediaErrors.image;
    e.base.image = button.dataset.image; e.imagePreview = e.base.image; markDirty(); render();
  } else if (action === 'clear-video' && state.editor) {
    syncEditor(document.querySelector('#product-form')); const e = state.editor;
    ++e.sequences.video; e.pending.video = false; e.base.videoMediaId = ''; delete e.mediaErrors.video;
    e.base.video = ''; e.videoPreview = e.base.video;
    markDirty(); render();
  }
});
document.addEventListener('input', event => {
  const form = event.target.closest('form');
  if (form?.id === 'inventory-form' && state.inventoryEditor && can('products')) { syncInventoryEditor(form); state.inventoryEditor.dirty=true; }
  if (form?.id === 'merchant-form' && state.merchantEditor && isAdmin()) { syncMerchantEditor(form); state.merchantEditor.dirty=true; }
  if (form?.id === 'product-form' && state.editor && !event.target.matches('[data-media]')) {
    if (Object.hasOwn(state.editor.values, event.target.name)) state.editor.values[event.target.name] = event.target.value;
    markDirty();
  }
  if (state.drawer) {
    if (form?.id === 'order-note-form') state.drawer.note = event.target.value;
    if (form?.id === 'ship-form') state.drawer[event.target.name] = event.target.value;
    if (form?.id === 'resolve-form') state.drawer.reply = event.target.value;
  }
});
document.addEventListener('change', event => {
  const target = event.target;
  if (target.closest('#inventory-form') && state.inventoryEditor && can('products')) { syncInventoryEditor(target.closest('form')); state.inventoryEditor.dirty=true; }
  if (target.closest('#merchant-form') && state.merchantEditor && isAdmin()) { syncMerchantEditor(target.closest('form')); state.merchantEditor.dirty=true; }
  if (target.matches('[data-media]')) { chooseFile(target); return; }
  if (target.dataset.filter) {
    const kind = target.dataset.filter;
    if (!state[`${kind}Filter`]) return;
    const form = target.closest('form'); state[`${kind}Filter`].query = String(new FormData(form).get('query') || '').trim();
    state[`${kind}Filter`][target.name] = target.value; render();
  }
  if (target.closest('#product-form') && state.editor && Object.hasOwn(state.editor.values, target.name)) { state.editor.values[target.name] = target.value; markDirty(); }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); if (!verifyCurrentAccount() || !hasAccess()) { renderGate(); return; } if (state.busy) return; const form = event.target;
  if (form.id === 'inventory-form') { await saveInventoryForm(form); return; }
  if (form.id === 'merchant-form') { await saveMerchantForm(form); return; }
  if (form.id.startsWith('search-')) { const kind = form.id === 'search-merchants' ? 'merchant' : form.id.slice(7); if (!state[`${kind}Filter`]) return; state[`${kind}Filter`].query = String(new FormData(form).get('query') || '').trim(); render(); return; }
  if (form.id === 'product-form') { saveEditor(form, event.submitter?.value || 'published'); return; }
  if (!state.drawer) return;
  if (isCloudMode()) { await saveCloudOrderForm(form); return; }
  const d = state.drawer; const data = new FormData(form);
  try {
    d.error = '';
    if (form.id === 'order-note-form') { mutateOrder(d.id, order => saveOrderNote(order, String(data.get('note') || ''))); toast('商家备注已保存'); }
    if (form.id === 'ship-form') { mutateOrder(d.id, order => shipOrder(order, String(data.get('carrier') || ''), String(data.get('tracking') || ''))); toast('模拟发货记录已保存'); }
    if (form.id === 'resolve-form') { mutateOrder(d.id, order => resolveAfterSale(order, String(data.get('reply') || ''))); toast('售后已标记模拟处理完成'); }
  } catch (error) { drawerError(error); }
});
document.addEventListener('keydown', event => {
  if (!state.drawer) return;
  if (event.key === 'Escape') { event.preventDefault(); if (!state.busy) closeDrawer(); return; }
  if (event.key === 'Tab') {
    const focusable = [...drawerRoot.querySelectorAll('.drawer button:not([disabled]), .drawer input, .drawer select, .drawer textarea, .drawer a[href]')];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === drawerRoot.querySelector('.drawer'))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
window.addEventListener('beforeunload', event => { if (state.editor?.dirty || state.merchantEditor?.dirty || state.inventoryEditor?.dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('storage', async event => {
  if (!hasAccess() || ![CATALOG_KEY, STORAGE_KEY, null].includes(event.key)) return;
  if (isCloudMode()) return;
  loadData(); await loadMedia();
  if (state.editor) { state.externalChanged = true; renderAlerts(); }
  else if (!state.drawer) render();
});

window.addEventListener('focus', () => refreshRemote());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRemote(); });
setInterval(() => { if (!document.hidden) refreshRemote(); }, 30000);
boot();
