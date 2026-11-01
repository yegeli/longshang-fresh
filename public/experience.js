import { CATALOG, getProduct, money, CART_KEY, validCart, addToCart, quoteCart, createCartOrder, isProductAvailable } from './model.js';
import { icon, esc } from './ui.js';
import { isCloudMode, getCloudState } from './cloud-client.js';
import { imageFor } from './media-store.js';
import { SPECIALTY_GUIDES, COLLECTIONS } from './specialty-content.js';
import { getBuyerState, refreshBuyerState, mutateBuyerState, consumeBuyerOrder } from './buyer-state-store.js';

const LIBRARY_KEY = 'longshang-demo-library-v1';
const sku = row => `${row.productId}::${row.variant}`;
const categoryLabels = {all:'全部特产',fruit:'水果鲜食',dried:'枸杞干货',vegetable:'田间蔬菜'};
export function createExperience(api) {
  let cart = [], library = {favorites:[],recent:[]}, cartMemoryOnly=false, libraryMemoryOnly=false;
  let specialtyCategory='all', query='', sort='default', committing=false, lastProductPage='', displayedCartQuote=null;
  let mutationBusy=false, buyerAccount='', buyerSnapshot=null, cleanupOrders=new Set();
  const buyerRead=api.getBuyerState||getBuyerState;
  const buyerRefresh=api.refreshBuyerState||refreshBuyerState;
  const buyerMutate=api.mutateBuyerState||mutateBuyerState;
  const buyerConsume=api.consumeBuyerOrder||consumeBuyerOrder;
  const accountId=()=>getCloudState().session?.user?.id||'';
  const currentPage=()=>api.route?.()[0]||'mine';
  function cleanupKey(account){return 'longshang-buyer-cart-cleanup-v1:'+encodeURIComponent(account);}
  function readCleanupOrders(account){
    if(!account)return new Set();
    try{const saved=JSON.parse(sessionStorage.getItem(cleanupKey(account))||'[]');return new Set(Array.isArray(saved)?saved.filter(id=>typeof id==='string'&&id.length>0&&id.length<=160).slice(0,50):[]);}catch{return new Set();}
  }
  function writeCleanupOrder(account,orderId,add){
    if(!account||!orderId)return false;
    const ids=account===buyerAccount?cleanupOrders:readCleanupOrders(account);
    if(add){ids.delete(orderId);const ordered=[orderId,...ids].slice(0,50);ids.clear();ordered.forEach(id=>ids.add(id));}else ids.delete(orderId);
    try{if(ids.size)sessionStorage.setItem(cleanupKey(account),JSON.stringify([...ids]));else sessionStorage.removeItem(cleanupKey(account));return true;}
    catch{if(add)api.toast('订单已生成，但本页无法保存购物车同步提醒。请先保留此页并确认同步结果。');return false;}
  }
  function prepareOrderCleanup(orderId,expectedAccount=accountId()){
    try{
      if(!isCloudMode()||!expectedAccount||expectedAccount!==accountId()||typeof orderId!=='string'||!orderId||orderId.length>160)return false;
      applyBuyerState();
      return writeCleanupOrder(expectedAccount,orderId,true);
    }catch{return false;}
  }
  function applyBuyerState(){
    if(!isCloudMode())return;
    const account=accountId(), snapshot=buyerRead();
    if(account!==buyerAccount){buyerAccount=account;lastProductPage='';displayedCartQuote=null;cleanupOrders=readCleanupOrders(account);}
    buyerSnapshot=snapshot;
    if(!account||snapshot.accountId!==account||!snapshot.ready){cart=[];library={favorites:[],recent:[]};return;}
    cart=Array.isArray(snapshot.cart)?snapshot.cart:[];
    library={favorites:Array.isArray(snapshot.favorites)?snapshot.favorites:[],recent:Array.isArray(snapshot.recent)?snapshot.recent:[]};
    if(snapshot.ready&&['gansu','shaanxi','other'].includes(snapshot.preferredAddress))api.selection.address=snapshot.preferredAddress;
  }
  function readCart(){if(isCloudMode()){applyBuyerState();return;}if(cartMemoryOnly)return;try{cart=validCart(JSON.parse(localStorage.getItem(CART_KEY)||'[]'));}catch{cartMemoryOnly=true;}}
  function readLibrary(){if(isCloudMode()){applyBuyerState();return;}if(libraryMemoryOnly)return;try{const saved=JSON.parse(localStorage.getItem(LIBRARY_KEY)||'{}');const clean=list=>Array.isArray(list)?[...new Set(list.filter(id=>!!getProduct(id)))].slice(0,20):[];library={favorites:clean(saved?.favorites),recent:clean(saved?.recent)};}catch{libraryMemoryOnly=true;}}
  function saveCart(){if(isCloudMode())throw new Error('云端购物车需要等待账号保存确认。');try{localStorage.setItem(CART_KEY,JSON.stringify(cart));}catch{cartMemoryOnly=true;api.toast('购物车暂存在本次页面中，关闭后会消失。');}}
  function saveLibrary(){if(isCloudMode())throw new Error('云端收藏需要等待账号保存确认。');try{localStorage.setItem(LIBRARY_KEY,JSON.stringify(library));}catch{libraryMemoryOnly=true;api.toast('收藏暂存在本次页面中，关闭后会消失。');}}
  readCart();readLibrary();
  function favorite(id){return library.favorites.includes(id);}
  function signInHref(){const path=(api.route?.()||['mine']).map(value=>encodeURIComponent(value)).join('/');return `/signin-with-chatgpt?return_to=${encodeURIComponent('/index.html#/'+path)}`;}
  function buyerGate(label='购物资料'){
    if(!isCloudMode())return '';
    applyBuyerState();const session=getCloudState(),snapshot=buyerSnapshot;
    if(session.error)return `<section class="buyer-state-gate" role="status"><span>${icon('user',36)}</span><h2>登录状态暂时无法确认</h2><p>${esc(session.error)}</p><button class="primary" data-action="x-refresh-buyer">重新读取账号</button><button class="text-link" data-action="navigate" data-route="specialties">先逛好物</button></section>`;
    if(!session.session?.user)return `<section class="buyer-state-gate"><span>${icon('user',36)}</span><h2>登录后同步${esc(label)}</h2><p>手机和电脑登录同一账号，就能看到同一份购物车、收藏和足迹。原来的本机记录不会自动上传。</p><a class="primary" href="${signInHref()}" target="_top">登录账号</a><button class="text-link" data-action="navigate" data-route="specialties">先逛好物</button></section>`;
    if(!snapshot?.ready||snapshot.accountId!==accountId())return `<section class="buyer-state-gate" role="status"><span>${icon('box',36)}</span><h2>${snapshot?.error?'账号购物资料暂时无法读取':'正在读取账号购物资料'}</h2><p>${esc(snapshot?.error||'正在同步购物车、收藏、足迹与示例收货地区。')}</p><button class="primary" data-action="x-refresh-buyer" ${snapshot?.loading?'disabled':''}>${snapshot?.loading?'读取中…':'重新读取'}</button><button class="text-link" data-action="navigate" data-route="specialties">继续逛好物</button></section>`;
    return '';
  }
  function buyerNotice(){
    if(!isCloudMode())return '';
    const gate=buyerGate();if(gate)return gate;
    const s=buyerSnapshot,savedAt=new Date(s.lastSyncedAt||''),time=Number.isFinite(savedAt.getTime())?new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}).format(savedAt):'';
    const cleanup=[...cleanupOrders][0];
    const cleanupNotice=cleanup?`<div class="buyer-state-notice has-error" role="status"><p>有已生成的订单尚未确认购物车扣减，请先核对，避免重复下单。</p><button class="text-link" data-action="navigate" data-route="order/${encodeURIComponent(cleanup)}">查看该订单</button></div>`:'';
    const message=s.error||((s.saving||mutationBusy)?'正在保存，云端确认后会同步更新。':s.loading?'正在读取账号最新购物资料…':`当前账号的购物资料已读取${time?' · 最近保存 '+time:''}`);
    return cleanupNotice+`<div class="buyer-state-notice ${s.error?'has-error':''}" role="status"><p>${esc(message)}</p><button class="text-link" data-action="x-refresh-buyer" ${s.loading||mutationBusy?'disabled':''}>刷新购物资料</button></div>`;
  }
  function cloudWritable(destination='cart'){
    if(!isCloudMode())return true;
    applyBuyerState();
    if(!accountId()){api.nav(destination);api.toast('登录账号后再保存购物资料。');return false;}
    if(mutationBusy){api.toast('正在保存，请稍候。');return false;}
    if(!buyerSnapshot?.ready||buyerSnapshot.accountId!==accountId()||buyerSnapshot.error||getCloudState().error){api.toast('请先重新读取账号购物资料，再继续操作。');api.render(true);return false;}
    return true;
  }
  async function mutateCloud(transform,message,{close=false,destination='cart'}={}){
    if(!cloudWritable(destination))return false;
    const account=accountId();mutationBusy=true;api.render(true);
    try{await buyerMutate(transform);if(account!==accountId())throw new Error('登录账号已变化，请查看当前账号的购物资料。');applyBuyerState();if(close)api.closeModal();if(message)api.toast(message);return true;}
    catch(error){applyBuyerState();api.toast(error.message||'云端保存未确认，请重新读取后再试。');return false;}
    finally{mutationBusy=false;applyBuyerState();api.updateTabs();api.render(true);}
  }
  async function refresh({manual=false,refresh=true}={}){
    if(!isCloudMode()){readCart();readLibrary();return;}
    if(refresh)await buyerRefresh();applyBuyerState();
    if(manual)api.toast(buyerSnapshot?.error||(!accountId()?'登录后可同步购物资料。':'已读取账号购物资料'));
  }
  function beforeRender(page,id){
    if(isCloudMode())applyBuyerState();
    const pid=page==='product'?(id||api.selection.productId):'';
    if(pid===lastProductPage)return;
    if(!isProductAvailable(getProduct(pid))){lastProductPage='';return;}
    readLibrary();
    if(isCloudMode()){
      if(!accountId()||!buyerSnapshot?.ready||buyerSnapshot.accountId!==accountId()||buyerSnapshot.error)return;
      lastProductPage=pid;if(library.recent[0]===pid)return;
      const account=accountId();
      void buyerMutate(draft=>{draft.recent=[pid,...draft.recent.filter(value=>value!==pid)].slice(0,20);}).then(()=>{
        applyBuyerState();if(accountId()===account&&currentPage()==='product'&&(api.route?.()[1]||api.selection.productId)===pid)api.render(true);
      }).catch(error=>{applyBuyerState();if(accountId()===account&&currentPage()==='product')api.toast('浏览足迹暂未同步：'+error.message);});
      return;
    }
    lastProductPage=pid;if(library.recent[0]===pid)return;library.recent=[pid,...library.recent.filter(value=>value!==pid)].slice(0,20);saveLibrary();
  }
  function empty(heading,body,route='specialties',label='去特产馆逛逛'){return `<div class="empty-orders"><div class="empty-illustration">${icon('box',52)}</div><h2>${heading}</h2><p>${body}</p><button class="primary" data-action="navigate" data-route="${route}">${label}</button></div>`;}
  function catalogCard(p){return api.productCard(p);}
  function collectionCard(c){return `<button class="collection-card" data-action="navigate" data-route="collection/${c.id}"><img src="${c.image}" alt="${esc(c.title)}示意" loading="lazy"><span class="collection-shade"></span><span class="collection-label">${esc(c.subtitle)}</span><strong>${esc(c.title)}</strong><span class="collection-arrow">${icon('arrow',17)}</span></button>`;}
  function decorateHome(html){const discoveries=`<section class="discovery-section"><div class="section-heading"><div><h2>换个方式，逛家乡</h2><p>按一顿饭、一份果盘，找到喜欢的味道</p></div><button class="text-link" data-action="navigate" data-route="specialties">特产馆 ${icon('arrow',13)}</button></div><div class="collection-strip">${COLLECTIONS.map(collectionCard).join('')}</div><button class="field-notes-entry" data-action="navigate" data-route="guide/jingtai-apple"><span>好物小课堂</span><div><h3>苹果不是越大越好，<br>先看清你买的规格。</h3><p>从果径、净重到包装，带你看懂商品页。</p></div>${icon('arrow',20)}</button></section>`;return html.replace('<div class="category-tabs catalog-tabs"',`${discoveries}<div class="category-tabs catalog-tabs"`);}
  function specialties(){let visible=CATALOG.filter(p=>isProductAvailable(p)&&(specialtyCategory==='all'||p.category===specialtyCategory)&&(!query||[p.name,p.subtitle,p.summary,...p.tags].join(' ').includes(query)));if(sort==='price-asc')visible.sort((a,b)=>a.variants[0].price-b.variants[0].price);if(sort==='price-desc')visible.sort((a,b)=>b.variants[0].price-a.variants[0].price);return `<section class="specialties-page"><div class="museum-heading"><span class="eyebrow">TASTES OF HOME</span><h1>一方风物，<br>慢慢认识。</h1><p>先了解，再挑选。把家乡味道带回日常。</p><span class="museum-number">${String(CATALOG.filter(isProductAvailable).length).padStart(2,'0')}<small>款好物 / 模拟</small></span></div><form id="specialty-search" class="search-form"><span>${icon('search',18)}</span><input name="keyword" aria-label="搜索特产" placeholder="搜苹果、枸杞、家常食材…" value="${esc(query)}" maxlength="40" autocomplete="off"><button type="submit">搜索</button></form><div class="museum-categories" role="group" aria-label="特产分类">${Object.entries(categoryLabels).map(([id,label])=>`<button data-action="x-category" data-category="${id}" aria-pressed="${specialtyCategory===id}" class="${specialtyCategory===id?'active':''}">${label}</button>`).join('')}</div><div class="museum-toolbar"><div><strong>${query?`“${esc(query)}”`:'全部都是家乡味'}</strong><small>${visible.length} 款特产</small></div><select id="specialty-sort" aria-label="商品排序"><option value="default" ${sort==='default'?'selected':''}>推荐顺序</option><option value="price-asc" ${sort==='price-asc'?'selected':''}>模拟价从低到高</option><option value="price-desc" ${sort==='price-desc'?'selected':''}>模拟价从高到低</option></select></div>${query?'<button class="text-link" data-action="x-reset-search">清除搜索，看看全部</button>':''}${visible.length?`<div class="catalog-grid">${visible.map(catalogCard).join('')}</div>`:`<div class="empty-orders"><div class="empty-illustration">${icon('search',42)}</div><h2>没有找到这份味道</h2><p>换个关键词，或清除搜索查看全部特产。</p><button class="primary" data-action="x-reset-search">查看全部特产</button></div>`}<div class="museum-section"><div class="section-heading"><div><h2>按场景挑好物</h2><p>把选择变简单，每份日常都有风味</p></div></div><div class="scene-list">${COLLECTIONS.map(c=>`<button data-action="navigate" data-route="collection/${c.id}"><img src="${c.image}" alt="${esc(c.title)}示意"><span><small>${esc(c.subtitle)}</small><strong>${esc(c.title)}</strong><em>${c.productIds.map(getProduct).filter(isProductAvailable).length} 款可选好物</em></span>${icon('arrow',17)}</button>`).join('')}</div></div><div class="museum-section"><div class="section-heading"><div><h2>特产详情 · 好物指南</h2><p>怎么挑、怎么吃，也值得讲清楚</p></div></div><div class="guide-list">${SPECIALTY_GUIDES.map(g=>`<button data-action="navigate" data-route="guide/${g.id}"><span>${icon('book',19)}</span><div><small>${esc(g.kicker)}</small><h3>${esc(g.title)}</h3></div>${icon('arrow',15)}</button>`).join('')}</div></div><p class="page-footnote">先从景泰起步，其他产区待有真实货源后逐步加入。</p></section>`;}
  function guide(id){const g=SPECIALTY_GUIDES.find(g=>g.id===id),p=getProduct(id);if(!g||!p)return api.title('特产详情','specialties')+empty('这份指南暂未收录','先看看特产馆中的六款好物。');return `${api.title('特产详情','specialties')}<article class="guide-page"><div class="guide-hero"><img src="${esc(imageFor(p))}" alt="${esc(p.name)}示意"><span>好物指南 · 图片示意</span></div><div class="guide-body"><span class="eyebrow">${esc(g.kicker)}</span><h1>${esc(g.title)}</h1><p class="guide-intro">${esc(g.intro)}</p><div class="flavor-card">${icon('sun',22)}<div><span>先认识这一口</span><p>${esc(g.flavor)}</p></div></div><section class="guide-section"><span class="section-index">01</span><h2>怎么挑，才合适？</h2><ol class="selection-tips">${g.selectionTips.map((t,i)=>`<li><b>${i+1}</b><p>${esc(t)}</p></li>`).join('')}</ol></section><section class="guide-section"><span class="section-index">02</span><h2>家常吃法，不必复杂</h2><div class="recipe-grid">${g.uses.map(u=>`<div><span>${icon('bowl',22)}</span><h3>${esc(u.name)}</h3><p>${esc(u.description)}</p></div>`).join('')}</div></section><section class="guide-section"><span class="section-index">03</span><h2>挑选前，常问这些</h2><div class="guide-faq">${g.faq.map(f=>`<details><summary>${esc(f.q)}<span>+</span></summary><p>${esc(f.a)}</p></details>`).join('')}</div></section><section class="guide-section"><h2>也适合放进这份日常</h2><div class="catalog-grid">${g.pairingIds.map(getProduct).filter(isProductAvailable).map(catalogCard).join('')}</div></section><p class="page-footnote">${esc(g.notes)}</p></div></article><div class="guide-purchase"><div><strong>${esc(p.name)}</strong><span>查看规格、介绍与模拟价格</span></div><button class="primary" data-action="view-product" data-product="${p.id}">去看商品 ${icon('arrow',14)}</button></div>`;}
  function collection(id){const c=COLLECTIONS.find(c=>c.id===id);if(!c)return api.title('好物专题','specialties')+empty('这份专题暂未收录','可以先去特产馆看看。');return `${api.title('好物专题','specialties')}<section class="collection-page"><div class="collection-hero"><img src="${c.image}" alt="${esc(c.title)}示意"><div></div><span>${esc(c.subtitle)}</span><h1>${esc(c.title)}</h1></div><div class="collection-body"><p class="body-copy">${esc(c.description)}</p><p class="collection-note">自由搭配，按商品单独选规格；没有预设礼盒或套餐优惠。</p><div class="catalog-grid">${c.productIds.map(getProduct).filter(isProductAvailable).map(catalogCard).join('')}</div><div class="collection-help"><h3>喜欢的先收藏，想买的放进购物车。</h3><p>可以把不同好物一起挑好，再进入购物车核对规格和金额。</p><button class="secondary" data-action="navigate" data-route="cart">去购物车 ${icon('arrow',14)}</button></div></div></section>`;}
  function detailExtras(p){const g=SPECIALTY_GUIDES.find(g=>g.id===p.id);if(!g)return '';return `<section class="surface product-guide-teaser"><div class="section-line"><h2>不只看规格，也看怎么选</h2><span>${icon('book',19)}</span></div><p class="body-copy">${esc(g.flavor)}</p><div class="detail-tip"><span>挑选小提示</span><p>${esc(g.selectionTips[0])}</p></div><div class="recipe-mini">${g.uses.map(u=>`<div><strong>${esc(u.name)}</strong><p>${esc(u.description)}</p></div>`).join('')}</div><button class="text-link" data-action="navigate" data-route="guide/${p.id}">查看完整特产详情 · 挑选与吃法 ${icon('arrow',14)}</button></section>`;}
  function favoriteButton(p){return `<button class="service-button favorite-button ${favorite(p.id)?'is-favorite':''}" data-action="x-favorite" data-product="${esc(p.id)}" ${mutationBusy?'disabled':''} aria-pressed="${favorite(p.id)}" aria-label="${favorite(p.id)?'取消收藏':'收藏'}${esc(p.name)}">${icon('heart')}<span>${favorite(p.id)?'已收藏':'收藏'}</span></button>`;}
  function productBar(p,x){const stock=api.availability(p,x.variant.id,x.quantity),busy=mutationBusy||(isCloudMode()&&!!accountId()&&(!buyerSnapshot?.ready||buyerSnapshot.accountId!==accountId()));return `<div class="purchase-bar product-v3-bar"><button class="service-button" data-action="navigate" data-route="cart" aria-label="查看购物车">${icon('cart')}<span>购物车</span></button>${favoriteButton(p)}<button class="secondary add-cart-button" data-action="x-add-cart" ${stock.available&&!busy?'':'disabled'}>${busy?'正在同步':'加入购物车'}</button><button class="primary" data-action="checkout" ${stock.available?'':'disabled'}>${stock.available?'立即选购':isProductAvailable(p)?'暂不可选购':'暂未上架'}</button></div>`;}
  function mine(){
    if(isCloudMode())applyBuyerState();
    const orders=api.getOrders(),user=getCloudState().session?.user;
    const usable=order=>order.status==='created'&&!(order.afterSale?.status==='resolved'&&order.afterSale.type==='refund');
    const waiting=orders.filter(order=>usable(order)&&!order.fulfillment).length;
    const shipped=orders.filter(order=>usable(order)&&order.fulfillment?.status==='shipped'&&order.receipt?.status!=='received').length;
    const received=orders.filter(order=>usable(order)&&order.receipt?.status==='received').length;
    const afterCount=orders.filter(order=>order.afterSale?.status==='submitted').length;
    const available=!isCloudMode()||(buyerSnapshot?.ready&&buyerSnapshot.accountId===accountId());
    const total=value=>available?value:'—';
    return `<section class="mine-page"><div class="mine-profile"><span class="profile-avatar">陇</span><div><span class="eyebrow">好物相伴的每一天</span><h1>${user?'你好，'+esc(user.name||'体验用户'):'你好，先随便逛逛'}</h1><p>${isCloudMode()?'一份家乡味，手机电脑接着逛。':'不用登录，先把喜欢的生活逛一遍。'}</p></div><span class="local-badge">${isCloudMode()?'账号同步':'本机演示'}</span></div>${user?(api.accountPanel?.()||''):''}${buyerNotice()}<div class="mine-stats"><button data-action="navigate" data-route="favorites"><strong>${total(library.favorites.length)}</strong><span>我的收藏</span></button><button data-action="navigate" data-route="history"><strong>${total(library.recent.length)}</strong><span>浏览足迹</span></button><button data-action="navigate" data-route="cart"><strong>${total(cart.reduce((sum,row)=>sum+row.quantity,0))}</strong><span>购物车好物</span></button></div><div class="mine-orders"><div class="section-line"><h2>我的订单</h2><button class="text-link" data-action="go-orders">全部订单 ${icon('arrow',13)}</button></div><div class="order-shortcuts"><button data-action="x-orders" data-filter="waiting">${icon('box',25)}<span>待发货</span><small>${waiting} 笔</small></button><button data-action="x-orders" data-filter="shipped">${icon('truck',25)}<span>待收货</span><small>${shipped} 笔</small></button><button data-action="x-orders" data-filter="received">${icon('check',25)}<span>已完成</span><small>${received} 笔</small></button><button data-action="x-orders" data-filter="aftersale">${icon('heart',25)}<span>售后服务</span><small>${afterCount} 笔待处理</small></button></div></div><div class="mine-menu"><button data-action="navigate" data-route="favorites">${icon('heart',21)}<span>我的收藏<small>留住喜欢的家乡味</small></span>${icon('arrow',15)}</button><button data-action="navigate" data-route="history">${icon('clock',21)}<span>最近看过<small>找回刚才心动的好物</small></span>${icon('arrow',15)}</button><button data-action="navigate" data-route="preferences">${icon('pin',21)}<span>使用设置<small>示例收货地区：${esc(api.addressLabel())}</small></span>${icon('arrow',15)}</button><button data-action="support">${icon('chat',21)}<span>自助帮助与客服<small>规格、配送和售后常见问题</small></span>${icon('arrow',15)}</button><button data-action="navigate" data-route="walkthrough">${icon('leaf',21)}<span>完整体验指南<small>从挑选到模拟收货、售后</small></span>${icon('arrow',15)}</button></div><a class="merchant-entry" href="admin.html#/dashboard">${icon('box',21)}<span>商家管理后台<small>改商品、换素材、处理模拟订单</small></span>${icon('arrow',15)}</a><button class="mine-guide-banner" data-action="navigate" data-route="specialties"><span>好物小课堂</span><strong>买之前，先认识它。</strong><p>特产介绍 · 挑选建议 · 家常吃法 ${icon('arrow',14)}</p></button><p class="page-footnote">${isCloudMode()?'登录后同步购物车、收藏、足迹与示例地区。客服对话仅在当前页面会话中保留。':libraryMemoryOnly||cartMemoryOnly?'部分数据仅保留至页面关闭。':'收藏、购物车和足迹保存在本浏览器。'}<br>模拟下单与收货，不含真实支付、物流或会员权益。</p></section>`;
  }
  function savedPage(type){
    readLibrary();const isFav=type==='favorites',heading=isFav?'我的收藏':'浏览足迹',gate=buyerGate(heading);
    if(gate)return api.title(heading,'mine')+gate;
    const ids=isFav?library.favorites:library.recent;
    const cards=ids.map(id=>{
      const p=getProduct(id);
      if(!p)return `<div class="saved-unavailable"><span>${icon('box',24)}</span><p>这份好物暂时无法查看<small>原记录仍保留，可稍后刷新${isFav?'或取消收藏':''}。</small></p>${isFav?`<button class="text-link" data-action="x-favorite" data-product="${esc(id)}" ${mutationBusy?'disabled':''}>取消收藏</button>`:''}</div>`;
      return `<div class="saved-product">${catalogCard(p)}${isFav?`<button class="saved-remove" data-action="x-favorite" data-product="${esc(id)}" ${mutationBusy?'disabled':''} aria-label="取消收藏${esc(p.name)}">${icon('heart',16)} 已收藏</button>`:''}</div>`;
    }).join('');
    return `${api.title(heading,'mine')}<section class="saved-page">${buyerNotice()}<div class="section-heading"><div><h2>${isFav?'留住喜欢的味道':'刚刚认识的好物'}</h2><p>${isFav?'收藏后，下次更容易找到。':isCloudMode()?'按账号最近浏览排序，换个设备也能接着看。':'按最近浏览排序，仅记录本浏览器。'}</p></div><span>${ids.length} 款</span></div>${ids.length?`<div class="catalog-grid">${cards}</div>${!isFav?`<button class="text-link danger-link" data-action="x-clear-history" ${mutationBusy?'disabled':''}>清空浏览足迹</button>`:''}`:empty(isFav?'喜欢的好物，留在这里':'还没有留下足迹',isFav?'到商品详情点一下“收藏”，下次就能直接找到。':'先去特产馆，打开一款商品看看。')}<p class="page-footnote">${isCloudMode()?'收藏与足迹跟随当前登录账号同步，不自动合并原本的本机记录。':'收藏与足迹仅在本浏览器可见，不跨设备同步。'}</p></section>`;
  }
  function preferences(){
    const gate=buyerGate('使用设置');
    return `${api.title('使用设置','mine')}<section class="buyer-preferences">${gate||`${buyerNotice()}<header><span class="eyebrow">按自己的习惯慢慢逛</span><h1>示例收货地区</h1><p>用于展示演示运费，不需要填写真实姓名、电话或地址。</p></header><button class="buyer-preference-row" data-action="address"><span>${icon('pin',23)}</span><div><strong>${esc(api.addressLabel())}</strong><p>${isCloudMode()?'作为当前账号的地区偏好同步':'保留当前浏览器的演示选择'}</p></div>${icon('arrow',18)}</button><div class="buyer-preference-help"><h2>接下来怎么体验？</h2><ol><li>从首页或产区走进采购者店铺。</li><li>查看规格、采收介绍，选好后加入购物车。</li><li>按同一家店铺生成模拟订单，体验发货、收货与售后。</li></ol><button class="text-link" data-action="navigate" data-route="walkthrough">查看完整体验指南 ${icon('arrow',14)}</button><button class="text-link" data-action="support">查看自助帮助 ${icon('arrow',14)}</button></div><p class="page-footnote">${isCloudMode()?'账号资料保存到云端，原有本机购物资料不会自动上传。':'静态演示资料保存在本浏览器。'}<br>全程不支付，不会寄出真实包裹。</p>`}</section>`;
  }
  function productShop(id){const shop=api.shopForProduct?.(id);return shop&&!shop.preview?shop:null;}
  function checkoutShop(items){
    if(!items.length)return {valid:false,error:'请先勾选需要购买的好物。'};
    if(items.some(row=>!getProduct(row.productId)?.variants.some(variant=>variant.id===row.variant)))return {valid:false,error:'选中商品暂时不可用，请取消勾选或移除后再试。'};
    if(isCloudMode()){
      const directory=api.getStorefrontState?.();
      if(!directory?.ready||directory.error)return {valid:false,error:'采购者店铺资料暂时无法确认，请重新读取后再结算。'};
    }
    const shops=items.map(item=>productShop(item.productId));
    if(shops.some(shop=>!shop))return {valid:false,error:'部分商品暂时无法确认采购者店铺，请取消勾选或重新读取商品。'};
    if(new Set(shops.map(shop=>shop.id)).size!==1)return {valid:false,error:'不同采购者的好物需要分开结算，请点击店铺旁的“只选这家”。'};
    return {valid:true,shop:shops[0],error:''};
  }
  function cartGroups(){
    const groups=new Map();
    for(const row of cart){const shop=productShop(row.productId),key=shop?.id||'unavailable';if(!groups.has(key))groups.set(key,{shop,rows:[]});groups.get(key).rows.push(row);}
    return [...groups.values()];
  }
  function cartItem(row){
    const p=getProduct(row.productId),v=p?.variants.find(variant=>variant.id===row.variant),disabled=mutationBusy?'disabled':'';
    if(!p||!v)return `<article class="cart-item cart-item-unavailable"><label class="cart-check"><input type="checkbox" data-cart-select="${esc(sku(row))}" ${row.selected?'checked':''} ${disabled} aria-label="选择暂不可用的商品"></label><span class="cart-item-placeholder">${icon('box',28)}</span><div class="cart-item-copy"><h2>商品暂不可用</h2><p>原记录仍保留，可稍后刷新或移除。</p><span>${row.quantity} 份</span><button class="cart-remove" data-action="x-cart-remove" data-key="${esc(sku(row))}" ${disabled}>移除</button></div></article>`;
    return `<article class="cart-item"><label class="cart-check"><input type="checkbox" data-cart-select="${esc(sku(row))}" ${row.selected?'checked':''} ${disabled} aria-label="选择${esc(p.name)}${esc(v.label)}"></label><button class="cart-item-image" data-action="view-product" data-product="${esc(p.id)}" aria-label="查看${esc(p.name)}"><img src="${esc(imageFor(p))}" alt="${esc(p.name)}示意"></button><div class="cart-item-copy"><h2>${esc(p.name)}</h2>${!isProductAvailable(p)?'<span class="unavailable-label">暂未上架，请取消勾选或移除</span>':''}<p>${esc(v.label)} · ${esc(v.weight)}</p>${isCloudMode()?`<p class="cart-stock">${esc(api.availability(p,v.id,row.quantity).message)}</p>`:''}<strong>¥${money(v.price)} <small>模拟单价</small></strong><div class="cart-item-controls"><div class="stepper"><button data-action="x-cart-quantity" data-key="${esc(sku(row))}" data-delta="-1" aria-label="减少${esc(p.name)}${esc(v.label)}" ${row.quantity<=1||mutationBusy?'disabled':''}>−</button><span>${row.quantity}</span><button data-action="x-cart-quantity" data-key="${esc(sku(row))}" data-delta="1" aria-label="增加${esc(p.name)}${esc(v.label)}" ${row.quantity>=10||mutationBusy?'disabled':''}>+</button></div><button class="cart-remove" data-action="x-cart-remove" data-key="${esc(sku(row))}" ${disabled}>移除</button></div></div></article>`;
  }
  function cartPage(){
    readCart();const gate=buyerGate('购物车');if(gate)return gate;
    const chosen=cart.filter(row=>row.selected),amount=quoteCart(cart,api.selection.address),all=cart.length>0&&chosen.length===cart.length;
    const ownership=checkoutShop(chosen),stockReady=chosen.every(row=>getProduct(row.productId)&&api.availability(getProduct(row.productId),row.variant,row.quantity).available);
    const groups=cartGroups().map(({shop,rows})=>`<section class="cart-shop-group"><div class="cart-shop">${shop?`<button class="cart-shop-link" data-action="navigate" data-route="shop/${esc(shop.id)}">${icon('leaf',18)}<span>${esc(shop.name)}</span>${icon('arrow',14)}</button><div class="cart-shop-actions"><button class="text-link" data-action="x-select-shop" data-shop="${esc(shop.id)}" ${mutationBusy?'disabled':''}>只选这家</button></div>`:`<span>${icon('box',18)} 店铺资料暂缺</span>`}</div><div class="cart-list">${rows.map(cartItem).join('')}</div></section>`).join('');
    return `<section class="cart-page">${buyerNotice()}<div class="cart-heading"><span class="eyebrow">YOUR MARKET BASKET</span><h1>把喜欢的，<br>装进这一篮。</h1><p>${cart.length?`已放入 ${cart.length} 个规格，按采购者分别确认下单。`:'从一份家乡好物，开始今天的挑选。'}</p></div>${cart.length?`<div class="cart-shop"><span>按采购者店铺分组</span><button class="text-link" data-action="x-toggle-all" ${mutationBusy?'disabled':''}>${all?'取消全选':'全选商品'}</button></div>${chosen.length&&!ownership.valid?`<p class="cart-shop-warning" role="status">${esc(ownership.error)}</p>`:''}${groups}<div class="cart-explainer">${icon('truck',18)}<p>同一家采购者的好物合为一笔模拟订单，运费计算一次。<br>不同店铺请分开结算；每个规格最多10份，未选商品继续保留。</p></div>`:empty('购物车还是空的','打开商品选择规格后，点击“加入购物车”。')}<div class="cart-recommend"><div class="section-heading"><div><h2>再带一份家乡味</h2><p>这些也可以一起挑选</p></div></div><div class="catalog-grid">${CATALOG.filter(p=>isProductAvailable(p)&&!cart.some(row=>row.productId===p.id)).slice(0,2).map(catalogCard).join('')}</div></div></section>${cart.length?`<div class="cart-total-bar"><label><input type="checkbox" data-cart-all ${mutationBusy?'disabled':''} ${all?'checked':''}>全选</label><div><small>已选 ${amount.quantity} 份 · 不含运费</small><strong>¥${money(amount.subtotal)}</strong></div><button class="primary" data-action="x-cart-checkout" ${chosen.length&&amount.available&&stockReady&&ownership.valid&&!mutationBusy&&!cleanupOrders.size?'':'disabled'}>去结算 (${chosen.length})</button></div>`:''}`;
  }
  function cartCheckout(){
    readCart();const gate=buyerGate('购物车');if(gate)return api.title('确认模拟订单','cart')+gate;
    const x=quoteCart(cart,api.selection.address),ownership=checkoutShop(x.items);
    displayedCartQuote=null;
    if(!x.items.length)return api.title('确认模拟订单','cart')+empty('还没有选中商品','返回购物车勾选需要一起购买的好物。','cart','返回购物车');
    if(!ownership.valid)return api.title('确认模拟订单','cart')+empty('请按采购者分别确认',ownership.error,'cart','返回购物车调整');
    displayedCartQuote={items:x.items.map(({productId,variant,quantity,unitPrice})=>({productId,variant,quantity,unitPrice})),address:x.address.id,total:x.total,shopId:ownership.shop.id,batches:Object.fromEntries(x.items.map(item=>[item.productId,api.inventoryFor(item.productId)?.batchId||'']))};
    const stockReady=x.items.every(item=>api.availability(getProduct(item.productId),item.variant,item.quantity).available);
    return `${api.title('确认模拟订单','cart')}<section class="cart-checkout-page"><div class="flow-label"><span>01 挑选好物</span><i></i><b>02 同店确认</b><i></i><span>03 完成</span></div><button class="address-card" data-action="address"><span class="address-icon">${icon('pin',25)}</span><div><span class="small-pill">示例收货信息</span><h2>${x.address.person}<small>${x.address.label}</small></h2><p>${x.address.address}</p><small>不需要填写真实个人资料</small></div>${icon('arrow',17)}</button><div class="surface cart-order-items"><div class="seller-line">${icon('leaf',16)} ${esc(ownership.shop.name)} · ${x.items.length} 个规格</div>${x.items.map(item=>api.miniProduct({...item,...(isCloudMode()?{batchCode:api.inventoryFor(item.productId)?.batchCode||'',harvestDate:api.inventoryFor(item.productId)?.harvestDate||''}: {})})+(isCloudMode()?`<p class="cart-stock">${esc(api.availability(getProduct(item.productId),item.variant,item.quantity).message)}</p>`:'')).join('')}</div><div class="surface"><h2>费用明细 <span class="soft-label">模拟金额</span></h2><dl class="bill"><div><dt>${x.quantity} 份商品合计</dt><dd>¥${money(x.subtotal)}</dd></div><div><dt>演示运费 · 本店订单仅收一次</dt><dd>${x.shipping===null?'待确认配送':`¥${money(x.shipping)}`}</dd></div><div class="bill-total"><dt>合计</dt><dd>${x.total===null?'暂不可下单':`¥${money(x.total)}`}</dd></div></dl><p class="shipping-note">${!x.available?'选中的商品暂未上架，请返回购物车调整。':x.shipping===null?'请选择甘肃或陕西示例收货地区。':'本次把同一家采购者的选中商品合为一笔模拟订单。实际运费和能否合箱以后按货源与物流方案确定。'}</p></div><div class="demo-explainer">${icon('check',18)}<div><strong>只体验流程，不会扣款</strong><p>${isCloudMode()?'登录后生成云端订单，可跨设备查看，并在后台模拟处理发货与售后。':'订单生成后，可查看全部商品明细，并对整笔订单体验售后。'}未选中的商品保留在购物车。</p></div></div></section><div class="purchase-bar checkout-bar"><div><small>模拟合计</small><strong>${x.total===null?'待确认':`¥${money(x.total)}`}</strong></div><button class="primary" data-action="x-cart-submit" ${x.total===null||committing||!stockReady?'disabled':''}>生成模拟订单</button></div>`;
  }
  const routes={specialties,guide,collection,mine,preferences,cart:cartPage,'cart-checkout':cartCheckout,favorites:()=>savedPage('favorites'),history:()=>savedPage('history')};
  async function handleClick(d,button){switch(d.action){
    case 'x-category':specialtyCategory=d.category;api.render();return true;
    case 'x-reset-search':query='';specialtyCategory='all';sort='default';api.render();return true;
    case 'x-refresh-buyer':
      if(api.refreshBuyerShopping)await api.refreshBuyerShopping();else{await refresh({manual:true});api.render(true);api.updateTabs();}
      return true;
    case 'x-favorite':{
      readLibrary();const already=favorite(d.product);if(!getProduct(d.product)&&!already)return true;
      if(isCloudMode()){await mutateCloud(draft=>{draft.favorites=already?draft.favorites.filter(id=>id!==d.product):[d.product,...draft.favorites.filter(id=>id!==d.product)].slice(0,20);},already?'已取消收藏':'已同步到我的收藏',{destination:'favorites'});return true;}
      library.favorites=already?library.favorites.filter(id=>id!==d.product):[d.product,...library.favorites].slice(0,20);saveLibrary();api.render(true);api.toast(already?'已取消收藏':'已放进我的收藏');return true;
    }
    case 'x-clear-history':
      if(isCloudMode()&&!cloudWritable('history'))return true;
      api.showModal(isCloudMode()?'清空当前账号的浏览足迹？':'清空本浏览器的浏览足迹？','<div class="modal-copy"><p>收藏与订单会继续保留。</p><div class="modal-actions"><button class="secondary" data-action="close-modal">先保留</button><button class="primary" data-action="x-confirm-clear-history">清空足迹</button></div></div>');return true;
    case 'x-confirm-clear-history':
      if(isCloudMode()){await mutateCloud(draft=>{draft.recent=[];},'浏览足迹已清空',{close:true,destination:'history'});return true;}
      readLibrary();library.recent=[];saveLibrary();api.closeModal();api.render();return true;
    case 'x-orders':api.openOrders(d.filter);return true;
    case 'x-add-cart':{
      readCart();const s={...api.selection},p=getProduct(s.productId);
      if(!p||!isProductAvailable(p)||!p.variants.some(variant=>variant.id===s.variant)){api.toast('这款商品或规格暂不可用，请重新选择。');return true;}
      const old=cart.find(row=>row.productId===s.productId&&row.variant===s.variant),capped=(old?.quantity||0)+s.quantity>10;
      const stock=api.availability(p,s.variant,Math.min(10,(old?.quantity||0)+s.quantity));if(!stock.available){api.toast(stock.message);return true;}
      if(isCloudMode()){
        await mutateCloud(draft=>{
          const row=draft.cart.find(row=>row.productId===s.productId&&row.variant===s.variant);
          const quantity=Math.min(10,(row?.quantity||0)+s.quantity),latest=api.availability(p,s.variant,quantity);
          if(!latest.available)throw new Error(latest.message);
          if(row){row.quantity=quantity;row.selected=true;}else{if(draft.cart.length>=12)throw new Error('购物车最多保留12种规格');draft.cart.push({productId:s.productId,variant:s.variant,quantity,selected:true});}
        },capped?'这个规格最多10份，购物车已同步为10份':'已同步到购物车，可继续挑选其他好物');return true;
      }
      try{cart=addToCart(cart,s);}catch(error){api.toast(error.message);return true;}saveCart();api.updateTabs();api.toast(capped?'这个规格最多10份，购物车已保留10份':'已加入购物车，可继续挑选其他好物');return true;
    }
    case 'x-cart-quantity':{
      readCart();const delta=Number(d.delta);if(![-1,1].includes(delta))return true;
      const change=draft=>{draft.cart=draft.cart.map(row=>{if(sku(row)!==d.key)return row;const quantity=Math.min(10,Math.max(1,row.quantity+delta));if(delta>0){const stock=api.availability(getProduct(row.productId),row.variant,quantity);if(!stock.available)throw new Error(stock.message);}return {...row,quantity};});};
      if(isCloudMode()){await mutateCloud(change,'');return true;}
      const draft={cart};try{change(draft);cart=draft.cart;saveCart();api.render(true);}catch(error){api.toast(error.message);}return true;
    }
    case 'x-cart-remove':
      if(isCloudMode()){await mutateCloud(draft=>{draft.cart=draft.cart.filter(row=>sku(row)!==d.key);},'已从购物车移除');return true;}
      readCart();cart=cart.filter(row=>sku(row)!==d.key);saveCart();api.render(true);api.toast('已移出购物车');return true;
    case 'x-toggle-all':{
      readCart();const selected=!cart.every(row=>row.selected);
      if(isCloudMode()){await mutateCloud(draft=>{draft.cart=draft.cart.map(row=>({...row,selected}));},'');return true;}
      cart=cart.map(row=>({...row,selected}));saveCart();api.render(true);return true;
    }
    case 'x-select-shop':{
      readCart();
      if(isCloudMode()){const directory=api.getStorefrontState?.();if(!directory?.ready||directory.error){api.toast('采购者店铺资料暂时无法确认，请重新读取后再选择。');return true;}}
      if(!cart.some(row=>productShop(row.productId)?.id===d.shop)){api.toast('这家店铺的商品暂时不可选择，请重新读取。');return true;}
      if(isCloudMode()){await mutateCloud(draft=>{draft.cart=draft.cart.map(row=>({...row,selected:productShop(row.productId)?.id===d.shop}));},'已按这家店铺选择，其他商品继续保留');return true;}
      cart=cart.map(row=>({...row,selected:productShop(row.productId)?.id===d.shop}));saveCart();api.render(true);return true;
    }
    case 'x-cart-checkout':{
      if(isCloudMode()&&!cloudWritable('cart'))return true;
      if(isCloudMode()&&cleanupOrders.size){api.toast('请先在已生成的订单中确认购物车同步结果，避免重复下单。');return true;}
      readCart();const ownership=checkoutShop(cart.filter(row=>row.selected));if(!ownership.valid){api.toast(ownership.error);return true;}api.nav('cart-checkout');return true;
    }
    case 'x-cart-submit':{
      if(committing||api.route()[0]!=='cart-checkout')return true;
      if(isCloudMode()&&!cloudWritable('cart'))return true;
      if(isCloudMode()&&cleanupOrders.size){api.toast('请先在已生成的订单中确认购物车同步结果，避免重复下单。');return true;}
      committing=true;if(button)button.disabled=true;
      try{
        const checkoutAccount=isCloudMode()?accountId():'';
        readCart();
        const checkout=quoteCart(cart,api.selection.address);
        const shown=isCloudMode()?displayedCartQuote:{items:checkout.items,address:api.selection.address,total:checkout.total};
        if(!shown)throw new Error('请重新打开结算页面，核对商品与金额。');
        const ownership=checkoutShop(shown.items);
        if(!ownership.valid)throw new Error(ownership.error);
        if(isCloudMode()&&shown.shopId!==ownership.shop.id)throw new Error('商品的采购者店铺已变化，请重新打开结算页面核对。');
        const selected=shown.items.map(({productId,variant,quantity})=>({productId,variant,quantity}));
        const prices=Object.fromEntries(shown.items.map(item=>[sku(item),item.unitPrice]));
        const order=isCloudMode()?await api.createCloudOrder(selected,shown.address,shown.total,prices,shown.batches):createCartOrder(cart,api.selection.address,api.newId('DEMO'));
        if(isCloudMode()&&checkoutAccount!==accountId()){api.toast('登录账号已变化，请回到原账号确认订单；本次未修改新账号购物车。');return true;}
        if(!isCloudMode())api.addOrder(order);
        await removeOrderedItems(selected,order.id,checkoutAccount);
        if(isCloudMode()&&checkoutAccount!==accountId()){api.toast('登录账号已变化，请回到原账号查看已生成的订单。');return true;}
        api.nav(`order/${encodeURIComponent(order.id)}`);
      }catch(error){api.toast(error.message);}
      finally{committing=false;if(api.route()[0]==='cart-checkout')api.render(true);}
      return true;
    }
    case 'x-retry-cart-cleanup':
      applyBuyerState();
      if(cleanupOrders.has(d.order)){await removeOrderedItems([],d.order,buyerAccount);api.render(true);}
      return true;
  }return false;}
  async function handleChange(target){
    if(target.id==='specialty-sort'){sort=target.value;api.render(true);return true;}
    if(target.matches('[data-cart-select]')){
      const key=target.dataset.cartSelect,selected=target.checked;
      if(isCloudMode()){await mutateCloud(draft=>{draft.cart=draft.cart.map(row=>sku(row)===key?{...row,selected}:row);},'');return true;}
      readCart();cart=cart.map(row=>sku(row)===key?{...row,selected}:row);saveCart();api.render(true);return true;
    }
    if(target.matches('[data-cart-all]')){
      const selected=target.checked;
      if(isCloudMode()){await mutateCloud(draft=>{draft.cart=draft.cart.map(row=>({...row,selected}));},'');return true;}
      readCart();cart=cart.map(row=>({...row,selected}));saveCart();api.render(true);return true;
    }
    return false;
  }
  function handleSubmit(event){if(event.target.id==='specialty-search'){event.preventDefault();query=String(new FormData(event.target).get('keyword')||'').trim().slice(0,40);api.render();return true;}return false;}
  function orderShoppingNotice(orderId){
    if(!isCloudMode())return '';applyBuyerState();if(!cleanupOrders.has(orderId))return '';
    return `<div class="buyer-state-notice has-error" role="status"><p>订单已经生成，购物车扣减尚未确认。请勿为此重复下单；可以重试同步购物车。</p><button class="text-link" data-action="x-retry-cart-cleanup" data-order="${esc(orderId)}">重试同步购物车</button></div>`;
  }
  async function removeOrderedItems(items,orderId,expectedAccount=accountId()){
    if(isCloudMode()){
      if(!expectedAccount||expectedAccount!==accountId()){api.toast('登录账号已变化，未修改当前账号的购物车；请回到原账号确认订单。');return false;}
      const account=expectedAccount;prepareOrderCleanup(orderId,account);
      try{if(!orderId)throw new Error('缺少已生成的订单编号');await buyerConsume(orderId);if(account!==accountId()){applyBuyerState();api.toast('登录账号已变化，请回到原账号确认购物车同步结果。');return false;}writeCleanupOrder(account,orderId,false);try{api.cartCleanupConfirmed?.(orderId,account);}catch{api.toast('购物车已同步，订单确认提醒暂未清除，可稍后重新读取。');}applyBuyerState();api.updateTabs();return true;}
      catch(error){applyBuyerState();if(account===accountId())api.toast('订单已经生成，购物车扣减尚未确认。请勿重复下单，可在订单详情重试同步。');return false;}
    }
    readCart();cart=cart.flatMap(row=>{const ordered=items.find(item=>sku(item)===sku(row));if(!ordered)return [row];return row.quantity>ordered.quantity?[{...row,quantity:row.quantity-ordered.quantity}]:[];});saveCart();api.updateTabs();return true;
  }
  function storage(event){if(isCloudMode())return;if([CART_KEY,LIBRARY_KEY,null].includes(event.key)){readCart();readLibrary();api.render(true);}}
  return {prepareOrderCleanup,removeOrderedItems,orderShoppingNotice,refresh,applyBuyerState,routes,beforeRender,decorateHome,detailExtras,productBar,handleClick,handleChange,handleSubmit,storage,count:()=>{if(isCloudMode())applyBuyerState();return cart.reduce((sum,row)=>sum+row.quantity,0);},favorites:()=>{if(isCloudMode())applyBuyerState();return library.favorites.length;}};
}
