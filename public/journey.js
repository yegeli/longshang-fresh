import { esc, icon } from './ui.js';
import { isProductAvailable } from './model.js';
import { getStorefrontState } from './storefront-store.js';

const CATEGORIES = [['all', '全部'], ['fruit', '鲜果'], ['dried', '干货'], ['vegetable', '蔬菜']];
const encode = value => encodeURIComponent(String(value));
const routeTo = (type, id) => `${type}/${encode(id)}`;

// This module owns discovery state only. Product selection, cart and checkout
// continue through the buyer controller's existing actions.
export function createJourney(api) {
  let province = 'all', shopRegion = 'all', keyword = '';
  const shopFilters = new Map();
  const state = () => (api.getStorefrontState || getStorefrontState)();
  const catalog = () => (api.catalog?.() || []).filter(isProductAvailable);
  const product = id => catalog().find(item => item.id === id);
  const byId = (list, id) => list.find(item => item.id === id);
  const fromIds = ids => [...new Set(ids || [])].map(product).filter(Boolean);
  const regionProducts = region => region.preview ? [] : fromIds(region.productIds);
  const shopProducts = shop => shop.preview ? [] : fromIds(shop.productIds);
  const stockAvailable = item => item.variants?.some(variant => api.availability(item, variant.id).available === true);
  const navigate = (path, label, className = 'journey-link') => `<button class="${className}" data-action="navigate" data-route="${esc(path)}">${label}${icon('arrow', 16)}</button>`;
  const heading = (name, description, link = '') => `<div class="journey-heading"><div><h2>${esc(name)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div>${link}</div>`;
  const footnote = () => '<p class="journey-footnote">模拟商品与采购资料 · 图片为示意 · 暂不接支付</p>';

  function empty(name, description, action = '') {
    return `<div class="journey-empty"><span class="journey-empty-icon">${icon('leaf', 27)}</span><h3>${esc(name)}</h3><p>${esc(description)}</p>${action}</div>`;
  }

  function directoryStatus(current = state()) {
    if (current.error) return `<div class="journey-status journey-status-error" role="status"><div><strong>产区与店铺暂时无法读取</strong><p>${esc(current.error)}</p></div><button class="journey-button" data-action="refresh-cloud">重新读取</button></div>`;
    if (!current.ready) return '<div class="journey-status" role="status"><p>正在整理产区与采购者店铺…</p></div>';
    return '';
  }

  function searchForm() {
    return `<form class="journey-search" id="journey-search" role="search"><label class="journey-sr-only" for="journey-keyword">搜索商品、产区或采购者</label><span>${icon('search', 20)}</span><input id="journey-keyword" name="keyword" type="search" maxlength="40" value="${esc(keyword)}" placeholder="搜苹果、枸杞，或一个地方" autocomplete="off"><button type="submit">搜索</button></form>`;
  }

  function productGrid(items, name = '这里的好物还在准备') {
    return items.length ? `<div class="journey-products catalog-grid">${items.map(item => api.productCard(item)).join('')}</div>` : empty(name, '有新的上架商品后，会出现在这里。', navigate('specialties', '逛逛其他好物'));
  }

  function regionCard(region, compact = false) {
    const count = regionProducts(region).length;
    return `<button class="journey-region-card ${compact ? 'journey-region-compact' : ''}" data-action="navigate" data-route="${esc(routeTo('region', region.id))}"><div class="journey-region-image"><img src="${esc(region.image || 'assets/orchard.jpg')}" alt="${esc(region.name)}产区示意图片" loading="lazy"><span class="journey-badge ${region.preview ? 'journey-badge-preview' : ''}">${region.preview ? '筹备示意' : `${count} 款好物`}</span><span class="journey-photo-note">示意图片</span></div><div class="journey-region-copy"><span>${esc(region.province)}</span><h3>${esc(region.name)}</h3><p>${esc(region.subtitle || (region.preview ? '先认识这个地方，商品尚未上架' : '认识来处，再挑喜欢的好物'))}</p><span class="journey-card-footer">${region.preview ? '看看筹备计划' : '走进产区'} ${icon('arrow', 16)}</span></div></button>`;
  }

  function shopCard(shop) {
    const count = shopProducts(shop).length;
    return `<button class="journey-shop-card" data-action="navigate" data-route="${esc(routeTo('shop', shop.id))}"><span class="journey-shop-avatar">${icon('leaf', 26)}</span><span class="journey-shop-copy"><span class="journey-shop-region">${esc(shop.regionLabel || '产区资料待补充')}</span><strong>${esc(shop.name)}</strong><span>${esc(shop.procurementName || '采购者资料待补充')} · ${shop.preview ? '筹备示意' : '模拟采购者'}</span><span class="journey-shop-count">${shop.preview ? '暂无上架商品' : `${count} 款上架好物`}</span></span>${icon('arrow', 18)}</button>`;
  }

  function home() {
    const current = state(), items = catalog();
    const regions = current.ready && !current.error ? current.regions : [];
    const shops = current.ready && !current.error ? current.shops.filter(shop => !shop.preview && shopProducts(shop).length) : [];
    const featured = items.find(item => item.id === 'jingtai-apple') || items[0];
    return `<section class="journey-page journey-home"><div class="journey-location"><span>${icon('pin', 17)} 从甘肃 · 景泰出发</span><button data-action="support" aria-label="打开客服与帮助">${icon('chat', 19)} 帮助</button></div>${searchForm()}<div class="journey-hero"><img src="assets/orchard.jpg" alt="果园示意图片"><div class="journey-hero-shade"></div><div class="journey-hero-copy"><span>一方水土，一份家乡味</span><h1>从景泰出发，<br>把好物带回家。</h1><p>先认识产地与采购者，<br>再慢慢挑一份喜欢的味道。</p>${featured ? `<button data-action="view-product" data-product="${esc(featured.id)}">看看${esc(featured.name)} ${icon('arrow', 17)}</button>` : navigate('regions', '先逛产区', 'journey-hero-button')}</div><span class="journey-photo-note">图片为示意</span></div><nav class="journey-shortcuts" aria-label="发现好物"><button data-action="navigate" data-route="regions"><span>${icon('pin', 24)}</span><strong>逛产区</strong><small>看看好物来处</small></button><button data-action="navigate" data-route="shops"><span>${icon('user', 24)}</span><strong>认识采购者</strong><small>走进他们的店</small></button><button data-action="navigate" data-route="origin"><span>${icon('leaf', 24)}</span><strong>采收视频</strong><small>从田间看起</small></button></nav>${directoryStatus(current)}<section class="journey-section">${heading('沿着产区去发现', '从家乡开始，慢慢认识更多地方', navigate('regions', '全部产区'))}${regions.length ? `<div class="journey-region-strip" aria-label="产区列表">${regions.slice(0, 5).map(region => regionCard(region, true)).join('')}</div>` : !current.error && current.ready ? empty('产区档案正在准备', '商品与产区信息更新后，再一起走走。') : ''}</section><section class="journey-section">${heading('认识好物背后的采购者', '进店看看介绍、商品与采收素材', navigate('shops', '全部店铺'))}${shops.length ? `<div class="journey-shop-list">${shops.slice(0, 2).map(shopCard).join('')}</div>` : !current.error && current.ready ? empty('采购者店铺正在准备', '上架商品的采购者店铺会在这里展示。') : ''}</section><section class="journey-section">${heading('当季好物，慢慢挑', '鲜果、干货和家常蔬菜，都可以点开看', navigate('specialties', '特产馆'))}${productGrid(items.slice(0, 6))}</section>${footnote()}</section>`;
  }

  function regions() {
    const current = state();
    const provinces = [...new Set(current.regions.map(region => region.province))];
    if (province !== 'all' && !provinces.includes(province)) province = 'all';
    const visible = current.regions.filter(region => province === 'all' || region.province === province);
    return `${api.title('逛产区', 'home')}<section class="journey-page"><header class="journey-page-intro"><span class="journey-kicker">好物有来处</span><h1>循着家乡味，<br>认识一方水土。</h1><p>先从景泰走起。筹备中的地方可以先认识，暂没有商品可选购。</p></header>${directoryStatus(current)}${current.ready && !current.error ? `<div class="journey-filter-strip" role="group" aria-label="按省份筛选产区">${[['all', '全部产区'], ...provinces.map(value => [value, value])].map(([id, label]) => `<button data-action="journey-province" data-province="${esc(id)}" aria-pressed="${province === id}" class="${province === id ? 'is-selected' : ''}">${esc(label)}</button>`).join('')}</div><div class="journey-list-heading"><h2>${province === 'all' ? '从这里出发' : esc(province)}</h2><span>${visible.length} 个产区</span></div>${visible.length ? `<div class="journey-region-list">${visible.map(region => regionCard(region)).join('')}</div>` : empty('暂时没有产区档案', '有新的产区信息后，会在这里展示。')}` : ''}${footnote()}</section>`;
  }

  function shops() {
    const current = state();
    if (shopRegion !== 'all' && !current.regions.some(region => region.id === shopRegion)) shopRegion = 'all';
    const visible = current.shops.filter(shop => shopRegion === 'all' || shop.regionIds.includes(shopRegion));
    return `${api.title('采购者店铺', 'home')}<section class="journey-page"><header class="journey-page-intro"><span class="journey-kicker">把产地和人连起来</span><h1>先认识采购者，<br>再逛他们的好物。</h1><p>查看店铺介绍、产区与商品。当前采购者档案均为模拟资料。</p></header>${directoryStatus(current)}${current.ready && !current.error ? `<div class="journey-filter-strip" role="group" aria-label="按产区筛选店铺">${[['all', '全部店铺'], ...current.regions.map(region => [region.id, region.name])].map(([id, label]) => `<button data-action="journey-shop-region" data-region="${esc(id)}" aria-pressed="${shopRegion === id}" class="${shopRegion === id ? 'is-selected' : ''}">${esc(label)}</button>`).join('')}</div><div class="journey-list-heading"><h2>产地采购者</h2><span>${visible.length} 家店铺</span></div>${visible.length ? `<div class="journey-shop-list">${visible.map(shopCard).join('')}</div>` : empty('这个产区的采购者还在准备', '可以先到其他产区的店铺逛逛。', navigate('regions', '逛产区'))}` : ''}${footnote()}</section>`;
  }

  function region(id) {
    const current = state(), place = byId(current.regions, id);
    const back = api.backRoute?.('region', id, 'regions') || 'regions';
    if (!current.ready || current.error) return `${api.title('产区详情', back)}<section class="journey-page">${directoryStatus(current)}</section>`;
    if (!place) return `${api.title('产区详情', back)}<section class="journey-page">${empty('这份产区档案暂不可用', '可以返回产区列表，看看其他地方。', navigate('regions', '返回产区'))}</section>`;
    const items = regionProducts(place), relatedShops = current.shops.filter(shop => place.shopIds.includes(shop.id) && shop.regionIds.includes(place.id));
    return `${api.title('产区详情', back)}<section class="journey-page"><div class="journey-place-hero"><img src="${esc(place.image || 'assets/orchard.jpg')}" alt="${esc(place.name)}产区示意图片"><div></div><span class="journey-badge">${place.preview ? '筹备示意' : esc(place.province)}</span><h1>${esc(place.name)}</h1><p>${esc(place.subtitle || '看看这一方水土的好物')}</p><span class="journey-photo-note">示意图片</span></div><section class="journey-panel journey-place-intro"><span class="journey-kicker">认识产地</span><h2>${place.preview ? '先认识，再慢慢准备' : '好物的故事，从这里开始'}</h2><p>${esc(place.description)}</p>${place.preview ? '<p class="journey-notice">这里是未来产区的筹备示意，尚无上架商品，也不代表已建立采购合作。</p>' : '<p class="journey-muted">产区介绍为模拟资料，图片不作为真实产地证明。</p>'}</section><section class="journey-section">${heading('这里的采购者', '进店看看由谁整理这些好物')}${relatedShops.length ? `<div class="journey-shop-list">${relatedShops.map(shopCard).join('')}</div>` : empty('采购者资料待补充', '有店铺资料后，会在这里展示。')}</section><section class="journey-section">${heading('这一方好物', `${items.length} 款上架商品`)}${place.preview ? empty('这个产区暂未上架商品', '先逛逛景泰，后面再认识更多地方。', navigate('regions', '继续逛产区')) : productGrid(items)}</section>${!place.preview ? videoSection(items, '从田间看起') : ''}${footnote()}</section>`;
  }

  function videoSection(items, name) {
    const first = items.find(item => api.videoFor?.(item)) || items[0];
    return `<section class="journey-section">${heading(name, '查看商品绑定的采收素材与介绍', navigate('origin', '采收内容'))}${first ? `<div class="journey-video-panel"><div class="journey-video-heading"><h3>${esc(first.name)}</h3><button class="journey-link" data-action="view-product" data-product="${esc(first.id)}" data-section="harvest">商品采收介绍 ${icon('arrow', 16)}</button></div>${api.videoBlock(first)}</div>` : empty('采收素材待补充', '商品上架并补充素材后，会展示对应的采收介绍。')}</section>`;
  }

  function shop(id) {
    const current = state(), store = byId(current.shops, id);
    const back = api.backRoute?.('shop', id, 'shops') || 'shops';
    if (!current.ready || current.error) return `${api.title('采购者店铺', back)}<section class="journey-page">${directoryStatus(current)}</section>`;
    if (!store) return `${api.title('采购者店铺', back)}<section class="journey-page">${empty('这家店铺暂不可用', '店铺可能正在调整，可以先去其他店铺逛逛。', navigate('shops', '查看采购者店铺'))}</section>`;
    const filter = shopFilters.get(store.id) || { category: 'all', inStock: false };
    const allItems = shopProducts(store), items = allItems.filter(item => (filter.category === 'all' || item.category === filter.category) && (!filter.inStock || stockAvailable(item)));
    const places = current.regions.filter(place => store.regionIds.includes(place.id));
    return `${api.title('采购者店铺', back)}<section class="journey-page"><header class="journey-store-header"><span class="journey-store-symbol">${icon('leaf', 34)}</span><span class="journey-kicker">${store.preview ? '筹备店铺示意' : '产地采购者 · 模拟档案'}</span><h1>${esc(store.name)}</h1><p>${esc(store.regionLabel || '产区资料待补充')}</p><div class="journey-store-stats"><span><strong>${allItems.length}</strong> 款上架好物</span><button data-action="support">${icon('chat', 18)} 咨询与帮助</button></div></header><section class="journey-panel"><div class="journey-procurer"><span>${icon('user', 23)}</span><div><h2>${esc(store.procurementName || '采购者资料待补充')}</h2><p>模拟采购者简介</p></div></div><p>${esc(store.description)}</p>${store.preview ? '<p class="journey-notice">暂未建立实际采购合作，也没有上架商品。</p>' : '<div class="journey-workflow" aria-label="采购工作流程示意"><span><b>01</b>了解采收</span><span><b>02</b>整理分拣</span><span><b>03</b>记录包装</span></div><p class="journey-muted">工作流程为演示结构，具体采收和包装以商品资料为准。</p>'}<div class="journey-shop-places">${places.map(place => navigate(routeTo('region', place.id), `${icon('pin', 15)} ${esc(place.name)}`)).join('')}</div></section><section class="journey-section">${heading('店里的好物', '只展示这位采购者名下的上架商品')}${store.preview ? empty('好物还在筹备中', '这家店目前不能选购，可以到其他采购者店铺看看。', navigate('shops', '逛其他店铺')) : `<div class="journey-filter-strip" role="group" aria-label="店铺商品分类">${CATEGORIES.map(([value, label]) => `<button data-action="journey-shop-category" data-shop="${esc(store.id)}" data-category="${value}" class="${filter.category === value ? 'is-selected' : ''}" aria-pressed="${filter.category === value}">${label}</button>`).join('')}</div><div class="journey-stock-filter"><span role="status">${items.length} 款好物</span><button data-action="journey-shop-stock" data-shop="${esc(store.id)}" aria-pressed="${filter.inStock}" class="${filter.inStock ? 'is-selected' : ''}"><span class="journey-check">${filter.inStock ? icon('check', 13) : ''}</span>只看有货</button></div>${items.length ? productGrid(items) : empty('这个筛选下暂时没有好物', filter.inStock ? '部分商品正在备货，可以取消“只看有货”再逛逛。' : '试试其他分类，看看店里的其他好物。', '<button class="journey-button" data-action="journey-shop-reset" data-shop="'+esc(store.id)+'">查看全部商品</button>')}`}</section>${!store.preview ? videoSection(allItems, '看看采购者的采收介绍') : ''}${footnote()}</section>`;
  }

  function productContext(item) {
    const current = state();
    if (!item) return '';
    if (!current.ready || current.error) return `<aside class="journey-product-context">${directoryStatus(current)}</aside>`;
    const store = current.shops.find(shop => !shop.preview && shop.productIds.includes(item.id));
    const place = current.regions.find(region => !region.preview && region.productIds.includes(item.id) && (!store || store.regionIds.includes(region.id)));
    if (!store || !place) return '<aside class="journey-product-context"><div class="journey-context-unavailable"><span>'+icon('pin', 18)+'</span><p>这款商品的产区或采购者档案暂不可用。</p></div></aside>';
    return `<aside class="journey-product-context"><nav class="journey-breadcrumbs" aria-label="商品的产区与店铺">${navigate('regions', '逛产区')}${navigate(routeTo('region', place.id), esc(place.name))}</nav><button class="journey-context-shop" data-action="navigate" data-route="${esc(routeTo('shop', store.id))}"><span class="journey-context-icon">${icon('user', 21)}</span><span><strong>${esc(store.name)}</strong><small>${esc(store.procurementName || '采购者资料待补充')} · 模拟采购档案</small></span><span class="journey-context-visit">进店 ${icon('arrow', 16)}</span></button></aside>`;
  }

  function search(id) {
    if (id !== undefined) keyword = String(id).trim().slice(0, 40);
    const current = state(), query = keyword.toLocaleLowerCase();
    const related = current.ready && !current.error ? current.shops.filter(store => !store.preview && [store.name, store.procurementName, store.regionLabel].some(value => String(value || '').toLocaleLowerCase().includes(query))).flatMap(store => store.productIds) : [];
    const items = query ? catalog().filter(item => related.includes(item.id) || [item.name, item.subtitle, item.origin, ...(item.tags || [])].some(value => String(value || '').toLocaleLowerCase().includes(query))) : [];
    return `${api.title('搜索好物', 'home')}<section class="journey-page journey-search-page">${searchForm()}${keyword ? `<div class="journey-search-summary"><div><h1>“${esc(keyword)}”</h1><p role="status">找到 ${items.length} 款上架好物</p></div><button class="journey-link" data-action="journey-clear-search">清空搜索</button></div>${items.length ? productGrid(items) : empty('还没有找到这份味道', '试试商品名、产区或采购者店名，例如“苹果”“景泰”。', navigate('specialties', '去特产馆看看'))}` : `<header class="journey-page-intro"><h1>你想找哪份家乡味？</h1><p>可以搜索商品名、产区或采购者店名。</p></header><div class="journey-filter-strip" aria-label="搜索示例">${['苹果', '枸杞', '景泰'].map(value => `<button data-action="journey-search-example" data-keyword="${value}">${value}</button>`).join('')}</div>`}${footnote()}</section>`;
  }

  function handleClick(dataset) {
    const d = dataset || {};
    switch (d.action) {
      case 'journey-province':
        if (d.province === 'all' || state().regions.some(region => region.province === d.province)) province = d.province;
        api.render(true); return true;
      case 'journey-shop-region':
        if (d.region === 'all' || state().regions.some(region => region.id === d.region)) shopRegion = d.region;
        api.render(true); return true;
      case 'journey-shop-category':
      case 'journey-shop-stock':
      case 'journey-shop-reset': {
        if (!state().shops.some(store => !store.preview && store.id === d.shop)) return true;
        const previous = shopFilters.get(d.shop) || { category: 'all', inStock: false };
        if (d.action === 'journey-shop-category' && CATEGORIES.some(([value]) => value === d.category)) shopFilters.set(d.shop, { ...previous, category: d.category });
        if (d.action === 'journey-shop-stock') shopFilters.set(d.shop, { ...previous, inStock: !previous.inStock });
        if (d.action === 'journey-shop-reset') shopFilters.delete(d.shop);
        api.render(true); return true;
      }
      case 'journey-clear-search': keyword = ''; api.nav('search'); return true;
      case 'journey-search-example': keyword = String(d.keyword || '').trim().slice(0, 40); api.nav(keyword ? routeTo('search', keyword) : 'search'); return true;
    }
    return false;
  }

  function handleSubmit(event) {
    if (event.target?.id !== 'journey-search') return false;
    event.preventDefault();
    keyword = String(event.target.elements?.namedItem('keyword')?.value || '').trim().slice(0, 40);
    api.nav(keyword ? routeTo('search', keyword) : 'search');
    return true;
  }

  function beforeRender(page, id) {
    if (page === 'search') keyword = id === undefined ? '' : String(id).trim().slice(0, 40);
  }

  return { home, regions, region, shops, shop, productContext, routes: { regions, region, shops, shop, search }, handleClick, handleSubmit, beforeRender };
}
