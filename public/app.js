import { CATALOG, PRODUCT, setCatalog, getProduct, ADDRESSES, STORAGE_KEY, quote, money, createOrder, validOrders, createAfterSale, updateAfterSale, receiveOrder, orderItems, isProductAvailable } from './model.js';
import { icon, esc } from './ui.js';
import { createExperience } from './experience.js';
import { CATALOG_KEY, readCatalog, initializeCatalog, refreshCatalog } from './catalog-store.js';
import { hydrateMedia, imageFor, videoFor, mediaErrorFor } from './media-store.js';
import { isCloudMode, getCloudState, initializeCloudMode } from './cloud-client.js';
import { loadCloudOrders, loadCloudOrder, quoteCloudOrder, submitCloudOrder, mutateCloudOrder, createOrderRequestKey } from './order-store.js';
import { refreshBuyerInventory, inventoryFor, availability, inventoryFingerprint } from './buyer-inventory.js';
import { createJourney } from './journey.js';
import { getBuyerState, refreshBuyerState, mutateBuyerState, clearBuyerState } from './buyer-state-store.js';
import { refreshStorefront, getStorefrontState, shopForProduct, regionForProduct } from './storefront-store.js';
let catalogLoadError='', catalogReady=false, catalogRefreshing=false, catalogPending=false;
setCatalog([]);
try { await initializeCatalog(); catalogReady=true; } catch(error) { catalogLoadError=error.message; }
const initialMediaIssues=await hydrateMedia(CATALOG);
await refreshBuyerInventory();
await refreshStorefront({products:CATALOG});
if(isCloudMode())await refreshBuyerState();

const app = document.querySelector('#app');
const tabbar = document.querySelector('#tabbar');
const modalRoot = document.querySelector('#modal-root');
const selection = { productId: 'jingtai-apple', variant: 'small', quantity: 1, address: 'gansu' };
try { const saved=JSON.parse(sessionStorage.getItem('longshang-demo-selection-v2')||'null'); if(saved && getProduct(saved.productId) && ['small','family'].includes(saved.variant) && ADDRESSES.some(a=>a.id===saved.address) && Number.isInteger(saved.quantity) && saved.quantity>=1 && saved.quantity<=10) Object.assign(selection,{productId:saved.productId,variant:saved.variant,quantity:saved.quantity,address:saved.address}); } catch {}
if(isCloudMode()&&getBuyerState().ready)selection.address=getBuyerState().preferredAddress;
let category = 'all', orderFilter = 'all', originCategory = 'orchard';
let orders = [], persistence = true, submitting = false, modalFocus, toastTimer;
let afterDraft = { orderId: '', type: 'refund', reason: '', description: '', hasEvidence: false };
const chat = [];
const reasonLabels = { damaged:'破损 / 坏果', spec:'重量或规格不符', delivery:'配送问题', other:'其他问题' };
const typeLabels = { refund:'退款演示', replacement:'补发演示' };
const statusLabels = { submitted:'待处理（模拟）', resolved:'已完成（模拟）', withdrawn:'已撤回（模拟）' };
const FAQs = [
  {id:'flow',q:'怎样完整体验这套商城？',a:'先在产区或采购者店铺选商品，收藏或加入购物车，同店商品可生成一笔模拟订单。商家在后台模拟发货后，买家在订单确认模拟收货；有问题可申请售后并查看处理意见。全部使用模拟资料，不会扣款。'},
  {id:'sync',q:'换手机后能看到什么？',a:'云端模式登录同一账号后，商品、购物车、收藏、足迹、示例收货地区偏好、订单与售后可同步。旧本机演示资料不会自动上传，客服对话只保留在当前页面。'},
  { id:'size', q:'苹果到底有多大？', a:'苹果详情里可以查看果径与规格说明。目前演示果径为 75–85mm；正式商品会按实际分级填写，并配上测量实拍。净重不包含纸箱和缓冲材料。' },
  { id:'goji', q:'枸杞怎么选规格？', a:'当前演示提供 100g 尝鲜装和 250g 分享装。请在商品页查看颗粒、干燥程度与包装信息。当前所有价格和规格都为示例，不代表实际货源。' },
  { id:'shipping', q:'运费怎么算？', a:'演示按每笔订单计算：甘肃示例地址 6 元，陕西示例地址 10 元。其他地区暂未开放演示下单；正式运费需确认首重、续重和配送范围。' },
  { id:'aftersale', q:'收到坏果怎么办？', a:'在“我的订单”找到对应商品，点击“申请售后”，选择问题与处理方式，可添加示例凭证并提交。云端模式登录后可同步售后记录，由管理后台模拟处理；没有实际退款或补发。' },
  { id:'dispatch', q:'什么时候发货？', a:'当前为无支付的演示版，所有订单都不会真实发货。正式上架后，商品页会明确采摘批次、预计出库时间和快递覆盖范围。' }
];
if (!isCloudMode()) { try { orders = validOrders(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); } catch { persistence = false; } }
function persist(){ if(isCloudMode())return; try{ localStorage.setItem(STORAGE_KEY,JSON.stringify(orders)); }catch{ persistence=false; toast('本浏览器无法保存，当前记录将在页面关闭后消失。'); } }
function refreshStoredOrders(){ if(isCloudMode()||!persistence)return; try{orders=validOrders(JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]'));}catch{persistence=false;} }
let displayedCheckout = null;
const scrollPositions=new Map(), productSources=new Map(), routeSources=new Map();
let navigationIntent=null;
function routeKey(){return route().map(value=>encodeURIComponent(value)).join('/');}
function productBack(id){return productSources.get(id)||(shopForProduct(id)?`shop/${shopForProduct(id).id}`:'specialties');}
function backRoute(page,id,fallback){return routeSources.get(`${page}/${encodeURIComponent(id)}`)||fallback;}
function isAncestor(path,from){const seen=new Set();while(from&&!seen.has(from)){if(from===path)return true;seen.add(from);const [page,id]=from.split('/');from=page==='product'?productSources.get(decodeURIComponent(id||'')):routeSources.get(from);}return false;}
function rememberPosition(){scrollPositions.set(routeKey(),app.scrollTop);if(scrollPositions.size>100)scrollPositions.delete(scrollPositions.keys().next().value);}
let shoppingRefreshing=false, shoppingPending=false;
let ordersReady = !isCloudMode(), ordersRefreshing = false, ordersError = '', ordersSyncedAt = '';
let ordersAccount = getCloudState().session?.user?.id || '', orderSyncPending = false, orderMutationRevision = 0;
const cloudPendingPrefix = 'longshang-cloud-pending-order-v1:';
const confirmedCartRequests=new Map();
function buyerAuthLink(signOut = false) {
  return `/${signOut ? 'signout' : 'signin'}-with-chatgpt?return_to=${encodeURIComponent('/index.html#/orders')}`;
}
function accountPanel() {
  if (!isCloudMode()) return '';
  const user = getCloudState().session?.user;
  return `<div class="buyer-account"><div><strong>${user ? esc(user.name || user.email) : '登录后同步订单'}</strong><p>${user ? '手机和电脑登录同一账号，同步购物车、收藏、足迹、订单与售后。' : '商品可先逛，模拟下单前需要登录。'}</p></div><a class="secondary small" href="${buyerAuthLink(!!user)}" target="_top">${user ? '退出登录' : '登录账号'}</a></div>`;
}
function cloudOrderNotice() {
  if (!isCloudMode()) return '';
  const time = ordersSyncedAt ? new Intl.DateTimeFormat('zh-CN', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Asia/Shanghai' }).format(new Date(ordersSyncedAt)) : '';
  return `<div class="order-cloud-status ${ordersError ? 'has-error' : ''}" role="status"><span>${esc(ordersRefreshing ? '正在读取云端订单…' : ordersError || (orderSyncPending ? '订单有更新，点击刷新查看' : `订单与售后已接入云端${time ? ' · '+time+'同步' : ''}`))}</span><button class="text-link" data-action="refresh-orders" ${ordersRefreshing ? 'disabled' : ''}>${ordersRefreshing ? '读取中' : '刷新订单'}</button>${getPendingCloudOrder() ? '<button class="text-link" data-action="retry-pending-order">确认上次下单结果</button>' : ''}</div>`;
}
function cloudOrderGate(needsOrders = true) {
  if (!isCloudMode()) return '';
  if (!getCloudState().session?.user) return `<section class="empty-orders"><div class="empty-illustration">${icon('user',44)}</div><h2>登录后同步订单与售后</h2><p>在手机和电脑登录同一个账号，即可查看同一份模拟记录。不会扣款，不需要填写真实收货资料。</p><a class="primary" href="${buyerAuthLink()}" target="_top">登录账号</a><button class="text-link" data-action="refresh-orders">已登录？重新读取</button></section>`;
  if (needsOrders && !ordersReady) return `<section class="empty-orders"><h2>${ordersError ? '云端订单暂时无法读取' : '正在读取你的云端订单'}</h2><p>${esc(ordersError || '首次读取中，请稍候。')}</p><button class="primary" data-action="refresh-orders" ${ordersRefreshing ? 'disabled' : ''}>重新读取</button></section>`;
  return '';
}
function pendingCloudKey(id=getCloudState().session?.user?.id) { return id ? cloudPendingPrefix+encodeURIComponent(id) : ''; }
function getPendingCloudOrder() {
  const key=pendingCloudKey(); if(!key)return null;
  try { const pending=JSON.parse(sessionStorage.getItem(key)||'null'); return pending?.userId===getCloudState().session?.user?.id && pending?.request?.idempotencyKey ? pending : null; } catch { return null; }
}
function rememberPendingCloudOrder(pending) {
  try { sessionStorage.setItem(pendingCloudKey(),JSON.stringify(pending)); }
  catch { throw new Error('浏览器无法保存下单重试标识，请允许会话存储后再试；尚未创建订单。'); }
}
function clearPendingCloudOrder(userId,requestKey) { try { const key=pendingCloudKey(userId);const saved=JSON.parse(sessionStorage.getItem(key)||'null');if(saved?.userId===userId&&saved.request?.idempotencyKey===requestKey)sessionStorage.removeItem(key); } catch {} }
function cartCleanupConfirmed(orderId,account){
  if(account!==getCloudState().session?.user?.id)return;
  const key=`${account}:${orderId}`,requestKey=confirmedCartRequests.get(key),pending=getPendingCloudOrder();
  if(requestKey&&pending?.fromCart&&pending.request.idempotencyKey===requestKey)clearPendingCloudOrder(account,requestKey);
  confirmedCartRequests.delete(key);
}
function acceptCloudOrder(order) { const previous=orders.find(item=>item.id===order.id);const latest=previous&&previous.version>order.version?previous:order;orders=[latest,...orders.filter(item=>item.id!==order.id)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));orderMutationRevision++;ordersReady=true;ordersSyncedAt=new Date().toISOString();ordersError=''; }
async function sendPendingCloudOrder(pending) {
  const account=getCloudState().session?.user?.id;
  if(pending.userId!==account)throw Object.assign(new Error('登录账号已变化，请返回原账号确认上次下单结果。'),{status:409,code:'account_changed'});
  try {
    const order=await submitCloudOrder(pending.request);
    if(account!==getCloudState().session?.user?.id)throw Object.assign(new Error('登录账号已变化，请重新读取订单。'),{status:409,code:'account_changed'});
    let cleanupDurable=true;
    if(pending.fromCart){
      confirmedCartRequests.set(`${pending.userId}:${order.id}`,pending.request.idempotencyKey);
      if(confirmedCartRequests.size>100)confirmedCartRequests.delete(confirmedCartRequests.keys().next().value);
      cleanupDurable=experience.prepareOrderCleanup?.(order.id,pending.userId)===true;
    }
    if(cleanupDurable)clearPendingCloudOrder(pending.userId,pending.request.idempotencyKey);
    acceptCloudOrder(order);await refreshBuyerInventory();
    if(account!==getCloudState().session?.user?.id){
      if(ordersAccount===account){orders=[];ordersReady=false;ordersSyncedAt='';afterDraft={orderId:'',type:'refund',reason:'',description:'',hasEvidence:false};}
      throw Object.assign(new Error('登录账号已变化，请返回原账号查看已生成的订单。'),{status:409,code:'account_changed'});
    }
    return order;
  } catch(error) {
    if(error.code!=='account_changed'&&[400,403,404,409,413,415,422].includes(error.status))clearPendingCloudOrder(pending.userId,pending.request.idempotencyKey);
    throw error;
  }
}
async function createBuyerCloudOrder(items,address,expectedTotal,expectedPrices,expectedBatches) {
  if(!getCloudState().session?.user)throw new Error('请先登录，再生成云端模拟订单。');
  const normalized=items.map(({productId,variant,quantity})=>({productId,variant,quantity}));
  const fingerprint=JSON.stringify({items:[...normalized].sort((a,b)=>(a.productId+'::'+a.variant).localeCompare(b.productId+'::'+b.variant)),address});
  let pending=getPendingCloudOrder();
  if(pending && pending.fingerprint!==fingerprint)throw new Error('上次下单结果尚未确认，请先在“我的订单”点击“确认上次下单结果”，避免重复下单。');
  if(!pending) {
    const directory=getStorefrontState(),shops=normalized.map(item=>shopForProduct(item.productId));
    if(!directory.ready||directory.error||shops.some(shop=>!shop||shop.preview))throw new Error('采购者店铺暂时无法确认，请刷新店铺资料后重试。');
    if(new Set(shops.map(shop=>shop.id)).size!==1)throw new Error('不同采购者的商品需要分开下单，请在购物车选择一家店结算。');
    let quoted;
    try { quoted=await quoteCloudOrder(normalized,address); } catch(error) { if(error.status===409)await syncBuyerCatalog(true); throw error; }
    if(expectedBatches&&quoted.items.some(item=>expectedBatches[item.productId]!==item.batchId)){await syncBuyerCatalog(true);throw new Error('商品采收批次已更新，请核对新的批次信息后再次下单。');}
    const priceMismatch=expectedPrices&&quoted.items.some(item=>expectedPrices[`${item.productId}::${item.variant}`]!==item.unitPrice);
    if(quoted.total!==expectedTotal||priceMismatch) { await syncBuyerCatalog(true); throw new Error('商品价格或运费已更新，请核对最新金额后再次点击生成订单；本次尚未下单。'); }
    pending={userId:getCloudState().session.user.id,fingerprint,fromCart:route()[0]==='cart-checkout',request:{items:normalized,address,expectedTotal:quoted.total,productVersions:quoted.productVersions,inventoryVersions:quoted.inventoryVersions,idempotencyKey:createOrderRequestKey()}};
    rememberPendingCloudOrder(pending);
  }
  try { return await sendPendingCloudOrder(pending); } catch(error) { if(['stock_insufficient','quote_changed'].includes(error.code))await syncBuyerCatalog(true);throw error; }
}
async function refreshBuyerOrders(manual = false) {
  if(!isCloudMode()||ordersRefreshing)return;
  ordersRefreshing=true;
  const before=JSON.stringify(orders);
  const mutationAtStart=orderMutationRevision,draftAtStart={orderId:afterDraft.orderId,expectedVersion:afterDraft.expectedVersion};
  try {
    await initializeCloudMode({force:true});
    const account=getCloudState().session?.user?.id||'';
    const accountChanged=account!==ordersAccount;
    if(accountChanged){clearBuyerState();selection.address='gansu';orders=[];ordersAccount=account;ordersReady=false;ordersSyncedAt='';afterDraft={orderId:'',type:'refund',reason:'',description:'',hasEvidence:false};closeModal();render(true);await experience.refresh();}
    if(!account){orders=[];ordersReady=false;ordersError='';if(manual||accountChanged)render(true);return;}
    const loaded=await loadCloudOrders();
    if(account!==getCloudState().session?.user?.id)return;
    let incoming=loaded.orders;
    const [page,id]=route();
    if(['order','aftersale'].includes(page)&&id&&!incoming.some(order=>order.id===id)){
      try{const detail=await loadCloudOrder(id);incoming=[detail,...incoming];}catch(error){if(error.status!==404)throw error;}
    }
    if(account!==getCloudState().session?.user?.id)return;
    // Reads may have begun before a successful checkout or after-sale write.
    // Orders have no delete operation, so retain confirmed IDs and the highest
    // version instead of replacing newer local acknowledgements with old reads.
    const merged=new Map(incoming.map(order=>[order.id,order]));
    for(const current of orders){const loadedOrder=merged.get(current.id);if(!loadedOrder||current.version>loadedOrder.version)merged.set(current.id,current);}
    const busy=submitting||modalRoot.children.length||document.activeElement?.matches('input,textarea,select');
    orders=[...merged.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));ordersReady=true;ordersError='';ordersSyncedAt=loaded.lastSyncedAt||new Date().toISOString();
    if(manual&&mutationAtStart===orderMutationRevision&&afterDraft.orderId===draftAtStart.orderId&&afterDraft.expectedVersion===draftAtStart.expectedVersion&&afterDraft.orderId){const latest=orders.find(order=>order.id===afterDraft.orderId);if(latest)afterDraft.expectedVersion=latest.version;}
    if(manual||accountChanged||!busy){captureAfterDraft();orderSyncPending=false;render(true);}else if(before!==JSON.stringify(orders))orderSyncPending=true;
    if(manual)toast('已读取最新云端订单与售后记录');
  }catch(error){ordersError=error.message;if(!getCloudState().session?.user||[401,403].includes(error.status)){orders=[];ordersReady=false;afterDraft={orderId:'',type:'refund',reason:'',description:'',hasEvidence:false};}if(manual||!ordersReady)render(true);if(manual)toast(error.message);}
  finally{ordersRefreshing=false;const current=route()[0];if(!submitting&&!modalRoot.children.length&&!document.activeElement?.matches('input,textarea,select')&&['orders','order','aftersale','mine'].includes(current))render(true);}
}
function route(){try{return(location.hash.slice(2)||'home').split('/').map(decodeURIComponent);}catch{return ['not-found'];}}
function nav(path,{restore=false}={}){const previous=routeKey();rememberPosition();closeModal();if(!restore&&/^(region|shop)\//.test(path)&&path!==previous){if(isAncestor(path,previous))restore=true;else{routeSources.set(path,previous);if(routeSources.size>100)routeSources.delete(routeSources.keys().next().value);}}navigationIntent={path,restore};if(location.hash===`#/${path}`){render(restore);navigationIntent=null;}else location.hash=`/${path}`;}
function toast(message){const el=document.querySelector('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3200);}
function price(value,cls=''){return `<span class="price ${cls}"><span>¥</span>${money(value)}<small>模拟价</small></span>`;}
function q(){return quote(selection.variant,selection.quantity,selection.address,selection.productId);}
function title(text,back='home',trailing=''){return `<div class="page-title"><button class="icon-button" data-action="back" data-route="${esc(back)}" aria-label="返回上一页">${icon('back')}</button><h1>${text}</h1>${trailing||'<span class="title-spacer"></span>'}</div>`;}
function chatButton(id=''){return `<button class="icon-button" data-action="support" data-id="${id}" aria-label="联系客服">${icon('chat')}</button>`;}
function stepper(n){return `<div class="stepper"><button data-action="quantity" data-delta="-1" aria-label="减少一份" ${n<=1?'disabled':''}>−</button><span aria-live="polite">${n}</span><button data-action="quantity" data-delta="1" aria-label="增加一份" ${n>=10?'disabled':''}>+</button></div>`;}
function inventoryPanel(p,variant,quantity=1){
  if(!isCloudMode())return '';
  const current=inventoryFor(p.id),stock=availability(p,variant,quantity);
  return `<section class="surface stock-panel"><div class="section-line"><h2>当前采收批次</h2><span>模拟资料</span></div><p class="stock-availability ${stock.available?'':'stock-unavailable'}" role="status">${esc(stock.message)}</p>${current?.configured?`<dl class="spec-list"><div><dt>批次编号</dt><dd>${esc(current.batchCode)}</dd></div><div><dt>采收日期</dt><dd>${esc(current.harvestDate||'待补充')}</dd></div></dl>${current.note?`<p class="body-copy">${esc(current.note)}</p>`:''}`:'<p class="body-copy">采购者设置库存后，这个规格才能生成模拟订单。</p>'}<p class="info-note">按所选规格的份数计库存，以下单时校验为准。批次介绍由采购者填写。</p><button class="text-link" data-action="refresh-cloud">刷新库存与批次</button></section>`;
}
function miniProduct(o){
  if(o?.items)return `<div class="order-products">${orderItems(o).map(item=>miniProduct(item)).join('')}</div>`;
  const x=o?null:q();const item=o||{productId:x.product.id,product:x.product.name,image:x.product.image,imageMediaId:x.product.imageMediaId,variantLabel:x.variant.label,weight:x.variant.weight,unitPrice:x.variant.price,quantity:x.quantity};
  const live=getProduct(item.productId);
  const photo=`<img src="${esc(imageFor(item))}" data-order-fallback="${esc(item.image||'assets/apples.jpg')}" alt="${esc(item.product)}示意">`;
  return `<div class="mini-product">${live?`<button class="mini-product-photo" data-action="view-product" data-product="${esc(item.productId)}" aria-label="查看${esc(item.product)}详情">${photo}</button>`:`<span class="mini-product-photo">${photo}</span>`}<div><h3>${esc(item.product)}</h3><p>${esc(item.variantLabel)} · ${esc(item.weight)}</p>${item.batchCode?`<small class="order-batch">下单批次：${esc(item.batchCode)}${item.harvestDate?` · ${esc(item.harvestDate)}`:''}</small>${item.batchNote?`<small class="order-batch">${esc(item.batchNote)}</small>`:''}`:''}<span>¥${money(item.unitPrice)}</span></div><small>× ${item.quantity}</small></div>`;
}
function tabs(active){const selected=active==='orders'?'mine':['regions','region','shops','shop','origin'].includes(active)?'regions':active==='search'?'specialties':active;return [['home','home','逛好物'],['specialties','book','特产馆'],['regions','pin','逛产区'],['cart','cart','购物车'],['mine','user','我的']].map(([path,i,label])=>`<button class="${selected===path?'active':''}" data-action="navigate" data-route="${path}" ${selected===path?'aria-current="page"':''}><span class="tab-icon">${icon(i)}${path==='cart'&&experience.count()?`<b class="cart-badge">${experience.count()>99?'99+':experience.count()}</b>`:''}</span><span>${label}</span></button>`).join('');}
function productCard(p){return `<button class="catalog-card" data-action="view-product" data-product="${esc(p.id)}"><div class="catalog-image"><img src="${esc(imageFor(p))}" alt="${esc(p.name)}示意图" loading="lazy"><span>${!isProductAvailable(p)?'暂未上架':isCloudMode()&&!p.variants.some(v=>availability(p,v.id).available)?'待备货':p.category==='fruit'?'时令鲜果':p.category==='dried'?'家乡干货':'田间蔬菜'}</span></div><div class="catalog-copy"><span class="overline">${esc(p.origin)}</span><h3>${esc(p.name)}</h3><p>${esc(p.subtitle)}</p><span class="catalog-spec">${esc(p.variants[0].weight)}</span><div>${price(p.variants[0].price)}<span class="round-arrow">${icon('arrow',15)}</span></div></div></button>`;}
function emptyState(heading,description,button='去逛好物'){return `<div class="empty-orders"><div class="empty-illustration">${icon('box',52)}</div><h2>${heading}</h2><p>${description}</p><button class="primary" data-action="go-home">${button}</button></div>`;}
function videoBlock(p=PRODUCT){const src=videoFor(p);if(!src)return `<div class="harvest-photo"><img src="${esc(imageFor(p))}" alt="${esc(p.name)}示意图片" loading="lazy"><span>采收视频待补充</span></div><p class="info-note">${esc(mediaErrorFor(p)||'当前展示采收介绍，暂无可播放的视频素材。')}</p>`;return `<div class="harvest-video"><div class="video-badge">${esc(p.name)} · 素材演示</div><video controls playsinline preload="metadata"  aria-label="${esc(p.name)}采收演示视频"><source src="${esc(src)}">当前浏览器不支持视频，请更换浏览器或在后台选择其他文件。</video><p class="video-error" hidden>视频暂时无法播放，可刷新或在后台重新选择素材。</p></div><div class="video-caption"><strong>${esc(p.videoTitle||'从田间到餐桌')}</strong><p>${esc(p.videoNote||'此素材用于页面演示，不作为真实产地或品质证明。')}</p><p>${isCloudMode()?'云端素材展示':'本机素材预览'}，不代表实际供货批次。</p></div>`;}
function harvestSteps(p){return `<ol class="harvest-steps">${p.harvestSteps.map((s,i)=>`<li><span>0${i+1}</span><div><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div></li>`).join('')}</ol>`;}

function homeBase(){if(!CATALOG.some(isProductAvailable))return emptyState('好物正在准备中','商家上架后，这里会显示最新的模拟商品。');const items=CATALOG.filter(p=>isProductAvailable(p)&&(category==='all'||p.category===category));const featured=CATALOG.find(p=>isProductAvailable(p)&&p.id==='jingtai-apple')||CATALOG.find(isProductAvailable)||PRODUCT;return `<section class="home-page"><div class="location-row"><button data-action="origin">${icon('pin',16)} 甘肃 · 景泰 ${icon('arrow',13)}</button><button class="home-service" data-action="support">${icon('chat',15)} 客服</button></div><div class="hero"><img src="${esc(imageFor(featured))}" alt="${esc(featured.name)}示意照片"><div class="hero-shade"></div><span class="hero-tag">本期主角 · ${esc(featured.name)}</span><div class="hero-copy"><span>FROM THE ORCHARD</span><h1>这一口，<br>是家乡的秋天。</h1><p>看看怎么摘，再挑喜欢的好物</p><button data-action="view-product" data-product="${featured.id}">看看这份家乡好物 ${icon('arrow',16)}</button></div><span class="image-note">图片仅为示意</span></div><div class="home-shortcuts"><button data-action="origin">${icon('leaf',19)}<span>看田间故事</span></button><button data-action="view-product" data-product="jingtai-apple" data-section="specifications">${icon('box',19)}<span>看大小规格</span></button><button data-action="go-orders">${icon('heart',19)}<span>订单与售后</span></button></div><div class="category-tabs catalog-tabs" role="group" aria-label="商品分类">${[['all','全部好物'],['fruit','时令鲜果'],['dried','家乡干货'],['vegetable','田间蔬菜']].map(([id,label])=>`<button data-action="category" data-category="${id}" class="${category===id?'selected':''}" aria-pressed="${category===id}">${label}</button>`).join('')}</div><div class="section-heading"><div><h2>这一方水土的好味道</h2><p>每一款，都可以点进去慢慢看</p></div><span>${String(items.length).padStart(2,'0')} / 好物</span></div><div class="catalog-grid">${items.map(productCard).join('')}</div>${items.length?'':'<p class="availability-note">这个分类暂时没有上架商品，可以切换分类再看看。</p>'}<button class="origin-card" data-action="origin"><div><span class="overline">不止看商品，也看它的来处</span><h3>一起走进田间</h3><p>采摘视频 · 分拣包装 · 产地档案 ${icon('arrow',13)}</p></div><img src="assets/orchard.jpg" alt="果园示意照片" loading="lazy"></button><p class="page-footnote">商品均为模拟，图片与视频不代表实际货源。</p></section>`;}
function home(){return journey.home();}
function product(id=selection.productId){const p=getProduct(id);if(!p)return `${title('商品详情')}${emptyState('这款好物暂未收录','返回首页选择其他商品。')}`;if(selection.productId!==p.id){selection.productId=p.id;selection.variant='small';selection.quantity=1;}const x=q();return `${title('好物详情',productBack(p.id),chatButton())}<section class="detail-page">${journey.productContext(p)}<div class="detail-image"><img src="${esc(imageFor(p))}" alt="${esc(p.name)}示意"><span class="hero-tag">${esc(p.origin)} / 模拟商品</span><span class="image-note">图片仅为示意</span></div><div class="detail-summary">${!isProductAvailable(p)?'<p class="availability-note">这款商品暂未上架，目前只能浏览，不能加入购物车或下单。</p>':''}${price(x.variant.price,'large')}<h1>${esc(p.name)}</h1><p>${esc(p.subtitle)}</p><div class="feature-tags">${p.tags.map(t=>`<span>${esc(t)}</span>`).join('')}</div></div><div class="detail-jumps"><button data-action="jump" data-section="specifications">大小 / 规格</button><button data-action="jump" data-section="harvest">${videoFor(p)?'采收视频':'采收介绍'}</button><button data-action="jump" data-section="storage">包装 / 储存</button></div><div class="surface"><div class="section-line"><h2>选一份刚刚好的</h2><span>净含量不含外包装</span></div><div class="variant-grid">${p.variants.map(v=>`<button data-action="variant" data-variant="${v.id}" class="variant ${selection.variant===v.id?'selected':''}" aria-pressed="${selection.variant===v.id}"><span>${esc(v.label)}</span><strong>${esc(v.weight)}</strong><small>¥${money(v.price)}</small>${isCloudMode()?`<small class="variant-stock">${esc(availability(p,v.id).message)}</small>`:''}${selection.variant===v.id?`<i>${icon('check',12)}</i>`:''}</button>`).join('')}</div><p class="variant-hint">${esc(x.variant.hint)}</p><div class="quantity-line"><span>购买数量<small>演示限 1–10 份</small></span>${stepper(x.quantity)}</div></div>${inventoryPanel(p,selection.variant,selection.quantity)}<section class="surface spec-section" id="specifications"><div class="section-line"><h2>${p.id==='jingtai-apple'?'苹果有多大？':'这份好物，规格说清楚'}</h2><span>模拟规格</span></div>${p.id==='jingtai-apple'?'<div class="apple-size"><div class="apple-outline"><span>75–85<span>mm</span></span></div><div><h3>看果径，也看净重</h3><p>以果实横向直径分级。<br>一箱按净重售卖，大小会有自然差异。</p><small>尺寸示意，非真实测量结果</small></div></div>':''}<p class="body-copy">${esc(p.summary)}</p><dl class="spec-list">${p.facts.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><p class="info-note">${esc(p.sizeNote)}</p></section><section class="surface media-section" id="harvest"><div class="section-line"><h2>${p.id==='jingtai-apple'?'到树下，看一场采摘':'从田间到包装，怎么准备'}</h2><button class="text-link" data-action="origin">看产地 ${icon('arrow',13)}</button></div>${videoBlock(p)}${harvestSteps(p)}</section><section class="surface" id="storage"><div class="section-line"><h2>包装、储存与食用</h2>${icon('box',19)}</div><p class="body-copy">${esc(p.storage)}</p><div class="packing-note">${icon('check',17)}<span>正式上架会补充包装实拍、采收批次与出库时间。</span></div></section>${experience.detailExtras(p)}<div class="surface detail-facts"><button data-action="origin"><span>${icon('pin')}产地</span><b>${esc(regionForProduct(p.id)?.name||p.origin)} · 查看产区</b>${icon('arrow',15)}</button><button data-action="delivery"><span>${icon('truck')}配送</span><b>运费在确认订单时展示</b>${icon('arrow',15)}</button><button data-action="support"><span>${icon('chat')}客服</span><b>买前咨询 · 售后问题</b>${icon('arrow',15)}</button></div><p class="page-footnote">规格、产地与品质描述均为模拟展示，非售卖承诺。</p></section>${experience.productBar(p,x)}`;}
function origin(){const groups={orchard:{label:'果园',title:'从一颗苹果，认识这片土地。',body:'镜头先对准田间：果实长什么样、怎样采摘、如何挑选，再到称重和装箱。让每一份商品都有看得见的来处。',products:['jingtai-apple','pear']},goji:{label:'枸杞地',title:'一粒红色，认真看它的来路。',body:'枸杞需要说明采收、干燥、筛选和包装。页面先展示商品与流程示意，真实产地视频、批次与检测材料在货源确认后补充。',products:['goji']},field:{label:'田间',title:'把平常的蔬菜，也讲清楚。',body:'土豆、玉米、洋葱，关注采收后的分拣、净重与包装。商品按真实供货信息确认后，再记录地块、采收时间和出库过程。',products:['potato','corn','onion']}};const g=groups[originCategory]||groups.orchard;const categoryId=originCategory==='goji'?'dried':originCategory==='field'?'vegetable':'fruit';const sourceProducts=CATALOG.filter(p=>isProductAvailable(p)&&p.category===categoryId);const films=sourceProducts.filter(p=>videoFor(p));return `<section class="origin-page"><div class="origin-hero"><img src="assets/orchard.jpg" alt="果园场景示意"><div></div><span class="eyebrow">第一站 · 甘肃景泰</span><h1>好味道，<br>从田间开始。</h1><small>画面为示意，非实际供货产地</small></div><div class="origin-body"><div class="origin-selector" role="group" aria-label="产地类型">${Object.entries(groups).map(([id,g])=>`<button data-action="origin-category" data-category="${id}" class="${id===originCategory?'selected':''}">${g.label}</button>`).join('')}</div><span class="eyebrow">看见来处，再做选择</span><h2 class="serif-title">${g.title}</h2><p class="body-copy">${g.body}</p>${films.length?films.slice(0,6).map(p=>`<section class="origin-film"><div class="section-heading"><div><h2>${esc(p.name)} · 采收记录</h2><p>${esc(p.origin)} · 与商品详情同步</p></div></div>${videoBlock(p)}${harvestSteps(p)}</section>`).join(''):`<div class="origin-preview"><img src="${esc(sourceProducts.length?imageFor(sourceProducts[0]):'assets/orchard.jpg')}" alt="产地内容示意"><div><h3>${g.label}记录 · 待补充</h3><p>对应商品上传视频并上架后，可在这里查看。</p></div></div>`}<section class="origin-file"><div class="section-line"><h2>一份看得懂的产地档案</h2><span class="small-pill">待核实</span></div><dl class="spec-list"><div><dt>项目起步地</dt><dd>甘肃省白银市景泰县</dd></div><div><dt>供货农户</dt><dd>待你补充真实农户资料</dd></div><div><dt>具体地块</dt><dd>待实地核实与记录</dd></div><div><dt>采收批次</dt><dd>按每次实际供货更新</dd></div><div><dt>质检 / 凭证</dt><dd>按对应商品补充展示</dd></div></dl></section><div class="section-heading"><div><h2>这里的好物</h2><p>点进商品，继续看规格和价格</p></div><span>${sourceProducts.length} 款</span></div><div class="catalog-grid">${sourceProducts.map(productCard).join('')}</div><p class="page-footnote">本页介绍展示未来的内容结构，不代表已建立供货合作。</p></div></section>`;}

function checkout(){if(!getProduct(selection.productId))return emptyState('这款商品已暂停售卖','请返回首页重新选择商品。');const x=q();displayedCheckout={items:[{productId:x.product.id,variant:x.variant.id,quantity:x.quantity}],address:x.address.id,total:x.total,prices:{[`${x.product.id}::${x.variant.id}`]:x.variant.price},batches:{[x.product.id]:inventoryFor(x.product.id)?.batchId||''}};return `${title('确认模拟订单',`product/${selection.productId}`)}<section class="checkout-page"><div class="flow-label"><span>01 选择好物</span><i></i><b>02 确认订单</b><i></i><span>03 完成</span></div><button class="address-card" data-action="address"><span class="address-icon">${icon('pin',25)}</span><div><span class="small-pill">示例收货信息</span><h2>${x.address.person}<small>${x.address.label}</small></h2><p>${x.address.address}</p><small>无需填写真实姓名、电话或地址</small></div>${icon('arrow',17)}</button><div class="surface checkout-product"><div class="seller-line">${icon('leaf',16)} ${esc(shopForProduct(x.product.id)?.name||'采购者资料待确认')} · 模拟</div>${miniProduct()}<div class="quantity-line"><span>数量</span>${stepper(x.quantity)}</div></div>${inventoryPanel(x.product,x.variant.id,x.quantity)}<div class="surface"><h2>费用明细 <span class="soft-label">均为模拟金额</span></h2><dl class="bill"><div><dt>商品小计</dt><dd>¥${money(x.subtotal)}</dd></div><div><dt>演示运费 <button class="inline-info" data-action="delivery" aria-label="运费说明">?</button></dt><dd>${x.shipping===null?'配送范围待确认':`¥${money(x.shipping)}`}</dd></div><div class="bill-total"><dt>合计</dt><dd>${x.total===null?'暂不可下单':`¥${money(x.total)}`}</dd></div></dl><p class="shipping-note">${!x.available?'商品暂未上架，请返回重新选择。':x.shipping===null?'该地区暂未开放演示下单，请切换甘肃或陕西的示例地址。':'模拟运费按每单固定计算，实际运费需与快递确认。'}</p></div><div class="demo-explainer">${icon('check',18)}<div><strong>放心体验，不会扣款</strong><p>${isCloudMode()?'登录后生成云端模拟订单，手机和电脑可同步查看，也可向后台提交模拟售后。':'点击后仅生成本浏览器中的模拟订单，之后可以体验售后申请。'}</p></div></div></section><div class="purchase-bar checkout-bar"><div><small>模拟合计</small><strong>${x.total===null?'待确认':`¥${money(x.total)}`}</strong></div><button class="primary" data-action="submit" ${x.total===null||submitting||!availability(x.product,x.variant.id,x.quantity).available?'disabled':''}>生成模拟订单</button></div>`;}
function isRefunded(o){return o.afterSale?.status==='resolved'&&o.afterSale.type==='refund';}
function isReceived(o){return o.receipt?.status==='received';}
function canReceive(o){return o?.status==='created'&&o.fulfillment?.status==='shipped'&&!isReceived(o)&&o.afterSale?.status!=='submitted'&&!isRefunded(o);}
function matchesFilter(o,filter=orderFilter){if(filter==='all')return true;if(filter==='aftersale')return !!o.afterSale;if(filter==='shipped')return o.status==='created'&&o.fulfillment?.status==='shipped'&&!isReceived(o)&&!isRefunded(o);if(filter==='received')return o.status==='created'&&isReceived(o)&&!isRefunded(o);if(filter==='waiting')return o.status==='created'&&!o.fulfillment&&!isRefunded(o);return o.status===filter;}
function orderStatus(o){return o.status==='cancelled'?'已取消（模拟）':isRefunded(o)?'模拟退款完成':o.afterSale?.status==='submitted'?'售后处理中（模拟）':isReceived(o)?'已完成（模拟）':o.fulfillment?.status==='shipped'?'待收货（模拟）':'待发货（模拟）';}
function receiveLink(o){return canReceive(o)?`<button class="primary small" data-action="receive-order" data-id="${esc(o.id)}">确认模拟收货</button>`:'';}
function orderTimeline(o){
  const steps=[{label:'模拟订单已生成',time:o.createdAt,done:true}];
  if(o.status==='cancelled')steps.push({label:'订单已取消',time:o.updatedAt,done:true});
  else{
    steps.push({label:o.fulfillment?'商家已模拟发货':'等待商家模拟发货',time:o.fulfillment?.shippedAt,done:!!o.fulfillment});
    steps.push({label:isReceived(o)?'买家已确认模拟收货':'买家确认收货',time:o.receipt?.receivedAt,done:isReceived(o)});
  }
  if(o.afterSale)steps.push({label:'售后：'+statusLabels[o.afterSale.status],time:o.afterSale.updatedAt,done:o.afterSale.status!=='submitted'});
  return `<section class="surface order-progress"><h2>订单进度</h2><ol class="service-timeline">${steps.map(step=>`<li class="${step.done?'done':'pending'}"><b>${esc(step.label)}</b><p>${step.time?date(step.time):'仅演示流程，不对应真实包裹'}</p></li>`).join('')}</ol><p class="info-note">确认收货不会扣款，也不会影响后续模拟售后申请。</p></section>`;
}
function afterLink(o){return o.status==='created'?`<button class="secondary small strong-border" data-action="aftersale" data-id="${o.id}">${o.afterSale?'查看售后':'申请售后'}</button>`:'';}
function orderList(){const visible=orders.filter(o=>matchesFilter(o));return `<section class="orders-page"><div class="orders-title"><div><span class="eyebrow">MY ORDERS & SERVICE</span><h1>我的订单</h1></div>${chatButton()}</div><p class="orders-note">从选购到售后，每一份好物都有记录。</p><div class="service-hub"><button data-action="filter" data-filter="aftersale">${icon('heart',23)}<span>我的售后<small>${orders.filter(o=>o.afterSale?.status==='submitted').length} 笔演示申请处理中</small></span>${icon('arrow',14)}</button><button data-action="support">${icon('chat',23)}<span>联系客服<small>商品咨询 / 订单帮助</small></span>${icon('arrow',14)}</button></div><div class="order-tabs" role="group" aria-label="订单筛选">${[['all','全部'],['waiting','待发货'],['shipped','待收货'],['received','已完成'],['aftersale','售后'],['cancelled','已取消']].map(([key,label])=>`<button data-action="filter" data-filter="${key}" class="${orderFilter===key?'active':''}">${label}<small>${orders.filter(o=>matchesFilter(o,key)).length}</small></button>`).join('')}</div>${visible.length?visible.map(o=>`<article class="order-card"><div class="order-card-header"><span>好物订单 · 模拟</span><b>${orderStatus(o)}</b></div>${miniProduct(o)}<div class="order-sum"><span>共 ${o.quantity} 份</span>合计 <strong>¥${money(o.total)}</strong><small>含模拟运费 ¥${money(o.shipping)}</small></div>${o.afterSale?`<button class="aftersale-strip" data-action="aftersale" data-id="${o.id}">${icon('heart',15)} ${statusLabels[o.afterSale.status]} · ${typeLabels[o.afterSale.type]} ${icon('arrow',13)}</button>`:''}<div class="order-actions"><button class="secondary small" data-action="order-detail" data-id="${o.id}">订单详情</button>${receiveLink(o)}${afterLink(o)}<button class="secondary small" data-action="support" data-id="${o.id}">客服</button></div></article>`).join(''):emptyState(orderFilter==='aftersale'?'售后申请会在这里记录':'第一份家乡味，等你来选',orderFilter==='aftersale'?'先在对应订单点击“申请售后”，即可体验。':'选一款好物生成订单，再试试订单服务。')}<div class="local-info"><p>${isCloudMode()?'订单与售后保存在云端，同一账号可跨设备查看。<br>云端模式不会读取或上传以前的本机演示订单。':persistence?'订单与售后仅保存在本浏览器，刷新后仍可查看。<br>无真实交易，不会同步其他设备。':'本浏览器无法保存，页面关闭后记录会消失。'}</p>${!isCloudMode()&&orders.length?'<button class="text-link danger-link" data-action="clear-orders">清空演示订单与售后</button>':''}</div></section>`;}
function missingOrder(){return `${title('订单服务','orders')}${emptyState('这笔演示订单不存在',isCloudMode()?'请确认登录的是下单账号，或点击刷新订单重新读取。':'可能已清空，或在其他浏览器中创建。')}`;}
function orderDetail(id){const o=orders.find(o=>o.id===id);if(!o)return missingOrder();const address=ADDRESSES.find(a=>a.id===o.address);return `${title('演示订单详情','orders',chatButton(id))}<section class="order-detail-page"><div class="success-state ${o.status==='cancelled'?'cancelled':''}"><span class="success-icon">${icon(o.status==='created'?'check':'close',30)}</span><h1>${orderStatus(o)}</h1><p>没有真实付款和发货，可继续体验订单服务。</p><span class="success-stamp">DEMO ONLY · 无真实交易</span></div>${experience.orderShoppingNotice?.(o.id)||''}${orderTimeline(o)}${o.stockRelease?`<div class="surface stock-release"><strong>${o.stockRelease.status==='review'?'库存回补待商家核对':'库存已回补'}</strong><p>${esc(o.stockRelease.message)}</p></div>`:''}<div class="surface">${miniProduct(o)}<dl class="bill"><div><dt>商品小计</dt><dd>¥${money(o.subtotal)}</dd></div><div><dt>演示运费</dt><dd>¥${money(o.shipping)}</dd></div><div class="bill-total"><dt>模拟合计</dt><dd>¥${money(o.total)}</dd></div><div><dt>实际扣款</dt><dd>¥0.00</dd></div></dl></div><div class="order-service-card"><div>${icon('heart',24)}<h2>这份订单的售后</h2><p>破损、规格或配送问题，都从这里开始。</p></div><div>${afterLink(o)}<button class="secondary small" data-action="support" data-id="${id}">联系订单客服</button></div>${o.status==='cancelled'?'<p class="info-note">已取消的演示订单不再申请售后。</p>':''}</div><div class="surface order-meta"><h2>订单信息</h2><dl><div><dt>演示编号</dt><dd>${o.id}</dd></div><div><dt>生成时间</dt><dd>${date(o.createdAt)}</dd></div><div><dt>示例收货</dt><dd>${address.person}<br>${address.address}</dd></div><div><dt>支付状态</dt><dd>未接入支付，无需付款</dd></div><div><dt>物流状态</dt><dd>${o.fulfillment?.status==='shipped'?`已模拟发货 · ${esc(o.fulfillment.carrier)}<br>${esc(o.fulfillment.tracking)}<br>${date(o.fulfillment.shippedAt)}${isReceived(o)?`<br>已确认模拟收货 · ${date(o.receipt.receivedAt)}`:''}<br>没有真实包裹或物流查询`:'未发货，无真实物流'}</dd></div></dl></div><div class="detail-actions">${receiveLink(o)}<button class="primary" data-action="go-home">继续逛好物</button><button class="secondary" data-action="go-orders">查看全部订单</button>${o.status==='created'&&!o.fulfillment&&o.afterSale?.status!=='submitted'&&!(o.afterSale?.status==='resolved'&&o.afterSale.type==='refund')?`<button class="text-link danger-link" data-action="cancel-order" data-id="${o.id}">取消这笔演示订单</button>`:''}</div></section>`;}
function date(value){return new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'});}
function walkthrough(){
  const steps=[
    ['1. 挑规格，加入购物车','从景泰产区进入采购者店铺，打开苹果等好物详情，核对当前可售份数，选好规格再加入购物车。','regions','去逛产区'],
    ['2. 生成一笔模拟订单','购物车点“去结算”，选择示例收货地区，再点“生成模拟订单”。记住订单编号，后面按编号查找。','cart','打开购物车'],
    ['3. 到后台模拟发货','打开后台后点“订单管理”，刷新并找到刚才的订单。打开详情，核对预填的演示物流与 DEMO- 单号，点“确认模拟发货”。',null,'打开商家后台'],
    ['4. 回到买家端确认收货','回到“我的订单”，点顶部“刷新”。在“待收货”找到该订单，点“确认模拟收货”并确认，订单会显示“已完成”。','orders','打开我的订单'],
    ['5. 从这笔订单申请售后','点“申请售后”，选择模拟退款或补发、问题类型并填写模拟描述，再点“提交模拟售后申请”。确认收货后仍可申请。','orders','申请订单售后'],
    ['6. 到后台处理售后','后台点“售后管理”并刷新，找到同一订单，填写处理意见，再点“确认模拟退款完成”或“确认模拟补发完成”。',null,'打开商家后台'],
    ['7. 返回买家端看处理结果','回到“我的订单”并刷新，点该订单的“查看售后”，核对处理进度和商家处理意见。','orders','查看售后结果']
  ];
  const entry=isCloudMode()?'手机和电脑登录同一账号，购物资料、库存、订单和售后可同步。已有管理员账号可同时体验买家下单与后台处理；普通买家不会获得商家权限。':'本机静态演示只在同一浏览器中保存，跨设备同步需打开云端演示。';
  return `${title('完整体验指南','mine')}<section class="checkout-page"><div class="surface"><h2>用手机走完一笔模拟订单</h2><p class="body-copy">商品、价格和物流均为模拟，全程不用付款，也不会寄出包裹。</p><p class="body-copy">${entry}</p></div><div class="surface"><ol class="service-timeline">${steps.map(([heading,copy,path,label])=>`<li class="done"><b>${heading}</b><p>${copy}</p>${path?`<button class="text-link" data-action="navigate" data-route="${path}">${label} ${icon('arrow',15)}</button>`:`<a class="text-link" href="admin.html">${label} ${icon('arrow',15)}</a>`}</li>`).join('')}</ol></div><div class="surface"><h2>切换页面后，先刷新再核对</h2><p class="body-copy">按同一订单编号查看，发货、收货或售后后，在另一端点顶部“刷新”读取最新状态。库存以下单时校验为准，缺货时由采购者在后台“库存批次”补充模拟余量；刷新不会重置已扣减库存。</p><button class="text-link" data-action="navigate" data-route="mine">返回我的</button></div></section>`;
}
function afterSale(id){const o=orders.find(o=>o.id===id);if(!o)return missingOrder();const a=o.afterSale;const showForm=!a||route()[2]==='new';if(showForm){if(o.status!=='created')return `${title('订单售后',`order/${id}`)}${emptyState('这笔订单已取消','已取消的演示订单不能申请售后。')}`;if(a?.status==='submitted')return afterSaleProgress(o);if(a?.status==='resolved'&&a.type==='refund')return afterSaleProgress(o);if(afterDraft.orderId!==id)afterDraft={orderId:id,type:'refund',reason:'',description:'',hasEvidence:false,expectedVersion:o.version};return `${title('申请售后',`order/${id}`,chatButton(id))}<section class="after-page"><div class="after-intro"><span class="eyebrow">我们关心每一份好物</span><h1>告诉我们，哪里不合适？</h1><p>关联这笔订单，模拟一次售后申请。</p></div><div class="surface">${miniProduct(o)}</div><form id="aftersale-form" data-order="${id}"><div class="surface"><fieldset class="after-fieldset"><legend>期望处理方式</legend><div class="choice-grid">${Object.entries(typeLabels).map(([key,label])=>`<label class="radio-choice"><input type="radio" name="type" value="${key}" ${afterDraft.type===key?'checked':''} required><span>${label}</span></label>`).join('')}</div></fieldset><label class="field-label" for="reason">遇到了什么问题？<span>必选</span></label><select name="reason" id="reason" required><option value="">请选择问题类型</option>${Object.entries(reasonLabels).map(([key,label])=>`<option value="${key}" ${afterDraft.reason===key?'selected':''}>${label}</option>`).join('')}</select><label class="field-label" for="description">补充描述<span>选填 · 最多 300 字</span></label><textarea id="description" name="description" rows="4" maxlength="300" placeholder="例如：外包装有破损，想核对商品规格。仅填写模拟问题，不填写电话、地址等个人信息。">${esc(afterDraft.description)}</textarea><div class="evidence-label"><span>问题凭证 <small>演示图片</small></span><button type="button" class="text-link" data-action="toggle-evidence">${afterDraft.hasEvidence?'移除示例':'添加示例凭证'}</button></div>${afterDraft.hasEvidence?`<div class="evidence-preview"><img src="${esc(imageFor(o))}" alt="示例凭证，非真实问题照片"><p>已添加一张商品示意图。<br>仅演示凭证位置，非真实损坏证据。</p></div>`:'<p class="info-note">正式版本可上传开箱、外包装和问题部位照片。本次不用上传真实图片。</p>'}</div><div class="surface"><div class="section-line"><h2>关联模拟金额</h2><strong class="after-amount">¥${money(o.total)}</strong></div><p class="info-note">包含模拟运费 ¥${money(o.shipping)}。原订单未付款，实际退款为 ¥0.00；不会真实补发。</p></div><p id="form-error" role="alert" class="form-error"></p><div class="after-submit"><button type="submit" class="primary wide">提交模拟售后申请</button><p>${isCloudMode()?'申请将保存到云端，在管理后台模拟处理。':'记录只保存在本浏览器，不会向商家发送。'}</p></div></form></section>`;}return afterSaleProgress(o);}
function afterSaleProgress(o){const a=o.afterSale;if(!a)return missingOrder();const id=o.id;return `${title('售后进度',`order/${id}`,chatButton(id))}<section class="after-page"><div class="after-status"><span>${icon(a.status==='resolved'?'check':a.status==='withdrawn'?'close':'heart',30)}</span><h1>${statusLabels[a.status]}</h1><p>${a.status==='submitted'?(isCloudMode()?'云端申请已记录，可在管理后台模拟处理。':'演示申请已记录，尚未发送给真实商家。'):a.status==='resolved'?'已模拟完成处理，实际退款为 0 元，无真实补发。':'这笔演示申请已撤回，可以重新发起。'}</p></div><div class="surface">${miniProduct(o)}<dl class="spec-list"><div><dt>服务类型</dt><dd>${typeLabels[a.type]}</dd></div><div><dt>问题类型</dt><dd>${reasonLabels[a.reason]}</dd></div><div><dt>补充描述</dt><dd>${a.description?esc(a.description):'未填写'}</dd></div><div><dt>示例凭证</dt><dd>${a.hasEvidence?'已添加商品示意图':'未添加'}</dd></div><div><dt>关联金额</dt><dd>¥${money(o.total)}（模拟）</dd></div><div><dt>申请编号</dt><dd>${esc(a.id)}</dd></div>${a.merchantReply?`<div><dt>商家处理意见</dt><dd>${esc(a.merchantReply)}</dd></div>`:''}</dl></div><div class="surface"><h2>处理进度</h2><ol class="service-timeline"><li class="done"><b>模拟申请已记录</b><p>${date(a.createdAt)}</p></li><li class="${a.status==='submitted'?'pending':'done'}"><b>${a.status==='submitted'?'等待演示处理':a.status==='resolved'?'模拟处理完成':'申请已撤回'}</b><p>${a.status==='submitted'?'可在管理后台处理这笔演示申请；没有真实客服正在处理。':date(a.updatedAt)}</p></li></ol></div><div class="after-submit">${a.status==='submitted'?`<p class="info-note">模拟申请可在商家管理后台查看和处理。</p><div class="after-secondary"><button class="secondary" data-action="support" data-id="${id}">咨询客服</button><button class="secondary" data-action="withdraw-after" data-id="${id}">撤回演示申请</button></div>`:`<button class="primary wide" data-action="go-orders">返回我的订单</button>${o.status==='created'&&!(a.status==='resolved'&&a.type==='refund')?`<button class="text-link" data-action="new-after" data-id="${id}">重新体验售后申请</button>`:''}`}<p>此流程不产生真实退款、退货或补发。</p></div>${afterSaleHistory(o)}</section>`;}
function afterSaleHistory(order){const history=order.afterSaleHistory;if(!Array.isArray(history)||!history.length)return '';return `<div class="surface after-history"><h2>售后历史记录</h2><ol>${history.map(item=>`<li><strong>${esc(statusLabels[item.status]||item.status)} · ${esc(typeLabels[item.type]||item.type)}</strong><span>${date(item.updatedAt||item.createdAt)}</span><p>${esc(item.description||'未填写补充描述')}${item.merchantReply?`<br>处理意见：${esc(item.merchantReply)}`:''}</p></li>`).join('')}</ol></div>`;}
function support(id){const o=orders.find(o=>o.id===id);return `${title('客服与帮助',o?`order/${id}`:'orders')}<section class="support-page"><div class="support-profile"><span>${icon('chat',26)}</span><div><h1>陇上鲜集 · 演示客服</h1><p>本地自动回复，没有接入人工客服</p></div></div>${o?`<div class="surface linked-order"><span class="eyebrow">正在咨询这笔演示订单</span>${miniProduct(o)}<button class="text-link" data-action="aftersale" data-id="${o.id}">进入该订单售后 ${icon('arrow',13)}</button></div>`:''}<div class="surface"><h2>第一次使用？</h2><p class="body-copy">按步骤体验选购、发货、确认收货和售后。</p><button class="text-link" data-action="navigate" data-route="walkthrough">查看完整体验指南</button></div><div class="support-greeting"><span class="mini-logo">陇</span><p>你好，选好物之前想了解什么？<br>可以点下面的问题，也可以输入一句模拟咨询。</p></div><div class="faq-list">${FAQs.map((f,i)=>`<button data-action="faq" data-faq="${i}">${f.q}${icon('arrow',14)}</button>`).join('')}</div><div class="chat-log" aria-live="polite">${chat.map(m=>`<div class="chat-message ${m.role}">${m.role==='assistant'?'<small>演示自动回复</small>':''}<p>${esc(m.text)}</p></div>`).join('')}</div><div class="support-bottom-note">咨询内容仅在当前页面会话中显示，不会发送给商家。<br>请勿输入姓名、电话或其他个人信息。</div></section><form class="chat-compose" id="chat-form"><input name="message" aria-label="输入模拟咨询" maxlength="300" placeholder="输入模拟问题…" autocomplete="off" required><button type="submit" class="primary">发送</button></form>`;}
function render(preserve=false){renderSyncNotice();if(!catalogReady&&!['orders','order','aftersale','mine','support'].includes(route()[0])){app.innerHTML=`<section class="empty-orders"><div class="empty-illustration">${icon('leaf',52)}</div><h2>商品资料暂时无法读取</h2><p>${esc(catalogLoadError||'请稍后重新读取。')}</p><button class="primary" data-action="refresh-cloud">重新读取</button></section>`;tabbar.hidden=true;return;}const scroll=app.scrollTop;const [page,id]=route();experience.beforeRender(page,id);journey.beforeRender?.(page,id);const views={home,origin,product:()=>product(id||selection.productId),checkout,orders:orderList,order:()=>orderDetail(id),aftersale:()=>afterSale(id),support:()=>support(id),walkthrough};const gated=['orders','order','aftersale','checkout','cart-checkout'].includes(page)?cloudOrderGate(!['checkout','cart-checkout'].includes(page)):'';app.innerHTML=gated||((['orders','order','aftersale','mine'].includes(page)?cloudOrderNotice():'')+(journey.routes[page]?journey.routes[page](id):experience.routes[page]?experience.routes[page](id):views[page]?views[page]():emptyState('页面暂未找到','可以从首页重新选择产区、采购者或商品。')));try{sessionStorage.setItem('longshang-demo-selection-v2',JSON.stringify(selection));}catch{}app.dataset.page=page;tabbar.innerHTML=tabs(page);tabbar.hidden=!['home','specialties','regions','region','shops','shop','search','origin','cart','mine','orders'].includes(page);app.scrollTop=preserve?scroll:0;document.title=`${({home:'逛好物',regions:'逛产区',region:'产区详情',shops:'采购者店铺',shop:'采购者店铺',search:'搜索好物',specialties:'特产馆',guide:'特产详情',collection:'好物专题',cart:'购物车','cart-checkout':'确认订单',mine:'我的',preferences:'使用设置',walkthrough:'完整体验指南',favorites:'我的收藏',history:'浏览足迹',origin:'看产地',product:'好物详情',checkout:'确认订单',orders:'我的订单',order:'订单详情',aftersale:'订单售后',support:'客服与帮助'})[page]||'逛好物'} · 陇上鲜集演示`;app.querySelectorAll('img').forEach(img=>{img.addEventListener('error',()=>{if(img.dataset.failed)return;img.dataset.failed='1';if(img.dataset.orderFallback&&img.getAttribute('src')!==img.dataset.orderFallback){img.src=img.dataset.orderFallback;return;}img.alt='图片暂时无法读取';const note=document.createElement('span');note.className='media-load-error';note.textContent='图片读取失败，请刷新重试';note.setAttribute('role','status');img.insertAdjacentElement('afterend',note);});});app.querySelectorAll('video').forEach(v=>{v.addEventListener('error',()=>{const note=v.parentElement.querySelector('.video-error');if(note)note.hidden=false;});v.querySelector('source')?.addEventListener('error',()=>{const note=v.parentElement.querySelector('.video-error');if(note)note.hidden=false;});});}
function showModal(heading,body){if(!modalRoot.children.length)modalFocus=document.activeElement;modalRoot.innerHTML=`<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-handle"></div><div class="modal-heading"><h2 id="modal-title">${heading}</h2><button class="icon-button" data-action="close-modal" aria-label="关闭弹窗">${icon('close')}</button></div>${body}</section></div>`;document.querySelector('.workspace').inert=true;modalRoot.querySelector('button')?.focus();}
function closeModal(){modalRoot.innerHTML='';document.querySelector('.workspace').inert=false;if(modalFocus?.isConnected)modalFocus.focus();modalFocus=null;}
function about(){showModal('把家乡的好物，慢慢讲清楚',`<div class="modal-copy"><p>这是小程序界面的浏览器演示 V1.0，包含买家商城与管理后台，可体验商品编辑、素材替换、模拟发货和售后处理。</p><ul><li>商品、价格、规格与订单均为模拟。</li><li>不收款、不发货，不提交真实售后申请。</li><li>${isCloudMode()?'商品、图片、视频、订单和售后统一保存到云端；同一账号可跨设备查看订单。购物车、收藏和足迹仍保存在本浏览器。':'商品、素材、订单、售后、购物车和收藏保存在本浏览器。'}客服为本地自动回复。</li></ul><p class="tiny">未附带真实采摘视频，可在后台上传有权使用的模拟素材。商品图片为图库示意，不代表实际供货。</p><p class="tiny">枸杞图片：<a href="https://commons.wikimedia.org/wiki/File:Goji_dried_berries.jpg" target="_blank" rel="noopener">Myrabella / Wikimedia Commons</a>，已裁剪、缩放；修改图继续采用 <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC BY-SA 3.0</a>。</p><div class="credit-links"><a href="assets/credits.json" target="_blank" rel="noopener">苹果 / 果园图源与许可 ↗</a><a href="assets/media-products-credit.json" target="_blank" rel="noopener">其他商品图片署名与许可 ↗</a><a href="assets/media-video-credit.json" target="_blank" rel="noopener">历史演示视频来源说明 ↗</a></div><a class="merchant-entry" href="admin.html#/dashboard">进入管理后台演示 ${icon('arrow',16)}</a><button class="primary wide" data-action="close-modal">继续体验</button></div>`);}
function delivery(){showModal('配送与运费演示',`<div class="modal-copy"><p>先用示例地址，看看运费如何影响订单合计。</p><div class="shipping-table"><div><span>甘肃省内 · 示例</span><b>¥6.00 / 单</b></div><div><span>陕西地区 · 示例</span><b>¥10.00 / 单</b></div><div><span>其他地区</span><b>待确认配送</b></div></div><p class="tiny">仅为界面演示，不是快递报价。正式售卖前需确认首重、续重、包装和时效。当前不会真实发货。</p><button class="primary wide" data-action="close-modal">明白了</button></div>`);}
function chooseAddress(){showModal('选择示例收货地区',`<div class="modal-copy"><p>不需要输入真实个人信息。</p><div class="address-options">${ADDRESSES.map(a=>`<button data-action="select-address" data-address="${a.id}" class="${selection.address===a.id?'selected':''}"><div><strong>${a.label}</strong><p>${a.address}</p><small>${a.shipping===null?'暂不支持演示下单':`模拟运费 ¥${money(a.shipping)} / 单`}</small></div><span>${selection.address===a.id?icon('check'):''}</span></button>`).join('')}</div></div>`);}
function captureAfterDraft(){const form=document.querySelector('#aftersale-form');if(!form)return;const data=new FormData(form);afterDraft={...afterDraft,orderId:form.dataset.order,type:data.get('type')||'refund',reason:data.get('reason')||'',description:String(data.get('description')||'')};}
async function changeAfter(id,status,expectedVersion){if(isCloudMode()){if(status!=='withdrawn'||submitting)return;submitting=true;try{const order=await mutateCloudOrder(id,'aftersale/withdraw',{expectedVersion});acceptCloudOrder(order);closeModal();render();toast('云端售后申请已撤回');}catch(error){toast(error.message);}finally{submitting=false;}return;}refreshStoredOrders();const at=orders.findIndex(o=>o.id===id);if(at===-1){nav('orders');return;}try{orders[at]=updateAfterSale(orders[at],status);persist();closeModal();render();toast(status==='resolved'?'已模拟完成处理，实际退款 0 元':'演示申请已撤回');}catch(e){toast(e.message);}}
function sendChat(message,answer){chat.push({role:'user',text:message},{role:'assistant',text:answer});if(chat.length>40)chat.splice(0,chat.length-40);render(true);app.querySelector('.chat-log')?.lastElementChild?.scrollIntoView({block:'nearest',behavior:'smooth'});}
function answerFor(text){const topic=/售后|坏|损|退款|退货/.test(text)?'aftersale':/运费|邮费|包邮|配送|送到/.test(text)?'shipping':/发货|快递|物流|什么时候|几天/.test(text)?'dispatch':/枸杞/.test(text)?'goji':/苹果|大小|果径|规格/.test(text)?'size':/同步|手机|电脑|收藏|购物车|登录/.test(text)?'sync':/收货|流程|怎么用|体验/.test(text)?'flow':'';return FAQs.find(f=>f.id===topic)?.a||'这是本地演示客服，还没有人工接入。可以点上面的常见问题；订单问题请从对应订单进入售后，或查看完整体验指南。';}
function newId(prefix){return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;}
const experience=createExperience({selection,nav,route,toast,render,productCard,title,chatButton,miniProduct,showModal,closeModal,newId,
  getOrders:()=>orders, availability, inventoryFor, shopForProduct, getStorefrontState, accountPanel, cloudOrderNotice, createCloudOrder:createBuyerCloudOrder,
  addOrder:order=>{if(isCloudMode())throw new Error('云端订单必须由服务端生成。');refreshStoredOrders();orders.unshift(order);orders=orders.slice(0,100);persist();orderFilter='all';},
  openOrders:filter=>{orderFilter=filter;nav('orders');},
  updateTabs:()=>{tabbar.innerHTML=tabs(route()[0]);},
  addressLabel:()=>ADDRESSES.find(a=>a.id===selection.address).label,
  refreshBuyerShopping:()=>syncBuyerShopping(true),cartCleanupConfirmed
});
const journey=createJourney({catalog:()=>CATALOG,getProduct,productCard,title,nav,render,availability,imageFor,videoFor,videoBlock,backRoute});
let pendingJump='';
document.addEventListener('click',async event=>{if(event.target.classList.contains('modal-overlay')){closeModal();return;}const button=event.target.closest('[data-action]');if(!button||button.disabled)return;const d=button.dataset;if(await journey.handleClick(d,button))return;if(await experience.handleClick(d,button))return;switch(d.action){
case 'go-home':nav('home');break;
case 'go-orders':orderFilter='all';nav('orders');break;
case 'navigate':nav(d.route);break;
case 'back':nav(d.route,{restore:true});break;
case 'origin':{if(route()[0]==='product'){const region=regionForProduct(selection.productId);nav(region?`region/${region.id}`:'regions');}else nav('origin');break;}
case 'refresh-cloud':await syncBuyerCatalog(true);if(isCloudMode()){await refreshBuyerOrders(true);await syncBuyerShopping(true);}break;
case 'refresh-orders':await refreshBuyerOrders(true);break;
case 'retry-pending-order':{const pending=getPendingCloudOrder();if(!pending||submitting)break;submitting=true;button.disabled=true;try{const order=await sendPendingCloudOrder(pending);if(pending.fromCart)await experience.removeOrderedItems(pending.request.items,order.id,pending.userId);if(pending.userId!==getCloudState().session?.user?.id)throw new Error('登录账号已变化，请返回原账号查看已生成的订单。');nav(`order/${order.id}`);toast('已确认云端订单，不会重复创建');}catch(error){toast(error.message);}finally{submitting=false;button.disabled=false;render(true);}break;}
case 'origin-category':originCategory=d.category;render(true);break;
case 'view-product':{const p=getProduct(d.product||'jingtai-apple');if(!p)return;const current=route();const source=current[0]==='product'?productBack(current[1]||selection.productId):routeKey();productSources.set(p.id,source);if(productSources.size>100)productSources.delete(productSources.keys().next().value);pendingJump=d.section||'';if(selection.productId!==p.id){selection.productId=p.id;selection.variant='small';selection.quantity=1;}const same=location.hash===`#/product/${p.id}`;nav(`product/${p.id}`);if(same&&pendingJump){document.getElementById(pendingJump)?.scrollIntoView({block:'start'});pendingJump='';}break;}
case 'jump':document.getElementById(d.section)?.scrollIntoView({block:'start',behavior:'smooth'});break;
case 'about':about();break;
case 'close-modal':closeModal();break;
case 'category':category=d.category;render(true);break;
case 'variant':selection.variant=d.variant;render(true);break;
case 'quantity':selection.quantity=Math.min(10,Math.max(1,selection.quantity+Number(d.delta)));render(true);break;
case 'checkout':{const stock=availability(getProduct(selection.productId),selection.variant,selection.quantity);if(!stock.available){toast(stock.message);break;}nav('checkout');break;}
case 'delivery':delivery();break;
case 'address':chooseAddress();break;
case 'select-address':{if(!ADDRESSES.some(a=>a.id===d.address))break;button.disabled=true;try{if(isCloudMode()){await mutateBuyerState(state=>({...state,preferredAddress:d.address}));experience.applyBuyerState();}selection.address=d.address;closeModal();render(true);toast(isCloudMode()?'示例收货地区已同步到云端':'已选择示例收货地区');}catch(error){toast(error.message);}finally{button.disabled=false;}break;}
case 'filter':orderFilter=d.filter;render();break;
case 'order-detail':nav(`order/${d.id}`);break;
case 'support':nav(d.id?`support/${d.id}`:'support');break;
case 'aftersale':nav(`aftersale/${d.id}`);break;
case 'new-after':afterDraft={orderId:d.id,type:'refund',reason:'',description:'',hasEvidence:false,expectedVersion:orders.find(order=>order.id===d.id)?.version};nav(`aftersale/${d.id}/new`);break;
case 'toggle-evidence':captureAfterDraft();afterDraft.hasEvidence=!afterDraft.hasEvidence;render(true);break;
case 'resolve-after':if(isCloudMode()){toast('请由商家管理后台处理售后。');break;}showModal('模拟完成这笔售后？',`<div class="modal-copy"><p>仅将演示进度改为“已完成”。不会扣款、退款或真实补发商品。</p><div class="modal-actions"><button class="secondary" data-action="close-modal">返回</button><button class="primary" data-action="confirm-resolve" data-id="${d.id}">模拟完成</button></div></div>`);break;
case 'confirm-resolve':if(isCloudMode())break;changeAfter(d.id,'resolved');break;
case 'withdraw-after':showModal('撤回演示售后申请？',`<div class="modal-copy"><p>申请会标记为已撤回，仍可在订单中查看。不会产生真实退款或补发。</p><div class="modal-actions"><button class="secondary" data-action="close-modal">先保留</button><button class="primary" data-action="confirm-withdraw" data-id="${d.id}" data-version="${orders.find(order=>order.id===d.id)?.version||0}">确认撤回</button></div></div>`);break;
case 'confirm-withdraw':await changeAfter(d.id,'withdrawn',Number(d.version));break;
case 'faq':{const f=FAQs[Number(d.faq)];if(f)sendChat(f.q,f.a);break;}
case 'submit':{if(submitting||route()[0]!=='checkout')return;submitting=true;button.disabled=true;try{refreshStoredOrders();const o=isCloudMode()?await createBuyerCloudOrder(displayedCheckout.items,displayedCheckout.address,displayedCheckout.total,displayedCheckout.prices,displayedCheckout.batches):createOrder(selection,newId('DEMO'));if(!isCloudMode()){orders.unshift(o);orders=orders.slice(0,100);persist();}orderFilter='all';nav(`order/${o.id}`);}catch(e){toast(e.message);}finally{submitting=false;if(route()[0]==='checkout')render(true);}break;}
case 'receive-order':{const order=orders.find(value=>value.id===d.id);if(!canReceive(order)){toast('请先刷新订单，只有待收货且没有待处理售后的订单才能确认。');break;}showModal('确认这笔模拟订单已收货？',`<div class="modal-copy"><p>这是演示流程，没有真实包裹，也不会扣款。确认后仍可从订单申请模拟售后。</p><div class="modal-actions"><button class="secondary" data-action="close-modal">暂不确认</button><button class="primary" data-action="confirm-receive" data-id="${esc(order.id)}" data-version="${order.version||0}">确认模拟收货</button></div></div>`);break;}
case 'confirm-receive':{if(submitting)break;submitting=true;button.disabled=true;try{if(isCloudMode()){const order=await mutateCloudOrder(d.id,'receive',{expectedVersion:Number(d.version)});acceptCloudOrder(order);}else{refreshStoredOrders();const order=orders.find(item=>item.id===d.id);const updated=receiveOrder(order);orders=orders.map(item=>item.id===d.id?updated:item);persist();}closeModal();render(true);toast('已确认模拟收货，订单已完成；仍可申请售后。');}catch(error){toast(error.message);if(error.status===409){closeModal();await refreshBuyerOrders(true);}}finally{submitting=false;button.disabled=false;}break;}
case 'cancel-order':showModal('取消这笔演示订单？',`<div class="modal-copy"><p>不产生退款，不通知供货者。取消后仍可查看订单记录。</p><div class="modal-actions"><button class="secondary" data-action="close-modal">保留订单</button><button class="primary" data-action="confirm-cancel" data-id="${d.id}" data-version="${orders.find(order=>order.id===d.id)?.version||0}">确认取消</button></div></div>`);break;
case 'confirm-cancel':{if(isCloudMode()){if(submitting)break;submitting=true;button.disabled=true;try{const order=await mutateCloudOrder(d.id,'cancel',{expectedVersion:Number(d.version)});acceptCloudOrder(order);await refreshBuyerInventory();closeModal();render();toast(order.stockRelease?.message||'云端模拟订单已取消');}catch(error){toast(error.message);}finally{submitting=false;button.disabled=false;}break;}refreshStoredOrders();const o=orders.find(o=>o.id===d.id);if(o?.fulfillment){closeModal();toast('已模拟发货的订单请通过售后处理。');return;}if(o?.afterSale?.status==='submitted'){closeModal();toast('请先撤回正在进行的演示售后。');return;}if(o){o.status='cancelled';persist();}closeModal();render();toast('演示订单已取消');break;}
case 'clear-orders':if(isCloudMode())break;showModal('清空演示订单与售后？','<div class="modal-copy"><p>将清空本浏览器中的模拟订单及关联售后记录，之后可重新体验。</p><div class="modal-actions"><button class="secondary" data-action="close-modal">先保留</button><button class="primary" data-action="confirm-clear">确认清空</button></div></div>');break;
case 'confirm-clear':if(isCloudMode())break;orders=[];persist();afterDraft={orderId:'',type:'refund',reason:'',description:'',hasEvidence:false};orderFilter='all';nav('orders');toast('订单与售后演示记录已清空');break;
}});
document.addEventListener('input',event=>{if(event.target.closest('#aftersale-form'))captureAfterDraft();});
document.addEventListener('change',async event=>{if(await experience.handleChange(event.target))return;if(event.target.closest('#aftersale-form'))captureAfterDraft();});
document.addEventListener('submit',async event=>{if(journey.handleSubmit(event))return;if(experience.handleSubmit(event))return;if(event.target.id==='aftersale-form'){event.preventDefault();if(submitting)return;captureAfterDraft();const form=event.target;const submit=form.querySelector('[type=submit]');submitting=true;submit.disabled=true;try{refreshStoredOrders();const at=orders.findIndex(o=>o.id===afterDraft.orderId);if(at===-1)throw new Error('这笔订单已被清空，请返回订单列表。');if(isCloudMode()){const order=await mutateCloudOrder(afterDraft.orderId,'aftersale',{expectedVersion:afterDraft.expectedVersion,type:afterDraft.type,reason:afterDraft.reason,description:afterDraft.description,hasEvidence:afterDraft.hasEvidence});acceptCloudOrder(order);}else{orders[at]=createAfterSale(orders[at],afterDraft,newId('AFTER'));persist();}nav(`aftersale/${afterDraft.orderId}`);toast('模拟申请已记录，可查看进度');}catch(e){form.querySelector('#form-error').textContent=e.message;submit.disabled=false;}finally{submitting=false;}}if(event.target.id==='chat-form'){event.preventDefault();const message=String(new FormData(event.target).get('message')||'').trim().slice(0,300);if(message)sendChat(message,answerFor(message));}});
document.addEventListener('keydown',event=>{const modal=modalRoot.querySelector('.modal');if(!modal)return;if(event.key==='Escape')closeModal();if(event.key==='Tab'){const list=[...modal.querySelectorAll('button:not([disabled]),a[href],input,[tabindex="0"]')];if(event.shiftKey&&document.activeElement===list[0]){event.preventDefault();list.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===list.at(-1)){event.preventDefault();list[0]?.focus();}}});
window.addEventListener('hashchange',event=>{const destination=routeKey();if(!navigationIntent&&event?.oldURL){try{const previous=new URL(event.oldURL).hash.slice(2)||'home';scrollPositions.set(previous,app.scrollTop);}catch{}}const restore=navigationIntent?navigationIntent.restore:scrollPositions.has(destination);navigationIntent=null;closeModal();render();if(restore)app.scrollTop=scrollPositions.get(destination)||0;if(isCloudMode()&&['orders','order','aftersale','mine','cart','favorites','history','preferences'].includes(route()[0]))void refreshBuyerOrders().then(()=>syncBuyerShopping());app.focus({preventScroll:true});if(pendingJump){document.getElementById(pendingJump)?.scrollIntoView({block:'start'});pendingJump='';}});
window.addEventListener('storage',async event=>{if((event.key===CATALOG_KEY||event.key===null)&&!isCloudMode()){captureAfterDraft();try{readCatalog();const issues=await hydrateMedia(CATALOG);await refreshStorefront({products:CATALOG});refreshStoredOrders();await experience.refresh({refresh:false});render(true);toast(issues?.[0]||'商品资料已更新，请核对当前规格和价格');}catch(error){toast(error.message);}return;}experience.storage(event);if(event.key===STORAGE_KEY&&!isCloudMode()){captureAfterDraft();refreshStoredOrders();render(true);}});
function renderSyncNotice(){
  const node=document.querySelector('#catalog-sync');if(!node)return;
  const cloud=getCloudState();
  const time=cloud.lastSyncedAt?new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}).format(new Date(cloud.lastSyncedAt)):'';
  const label=catalogRefreshing?'正在读取商品…':catalogLoadError?'同步失败 · 点击重试':catalogPending?'商品有更新 · 点击查看':isCloudMode()?`云端商品${time?' · '+time+'已同步':''}`:'本机商品演示';
  node.innerHTML=`<span>${esc(label)}</span><button data-action="refresh-cloud" ${catalogRefreshing?'disabled':''}>${catalogRefreshing?'读取中':'刷新'}</button>`;
  node.classList.toggle('sync-error',!!catalogLoadError);
}
async function syncBuyerCatalog(manual=false){
  if(catalogRefreshing)return;
  catalogRefreshing=true;renderSyncNotice();
  const before=JSON.stringify(CATALOG),beforeInventory=inventoryFingerprint(),beforeDirectory=JSON.stringify(getStorefrontState());
  try{
    if(!catalogReady){await initializeCloudMode({force:true});}
    await refreshCatalog();await hydrateMedia(CATALOG);await refreshBuyerInventory();await refreshStorefront({products:CATALOG});
    catalogLoadError='';const first=!catalogReady;catalogReady=true;
    const changed=before!==JSON.stringify(CATALOG)||beforeInventory!==inventoryFingerprint()||beforeDirectory!==JSON.stringify(getStorefrontState());
    const busy=document.activeElement?.matches('input,textarea,select')||[...app.querySelectorAll('video')].some(video=>!video.paused);
    if(first||manual||((changed||catalogPending)&&!busy)){
      captureAfterDraft();await experience.refresh({refresh:false});catalogPending=false;render(true);
    }else if(changed)catalogPending=true;
    if(manual)toast(isCloudMode()?'已读取最新云端商品与素材':'已读取本机演示商品');
  }catch(error){catalogLoadError=error.message;if(manual)toast(error.message);}
  finally{catalogRefreshing=false;renderSyncNotice();}
}
async function syncBuyerShopping(manual=false){
  if(!isCloudMode()||shoppingRefreshing)return;
  shoppingRefreshing=true;
  const before=JSON.stringify(getBuyerState());
  try{
    if(manual)await refreshBuyerOrders();
    await experience.refresh({manual});
    const busy=submitting||modalRoot.children.length||document.activeElement?.matches('input,textarea,select')||[...app.querySelectorAll('video')].some(video=>!video.paused);
    const changed=before!==JSON.stringify(getBuyerState());
    if(manual||(!busy&&(changed||shoppingPending))){captureAfterDraft();shoppingPending=false;render(true);}else if(changed)shoppingPending=true;
  }finally{shoppingRefreshing=false;}
}
function refreshBuyerSession(){void refreshBuyerOrders().then(()=>syncBuyerShopping());}
window.addEventListener('focus',()=>{if(isCloudMode()){void syncBuyerCatalog();refreshBuyerSession();}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&isCloudMode()){void syncBuyerCatalog();refreshBuyerSession();}});
setInterval(()=>{if(!document.hidden&&isCloudMode()){void syncBuyerCatalog();refreshBuyerSession();}},30000);
render();
if(isCloudMode())void refreshBuyerOrders();
if(catalogLoadError||initialMediaIssues?.length)toast(catalogLoadError||initialMediaIssues[0]);
