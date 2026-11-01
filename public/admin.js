import { CATALOG, getProduct, money, STORAGE_KEY, ADDRESSES, validOrders, orderItems, createOrder, createAfterSale, shipOrder, saveOrderNote, resolveAfterSale } from './model.js';
import { CATALOG_KEY, readCatalog, saveProduct, setProductStatus, newProductTemplate, parsePrice, refreshCatalog, getProductVersion } from './catalog-store.js';
import { hydrateMedia, imageFor, videoFor, saveMedia, mediaErrorFor } from './media-store.js';
import { initializeCloudMode, getCloudState, isCloudMode, apiRequest, authHref } from './cloud-client.js';
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
const viewNames = { overview: '经营概览', products: '商品管理', orders: '订单管理', aftersales: '售后管理' };
const imagePresets = [
  ['assets/apples.jpg', '苹果'], ['assets/goji.jpg', '枸杞'], ['assets/pear.jpg', '鲜梨'],
  ['assets/potato.jpg', '土豆'], ['assets/corn.jpg', '玉米'], ['assets/onion.jpg', '洋葱']
];
const state = {
  view: 'overview', products: [], orders: [], errors: {}, editor: null, drawer: null,
  productsFilter: { query: '', category: 'all', status: 'all' },
  ordersFilter: { query: '', status: 'all' }, aftersalesFilter: { query: '', status: 'all' },
  externalChanged: false, mediaIssues: [], busy: false, ready: false, syncing: false
};
let toastTimer;
let lastFocused;

const clone = value => JSON.parse(JSON.stringify(value));
const dateText = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const textError = error => error?.message || '操作未完成，请重试。';
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
function hasAccess() {
  const cloud = getCloudState();
  return state.ready && (cloud.mode === 'local' || (cloud.mode === 'cloud' && cloud.session?.user && cloud.session.canManage === true && !cloud.error));
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
  node.innerHTML = cloud.mode === 'local'
    ? '<span class="sync-dot local"></span><div><strong>本机演示模式</strong><small>商品与素材仅保存在当前浏览器</small></div>'
    : `<span class="sync-dot ${state.syncing ? 'pending' : state.errors.sync ? 'failed' : ''}"></span><div><strong>${state.syncing ? '正在读取云端商品…' : state.errors.sync ? '云端同步未完成' : '云端商品目录'}</strong><small>最近同步：${esc(time)}${session?.user ? ` · ${esc(session.user.name || session.user.email || '已登录')}` : ''}</small></div>${hasAccess() ? '<button class="text-button" data-action="refresh-cloud">刷新</button>' : ''}${session?.user && authHref(session.signOutUrl) ? `<a class="text-button" href="${esc(authHref(session.signOutUrl))}" target="_top">退出</a>` : ''}`;
  const note = document.querySelector('#workspace-mode-note');
  if (note) note.textContent = cloud.mode === 'local' ? '商品与素材保存在当前浏览器，不会同步服务器。订单与售后均为本机模拟。' : '商品与素材保存云端。订单与售后仍为本机模拟，暂未同步云端。';
  const notice = document.querySelector('#scope-notice');
  if (notice) notice.textContent = cloud.mode === 'local' ? '本机模拟数据，不会真实收款、退款或发货。' : '商品与素材云端同步；本机模拟订单／售后暂未同步云端，无真实支付或物流。';
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
  state.ready = false; renderGate();
  try {
    await initializeCloudMode({ force });
    state.ready = true;
    if (!hasAccess()) { renderGate(); return; }
    await refreshCatalog({ admin: isCloudMode() });
    loadData();
    if (!isCloudMode() && !state.errors.orders && !state.errors.catalog) seedSamples();
    await loadMedia(); render();
  } catch (error) { state.ready = false; state.errors.sync = textError(error); renderGate(textError(error)); }
}
async function refreshRemote({ manual = false } = {}) {
  if (!hasAccess() || !isCloudMode() || state.syncing || state.busy) return;
  if (!manual && (state.editor || state.drawer)) return;
  if (state.editor) syncEditor(document.querySelector('#product-form'));
  state.syncing = true; renderSyncStatus();
  try {
    await initializeCloudMode({ force: true });
    if (!hasAccess()) { renderGate(); return; }
    await refreshCatalog({ admin: true }); loadData(); await loadMedia(); delete state.errors.sync;
    if (state.editor) { state.externalChanged = true; renderAlerts(); }
    else if (!state.drawer) render();
    if (manual) toast(state.editor ? '已读取云端；当前填写内容保留，重新载入前不会覆盖。' : '云端商品已更新');
  } catch (error) { state.errors.sync = textError(error); if (!getCloudState().session?.canManage) renderGate(textError(error)); else renderAlerts(); }
  finally { state.syncing = false; renderSyncStatus(); }
}
function readOrders() {
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
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(orders)); }
  catch { throw new Error('订单保存失败。浏览器存储可能已满或被禁用，本次操作没有完成。'); }
}
function loadData() {
  if (!hasAccess()) return;
  try { readCatalog(); state.products = [...CATALOG]; delete state.errors.catalog; }
  catch (error) { state.products = [...CATALOG]; state.errors.catalog = textError(error); }
  try { state.orders = readOrders(); delete state.errors.orders; }
  catch (error) { state.errors.orders = textError(error); }
}
async function loadMedia() {
  try {
    state.mediaIssues = await hydrateMedia([...state.products, ...state.orders.flatMap(orderItems)]) || [];
    delete state.errors.media;
  } catch { state.errors.media = '本机素材暂时无法读取，已保留素材选择与其他数据。'; }
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
  nav.hidden = false; renderSyncStatus();
  const title = state.editor ? (state.editor.isNew ? '新增商品' : '编辑商品') : viewNames[state.view];
  document.querySelector('#view-title').textContent = title;
  document.title = `${title} · 陇上鲜集管理后台`;
  nav.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  renderAlerts();
  app.innerHTML = state.editor ? productEditor() : ({ overview, products: productsPage, orders: ordersPage, aftersales: aftersalesPage })[state.view]();
  wireMediaErrors(app); renderDrawer();
}
function sectionIntro(kicker, title, copy, action = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${esc(kicker)}</span><h2>${esc(title)}</h2><p>${esc(copy)}</p></div>${action}</div>`;
}
function overview() {
  const active = state.orders.filter(order => order.status !== 'cancelled');
  const waiting = active.filter(isWaiting).length;
  const pending = state.orders.filter(order => order.afterSale?.status === 'submitted').length;
  const total = active.filter(order => !isRefunded(order)).reduce((sum, order) => sum + order.total, 0);
  return `${sectionIntro('STORE AT A GLANCE', '把每一份好物，认真打理。', '从商品上架到订单服务，在这里看见店铺的每一步。', '<button class="primary" data-action="new-product">＋ 新增商品</button>')}
    <div class="metric-grid">
      ${[[state.products.filter(p => (p.status || 'published') === 'published').length, '在售商品', 'products', 'leaf'], [active.length, '有效演示订单', 'orders', 'orders'], [waiting, '待发货订单', 'waiting', 'truck'], [pending, '待处理售后', 'pending', 'chat']].map(([number, label, target, i]) => `<button class="metric-card" data-action="metric" data-target="${target}"><span>${esc(label)} ${icon(i, 20)}</span><strong>${number}<small>${target === 'products' ? '款' : '笔'}</small></strong><em>进入管理 ${icon('arrow', 13)}</em></button>`).join('')}
    </div>
    <p class="local-scope-note">订单与售后为本机模拟，暂未同步云端；下列金额不代表实际收入。</p><div class="overview-columns"><section class="panel"><div class="panel-heading"><div><h3>最近的订单</h3><p>示例订单与买家端生成的演示订单在这里联动。</p></div><button class="text-button" data-view="orders">查看全部 ${icon('arrow', 14)}</button></div>${orderTable([...state.orders].sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 5))}</section>
    <aside class="overview-side"><section class="money-card"><span class="eyebrow">模拟订单金额</span><strong>¥${money(total)}</strong><p>有效订单合计，含演示运费；不含已取消及模拟退款完成的订单，不代表真实收入。</p></section><section class="panel daily-note"><span class="eyebrow">今天可以先做</span><h3>让好物好买，<br>也让服务跟得上。</h3><ol><li>核对商品规格与素材</li><li>处理待发货的演示订单</li><li>为售后留下清楚的处理意见</li></ol><button class="secondary" data-view="aftersales">去看售后 ${icon('arrow', 14)}</button></section></aside></div>`;
}
function searchToolbar(kind, placeholder, extra = '') {
  const filter = state[`${kind}Filter`];
  return `<form class="filter-bar" id="search-${kind}"><label class="search-control">${icon('search', 18)}<input name="query" value="${esc(filter.query)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" maxlength="80"></label>${extra}<button class="secondary" type="submit">搜索</button><button class="text-button" type="button" data-action="reset-filter" data-kind="${kind}">重置</button></form>`;
}
function options(values, current, allLabel) {
  return `<option value="all">${esc(allLabel)}</option>${Object.entries(values).map(([id,label]) => `<option value="${id}" ${current === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}`;
}
function productsPage() {
  const f = state.productsFilter;
  const list = state.products.filter(p => (f.category === 'all' || f.category === p.category) && (f.status === 'all' || f.status === (p.status || 'published')) && (!f.query || [p.name,p.origin,p.subtitle].join(' ').toLowerCase().includes(f.query.toLowerCase())));
  return `${sectionIntro('PRODUCTS', '把家乡好物摆上货架', '编辑商品信息与规格，保存后可到买家页面查看。', '<button class="primary" data-action="new-product">＋ 新增商品</button>')}
  <section class="panel">${searchToolbar('products', '搜索商品名称、产地', `<label class="select-control"><span>分类</span><select data-filter="products" name="category" aria-label="商品分类">${options(categoryNames, f.category, '全部分类')}</select></label><label class="select-control"><span>状态</span><select data-filter="products" name="status" aria-label="商品状态">${options(productStatuses, f.status, '全部状态')}</select></label>`)}
  ${isCloudMode() && !state.products.length && getCloudState().session?.role === 'admin' ? '<div class="cloud-seed"><p>云端目录尚为空，可初始化六款模拟商品；不会覆盖已有记录。</p><button class="secondary" data-action="seed-cloud">初始化示例商品</button></div>' : ''}<div class="table-caption">共 ${list.length} 款商品<span>${isCloudMode() ? '商品状态同步到云端买家目录。' : '上架、下架均只影响本浏览器的买家演示。'}</span></div>${list.length ? `<div class="table-wrap"><table class="admin-table products-table"><thead><tr><th>商品</th><th>分类</th><th>规格价格</th><th>状态</th><th>操作</th></tr></thead><tbody>${list.map(p => `<tr><td data-label="商品"><div class="table-product"><img src="${esc(imageFor(p))}" alt="${esc(p.name)}" data-fallback="${esc(p.image)}"><div><strong>${esc(p.name)}</strong><small>${esc(p.origin)}</small><em>${p.imageMediaId ? (isCloudMode() ? '云端图片' : '本机图片') : '内置图片'}${p.video || p.videoMediaId ? ' · 含视频' : ''}</em></div></div></td><td data-label="分类">${esc(categoryNames[p.category] || p.category)}</td><td data-label="规格价格"><div class="variant-price">${p.variants.map(v => `<span>${esc(v.label)} <b>¥${money(v.price)}</b></span>`).join('')}</div></td><td data-label="状态">${badge(productStatuses[p.status || 'published'], p.status || 'published')}</td><td data-label="操作"><div class="row-actions"><button class="text-button" data-action="edit-product" data-id="${esc(p.id)}">编辑</button><button class="text-button ${p.status === 'published' || !p.status ? 'muted-action' : ''}" data-action="toggle-product" data-id="${esc(p.id)}" data-status="${p.status === 'published' || !p.status ? 'offline' : 'published'}">${p.status === 'published' || !p.status ? '下架' : '上架'}</button></div></td></tr>`).join('')}</tbody></table></div>` : empty('没有找到商品', '试试更换关键词或筛选条件，也可以新增一款商品。')}</section>`;
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
  <aside class="editor-aside"><section class="panel save-panel"><span class="eyebrow">保存并预览</span><h3>${e.isNew ? '让一款好物亮相' : '更新这份商品信息'}</h3><p>草稿不进入在售列表，暂不可选购；上架后买家页面可选购。演示素材需与实际商品描述区分。</p><div class="save-status">当前状态 ${badge(productStatuses[e.base.status || 'draft'], e.base.status || 'draft')}</div><div id="product-form-error" class="field-error" role="alert">${esc(e.error)}</div><button type="submit" class="primary wide" name="saveMode" value="published" ${e.pending.image || e.pending.video || state.busy ? 'disabled' : ''}>保存并上架</button><button type="submit" class="secondary wide" name="saveMode" value="draft" ${e.pending.image || e.pending.video || state.busy ? 'disabled' : ''}>保存草稿</button><button type="button" class="text-button wide" data-action="back-products">返回列表</button><small>选择文件后的预览不是商品保存结果，请完成上面的保存。</small></section></aside></form>`;
}
function matchesOrder(order, filter) {
  const searchable = [order.id, ...orderItems(order).map(item => item.product)].join(' ').toLowerCase();
  return (!filter.query || searchable.includes(filter.query.toLowerCase())) && (filter.status === 'all' || orderStatus(order) === filter.status);
}
function orderTable(orders) {
  if (!orders.length) return empty('暂时没有订单', '在买家页面生成演示订单后，可回到这里处理。');
  return `<div class="table-wrap"><table class="admin-table orders-table"><thead><tr><th>订单与商品</th><th>订单金额</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${orders.map(order => `<tr><td data-label="订单"><div class="order-cell"><button class="order-id" data-action="open-order" data-id="${esc(order.id)}">${esc(order.id)}</button><p>${esc(orderItems(order).map(item => `${item.product} ×${item.quantity}`).join('、'))}</p>${isSample(order) ? '<small>后台示例 · 无真实客户</small>' : '<small>买家端演示订单</small>'}</div></td><td data-label="订单金额"><strong class="table-money">¥${money(order.total)}</strong><small class="cell-note">含演示运费 ¥${money(order.shipping)}</small></td><td data-label="状态"><div class="badge-stack">${badge(orderStatusName(order), orderStatus(order))}${order.afterSale?.status === 'submitted' ? badge('售后待处理', 'warning') : ''}</div></td><td data-label="创建时间">${dateText(order.createdAt)}</td><td data-label="操作"><button class="text-button" data-action="open-order" data-id="${esc(order.id)}">查看详情 ${icon('arrow', 13)}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function ordersPage() {
  const f = state.ordersFilter;
  const list = state.orders.filter(order => matchesOrder(order, f)).sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return `${sectionIntro('LOCAL DEMO ORDERS', '本机模拟订单', '暂未同步云端。仅核对本浏览器的模拟订单、备注与发货记录。')}<section class="panel">${searchToolbar('orders', '搜索订单号或商品', `<label class="select-control"><span>状态</span><select data-filter="orders" name="status" aria-label="订单状态">${options({ waiting:'待发货', shipped:'已发货', cancelled:'已取消', refunded:'模拟退款完成' }, f.status, '全部状态')}</select></label>`)}<div class="table-caption">共 ${list.length} 笔订单<span>演示订单，不对应真实收款或客户。</span></div>${orderTable(list)}</section>`;
}
function aftersalesPage() {
  const f = state.aftersalesFilter;
  const list = state.orders.filter(order => order.afterSale && (f.status === 'all' || f.status === order.afterSale.status) && (!f.query || [order.id,order.afterSale.id,...orderItems(order).map(item => item.product)].join(' ').toLowerCase().includes(f.query.toLowerCase()))).sort((a,b) => Date.parse(b.afterSale.updatedAt) - Date.parse(a.afterSale.updatedAt));
  return `${sectionIntro('LOCAL DEMO AFTER SALES', '本机模拟售后', '暂未同步云端。看清本机模拟问题、核对整单金额，再留下处理意见。')}<section class="panel">${searchToolbar('aftersales', '搜索订单号、售后号或商品', `<label class="select-control"><span>状态</span><select data-filter="aftersales" name="status" aria-label="售后状态">${options(afterStatuses, f.status, '全部状态')}</select></label>`)}<div class="table-caption">共 ${list.length} 笔售后<span>模拟退款和补发均不会产生真实资金或物流操作。</span></div>${list.length ? `<div class="table-wrap"><table class="admin-table after-table"><thead><tr><th>售后申请</th><th>方式与原因</th><th>整单金额</th><th>状态</th><th>操作</th></tr></thead><tbody>${list.map(order => `<tr><td data-label="售后申请"><div class="order-cell"><button class="order-id" data-action="open-after" data-id="${esc(order.id)}">${esc(order.afterSale.id)}</button><p>${esc(order.product)}</p><small>${esc(order.id)}</small></div></td><td data-label="方式与原因"><div>${order.afterSale.type === 'refund' ? '整单模拟退款' : '整单模拟补发'}</div><small class="cell-note">${afterReasons[order.afterSale.reason]}</small></td><td data-label="整单金额"><strong class="table-money">¥${money(order.total)}</strong></td><td data-label="状态">${badge(afterStatuses[order.afterSale.status], order.afterSale.status)}</td><td data-label="操作"><button class="text-button" data-action="open-after" data-id="${esc(order.id)}">${order.afterSale.status === 'submitted' ? '去处理' : '查看记录'} ${icon('arrow', 13)}</button></td></tr>`).join('')}</tbody></table></div>` : empty('暂时没有售后记录', '买家端提交演示售后后，会在这里显示。')}</section>`;
}
function itemList(order) {
  return `<div class="drawer-items">${orderItems(order).map(item => `<div class="drawer-item"><img src="${esc(imageFor(item))}" alt="${esc(item.product)}"><div><strong>${esc(item.product)}</strong><p>${esc(item.variantLabel)} · ${esc(item.weight)}</p><small>¥${money(item.unitPrice)} × ${item.quantity}</small></div><b>¥${money(item.subtotal)}</b></div>`).join('')}</div>`;
}
function bill(order) {
  return `<dl class="drawer-bill"><div><dt>商品金额</dt><dd>¥${money(order.subtotal)}</dd></div><div><dt>演示运费</dt><dd>¥${money(order.shipping)}</dd></div><div class="bill-total"><dt>整单合计</dt><dd>¥${money(order.total)}</dd></div></dl>`;
}
function renderDrawer() {
  const d = state.drawer;
  document.body.classList.toggle('drawer-open', !!d);
  if (!d) { drawerRoot.innerHTML = ''; return; }
  const order = state.orders.find(item => item.id === d.id);
  if (!order) { state.drawer = null; drawerRoot.innerHTML = ''; document.body.classList.remove('drawer-open'); return; }
  const address = ADDRESSES.find(item => item.id === order.address);
  const isAfter = d.type === 'after';
  drawerRoot.innerHTML = `<div class="drawer-overlay"><button class="drawer-backdrop" data-action="close-drawer" aria-label="关闭详情"></button><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1"><header class="drawer-heading"><div><span class="eyebrow">${isAfter ? 'AFTER SALES' : 'ORDER DETAIL'}</span><h2 id="drawer-title">${isAfter ? '售后处理详情' : '订单详情'}</h2></div><button class="icon-button" data-action="close-drawer" aria-label="关闭详情">${icon('close', 22)}</button></header><div class="drawer-body"><div class="detail-status"><div>${badge(isAfter ? afterStatuses[order.afterSale?.status] : orderStatusName(order), isAfter ? order.afterSale?.status : orderStatus(order))}<strong>${esc(isAfter ? order.afterSale?.id : order.id)}</strong></div><p>${isSample(order) ? '后台示例订单，无真实客户。' : '买家端生成的本浏览器演示订单。'}</p></div>${itemList(order)}${bill(order)}
    ${isAfter ? afterDetail(order, d) : `<section class="detail-section"><h3>示例收货信息</h3><div class="address-detail">${icon('pin', 20)}<div><strong>${esc(address?.person || '体验用户')} · ${esc(address?.label || '')}</strong><p>${esc(address?.address || '示例地址')}</p><small>仅示例地区，不含真实收件资料。</small></div></div></section><section class="detail-section"><h3>订单时间</h3><p class="detail-copy">创建于 ${dateText(order.createdAt)}</p>${isShipped(order) ? `<p class="detail-copy">模拟发货于 ${dateText(order.fulfillment.shippedAt)}</p><dl class="shipping-meta"><div><dt>演示物流</dt><dd>${esc(order.fulfillment.carrier)}</dd></div><div><dt>演示单号</dt><dd>${esc(order.fulfillment.tracking)}</dd></div></dl>` : ''}</section><section class="detail-section"><h3>商家备注</h3><form id="order-note-form"><label class="sr-only" for="merchant-note">商家备注，最多300字</label><textarea id="merchant-note" name="note" rows="3" maxlength="300" placeholder="写下需要留意的处理信息…">${esc(d.note)}</textarea><button class="secondary small" type="submit">保存备注</button></form></section>${order.afterSale ? `<button class="linked-after" data-action="open-after" data-id="${esc(order.id)}"><div><strong>${afterStatuses[order.afterSale.status]} · ${order.afterSale.type === 'refund' ? '模拟退款' : '模拟补发'}</strong><span>查看问题与处理记录</span></div>${icon('arrow', 17)}</button>` : ''}${isWaiting(order) ? `<section class="detail-section shipping-section"><h3>模拟发货</h3>${order.afterSale?.status === 'submitted' ? '<p class="form-warning">有待处理售后，请先处理或由买家撤回申请。</p>' : `<form id="ship-form"><div class="form-grid">${field('物流名称', 'carrier', d.carrier, 'required maxlength="40"')}${field('演示单号', 'tracking', d.tracking, 'required maxlength="80" placeholder="DEMO-开头的演示单号"')}</div><p class="field-help">仅保存演示物流记录，不会通知快递或生成真实运单。</p><button type="submit" class="primary wide">确认模拟发货</button></form>`}</section>` : ''}`}
    <div id="drawer-error" class="field-error" role="alert">${esc(d.error || '')}</div></div></section></div>`;
  wireMediaErrors(drawerRoot);
}
function afterDetail(order, d) {
  const after = order.afterSale;
  if (!after) return '';
  return `<section class="detail-section"><h3>申请内容</h3><dl class="after-facts"><div><dt>关联订单</dt><dd>${esc(order.id)}</dd></div><div><dt>申请方式</dt><dd>${after.type === 'refund' ? '整单模拟退款' : '整单模拟补发'}</dd></div><div><dt>申请原因</dt><dd>${afterReasons[after.reason]}</dd></div><div><dt>申请时间</dt><dd>${dateText(after.createdAt)}</dd></div><div><dt>演示凭证</dt><dd>${after.hasEvidence ? '买家标记有演示凭证，不代表上传了真实文件' : '未提供演示凭证'}</dd></div></dl><div class="customer-description">${esc(after.description || '未填写补充描述。')}</div></section><section class="detail-section"><h3>处理意见</h3>${after.status === 'submitted' ? `<form id="resolve-form"><label class="sr-only" for="after-reply">售后处理意见，最多300字</label><textarea id="after-reply" name="reply" rows="4" maxlength="300" required placeholder="说明已核对的问题，以及本次模拟处理结果。">${esc(d.reply)}</textarea><p class="field-help">${after.type === 'refund' ? `按整单金额 ¥${money(order.total)} 标记模拟退款完成，不实际退钱。` : '标记模拟补发完成，不生成真实物流或补发包裹。'}</p><button type="submit" class="primary wide">${after.type === 'refund' ? '确认模拟退款完成' : '确认模拟补发完成'}</button></form>` : `<div class="reply-record"><p>${esc(after.merchantReply || (after.status === 'withdrawn' ? '申请已由买家撤回，无需继续处理。' : '该演示售后已标记完成，未填写处理意见。'))}</p><small>更新于 ${dateText(after.updatedAt)}</small></div>`}</section><button class="text-button" data-action="open-order" data-id="${esc(order.id)}">${icon('back', 14)} 返回订单详情</button>`;
}
function closeDrawer() {
  state.drawer = null; renderDrawer(); lastFocused?.focus?.();
}
function openDrawer(type, id) {
  const order = state.orders.find(item => item.id === id);
  if (!order || (type === 'after' && !order.afterSale)) return;
  lastFocused = document.activeElement;
  state.drawer = { type, id, note: order.merchantNote || '', carrier: '演示物流', tracking: `DEMO-${Date.now().toString(36).toUpperCase()}`, reply: order.afterSale?.merchantReply || '', error: '' };
  renderDrawer(); drawerRoot.querySelector('.drawer')?.focus();
}
function mayLeaveEditor() {
  if (state.editor?.dirty && !window.confirm('商品修改尚未保存。确定离开并放弃这些修改吗？')) return false;
  state.editor = null; state.externalChanged = false; return true;
}
function changeView(view) {
  if (!viewNames[view] || !mayLeaveEditor()) return;
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
  if (!e || !file) return;
  const sequence = ++e.sequences[kind]; e.pending[kind] = true; delete e.mediaErrors[kind]; markDirty();
  syncEditor(document.querySelector('#product-form')); render();
  try {
    if (!e.values.mediaSource.trim()) throw new Error('请先填写素材来源与授权说明');
    const saved = await saveMedia(file, kind, { source: e.values.mediaSource });
    if (state.editor !== e || e.sequences[kind] !== sequence) return;
    e.base[`${kind}MediaId`] = saved.id; e[`${kind}Preview`] = saved.url;
    if (kind === 'video') {
      if (!e.values.videoTitle.trim() || e.values.videoTitle === '采收视频 · 待补充') e.values.videoTitle = isCloudMode() ? '上传视频 · 素材演示' : '本机上传视频';
      if (!e.values.videoNote.trim() || e.values.videoNote === '暂无视频，后续可选择上传模拟素材。') e.values.videoNote = isCloudMode() ? '上传素材，仅供演示，不作为实际产地或品质证明。' : '本机上传素材，仅供演示，不作为实际产地或品质证明。';
    }
  } catch (error) {
    if (state.editor !== e || e.sequences[kind] !== sequence) return;
    e.mediaErrors[kind] = `素材没有替换：${textError(error)}`;
  } finally {
    if (state.editor === e && e.sequences[kind] === sequence) { e.pending[kind] = false; render(); }
  }
}
async function saveEditor(form, mode) {
  const e = state.editor;
  if (!e || e.pending.image || e.pending.video || state.busy) return;
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
    state.editor = null; state.externalChanged = false; state.view = 'products'; loadData(); render();
    toast(mode === 'draft' ? '商品草稿已保存' : '商品已保存并上架'); window.scrollTo({ top: 0 });
  } catch (error) {
    e.error = error.status === 409 ? '商品已被其他人修改。你的内容已保留，请复制需要的内容，再点击“放弃当前修改并重新载入”。' : `保存未完成：${textError(error)}`;
    if (error.status === 409) { state.externalChanged = true; renderAlerts(); }
    const errorNode = document.querySelector('#product-form-error'); if (errorNode) errorNode.textContent = e.error;
    toast('保存失败，填写内容已保留');
  } finally { state.busy = false; submitButtons.forEach(button => { button.disabled = false; button.textContent = button.dataset.originalLabel; }); renderSyncStatus(); }
}
function mutateOrder(id, transform) {
  readCatalog();
  const current = readOrders();
  const index = current.findIndex(order => order.id === id);
  if (index < 0) throw new Error('订单已不存在，请重新读取列表。');
  const result = transform(current[index]);
  const next = current.map((order,i) => i === index ? result : order);
  const checked = validOrders(next);
  if (checked.length !== next.length || !checked.some(order => order.id === id)) throw new Error('订单校验未通过，本次操作没有保存。');
  writeOrders(checked); state.orders = checked; render();
}
function drawerError(error) {
  if (state.drawer) state.drawer.error = textError(error);
  const node = document.querySelector('#drawer-error'); if (node) node.textContent = textError(error);
  toast('操作未完成，请查看详情中的提示');
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-view],[data-action]');
  if (!button || button.disabled) return;
  if (button.dataset.action === 'retry-auth') { await boot(true); return; }
  if (!hasAccess()) return;
  if (button.dataset.action === 'refresh-cloud') { await refreshRemote({ manual: true }); return; }
  if (state.busy) return;
  if (button.dataset.view) { changeView(button.dataset.view); return; }
  const { action, id } = button.dataset;
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
    state.busy = true; button.disabled = true;
    try { readCatalog(); await setProductStatus(id, button.dataset.status, { expectedVersion: getProductVersion(id) }); loadData(); render(); toast(button.dataset.status === 'published' ? '商品已上架' : '商品已下架'); }
    catch (error) { state.errors.action = `商品状态没有保存：${textError(error)}`; renderAlerts(); }
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
  else if (action === 'retry-data') {
    if (isCloudMode()) { await refreshRemote({ manual: true }); return; }
    loadData(); loadMedia().then(() => { if (!state.editor) render(); else renderAlerts(); });
    if (!state.editor) render(); else renderAlerts();
  } else if (action === 'seed-cloud') {
    try { await apiRequest('/api/v1/admin/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await refreshRemote({ manual: true }); toast('示例商品初始化完成，已有商品保持原样'); }
    catch (error) { state.errors.sync = textError(error); renderAlerts(); }
  } else if (action === 'reload-editor') {
    if (!state.editor || !window.confirm('重新载入将放弃当前未保存的内容，确定继续吗？')) return;
    const id = state.editor.base.id;
    try { await refreshCatalog({ admin: isCloudMode() }); loadData(); await loadMedia(); const latest = state.products.find(p => p.id === id); state.editor = latest ? editorFrom(latest) : null; state.externalChanged = false; render(); }
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
  if (target.matches('[data-media]')) { chooseFile(target); return; }
  if (target.dataset.filter) {
    const kind = target.dataset.filter;
    const form = target.closest('form'); state[`${kind}Filter`].query = String(new FormData(form).get('query') || '').trim();
    state[`${kind}Filter`][target.name] = target.value; render();
  }
  if (target.closest('#product-form') && state.editor && Object.hasOwn(state.editor.values, target.name)) { state.editor.values[target.name] = target.value; markDirty(); }
});
document.addEventListener('submit', event => {
  event.preventDefault(); if (!hasAccess() || state.busy) return; const form = event.target;
  if (form.id.startsWith('search-')) { const kind = form.id.slice(7); state[`${kind}Filter`].query = String(new FormData(form).get('query') || '').trim(); render(); return; }
  if (form.id === 'product-form') { saveEditor(form, event.submitter?.value || 'published'); return; }
  if (!state.drawer) return;
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
  if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); return; }
  if (event.key === 'Tab') {
    const focusable = [...drawerRoot.querySelectorAll('.drawer button:not([disabled]), .drawer input, .drawer select, .drawer textarea, .drawer a[href]')];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === drawerRoot.querySelector('.drawer'))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
window.addEventListener('beforeunload', event => { if (state.editor?.dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('storage', async event => {
  if (!hasAccess() || ![CATALOG_KEY, STORAGE_KEY, null].includes(event.key)) return;
  if (isCloudMode() && event.key === CATALOG_KEY) return;
  loadData(); await loadMedia();
  if (state.editor) { state.externalChanged = true; renderAlerts(); }
  else if (!state.drawer) render();
});

window.addEventListener('focus', () => refreshRemote());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRemote(); });
setInterval(() => { if (!document.hidden) refreshRemote(); }, 30000);
boot();
