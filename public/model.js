function freezeProduct(product) {
  return Object.freeze({
    ...product,
    tags: Object.freeze(product.tags),
    facts: Object.freeze(product.facts.map(row => Object.freeze(row))),
    harvestSteps: Object.freeze(product.harvestSteps.map(step => Object.freeze(step))),
    variants: Object.freeze(product.variants.map(variant => Object.freeze(variant)))
  });
}

// All product descriptions, origins, specifications and prices are demo data.
export const BASE_CATALOG = Object.freeze([
  {
    id: 'jingtai-apple', category: 'fruit', image: 'assets/apples.jpg',
    name: '景泰红富士苹果', origin: '甘肃 · 白银 · 景泰（模拟产地）',
    subtitle: '一口清脆，尝到家乡的秋天',
    tags: ['红富士 · 示例品种', '两种净重可选', '普通装示意'],
    summary: '75–85mm红富士苹果，果肉脆口，适合日常鲜食。2.5kg约10–14颗，5kg约20–28颗，按净重配箱，颗数随果实大小浮动。规格为模拟示例。',
    storage: '置于阴凉通风处，远离热源与阳光；需冷藏时分袋放入果蔬区，食用前再清洗，磕碰果优先食用。',
    sizeNote: '每箱净重，不含包装；分级仅为示例',
    facts: [['品种', '红富士，脆口鲜食'], ['果径', '75–85mm，按大小分拣'], ['产地', '甘肃景泰（模拟）'], ['包装', '单果保护内衬 + 外层纸箱']],
    harvestSteps: [
      { title: '成熟采摘', text: '轻托果实并轻轻旋摘，避免硬拉果柄，让采下的苹果轻放入周转筐。' },
      { title: '分拣称重', text: '逐颗查看外观并按75–85mm果径分拣，剔除破损果后称量净重。' },
      { title: '装箱保护', text: '每颗苹果使用保护内衬，分层放入纸箱，填稳空隙后封箱标记规格。' }
    ],
    variants: [
      { id: 'small', label: '尝鲜装', weight: '净重 2.5kg', price: 4990, hint: '一人也能好好吃水果' },
      { id: 'family', label: '家庭装', weight: '净重 5kg', price: 7990, hint: '和家人一起分享' }
    ]
  },
  {
    id: 'goji', category: 'dried', image: 'assets/goji.jpg',
    name: '景泰干枸杞', origin: '甘肃景泰（模拟）',
    subtitle: '一小袋红果，认识西北的日常风味',
    tags: ['干果 · 示例', '100g / 250g', '食品展示演示'],
    summary: '红色干枸杞长约1–2cm，表面自然皱缩，适合煮粥或搭配日常饮食。100g小袋尝鲜，250g适合分享，采用密封袋分装。规格为模拟示例。',
    storage: '密封放于阴凉、干燥、避光处，避免靠近灶台与水汽；用干燥勺具取用，开袋后及时封紧，少量分次使用。',
    sizeNote: '每袋净含量，不含包装；等级待真实货源确认',
    facts: [['商品形态', '红色干果，颗粒长约1–2cm'], ['净含量', '100g / 250g，按袋称量'], ['产地', '甘肃景泰（模拟）'], ['包装', '食品接触密封袋，开袋后封紧']],
    harvestSteps: [
      { title: '采收干制', text: '成熟红果轻采后浅层摊放，再进行干制，尽量减少挤压和果粒破损。' },
      { title: '筛选检查', text: '干制后筛出枝梗与明显破碎果，按颗粒外观整理，保留自然褶皱。' },
      { title: '称量封装', text: '按100g或250g称量入袋，封口后检查袋体完整与标识清晰。' }
    ],
    variants: [
      { id: 'small', label: '尝鲜装', weight: '净含量 100g', price: 1990, hint: '小袋体验，按需选择' },
      { id: 'family', label: '分享装', weight: '净含量 250g', price: 3990, hint: '密封保存，和家人分享日常风味' }
    ]
  },
  {
    id: 'pear', category: 'fruit', image: 'assets/pear.jpg',
    name: '景泰鲜梨', origin: '甘肃 · 白银 · 景泰（模拟产地）',
    subtitle: '清爽的果香，装进日常果盘',
    tags: ['鲜梨 · 示例', '两种净重可选', '品种待确认'],
    summary: '圆润鲜梨以单果200–300g为例，果肉脆爽。2.5kg约8–12颗，5kg约16–24颗，按净重配箱，单果网套与隔板减轻碰撞。规格为模拟示例。',
    storage: '轻拿轻放，先检查果面；置于阴凉通风处或装袋冷藏，食用前再清洗，切开的梨密封冷藏并尽快食用。',
    sizeNote: '每箱净重，不含包装；单果大小为示例',
    facts: [['商品形态', '圆形鲜梨，脆爽口感'], ['单果大小', '约200–300g，颗数随大小浮动'], ['产地', '甘肃景泰（模拟）'], ['包装', '单果网套 + 分层隔板 + 纸箱']],
    harvestSteps: [
      { title: '轻手采摘', text: '手掌轻托果实，连果柄轻采入筐，果面避免指甲划伤和相互磕碰。' },
      { title: '分拣称重', text: '按约200–300g单果大小分拣，剔出破损果，再依据所选净重配箱。' },
      { title: '缓冲装箱', text: '单果套上保护网套，纸箱内加隔板分层摆放，填稳空隙后再封箱。' }
    ],
    variants: [
      { id: 'small', label: '尝鲜装', weight: '净重 2.5kg', price: 3990, hint: '先尝一箱，认识这份清爽' },
      { id: 'family', label: '家庭装', weight: '净重 5kg', price: 6990, hint: '适合一家人的日常果盘' }
    ]
  },
  {
    id: 'potato', category: 'vegetable', image: 'assets/potato.jpg',
    name: '景泰土豆', origin: '甘肃 · 白银 · 景泰（模拟产地）',
    subtitle: '一份朴实的洋芋，做一桌家常饭',
    tags: ['食用土豆 · 示例', '两种净重可选', '品种待确认'],
    summary: '中等个头食用土豆，单个长约4–8cm，表皮保留少量浮土，适合切丝清炒或切块炖煮。2.5kg与5kg按净重分装，透气内袋配纸箱。规格为模拟示例。',
    storage: '置于避光、干燥、通风处，拆开外箱检查后松散摆放，避免密封积潮；发芽、变绿或腐坏的土豆不要食用。',
    sizeNote: '每份净重，不含包装；表皮和大小差异需按实货说明',
    facts: [['商品形态', '未清洗食用土豆，带少量浮土'], ['大小', '单个长约4–8cm，外皮颜色有差异'], ['产地', '甘肃景泰（模拟）'], ['包装', '透气内袋 + 遮光纸箱']],
    harvestSteps: [
      { title: '采收晾干', text: '采后先摊放阴干表面水分，轻除浮土，避免清洗后带水进入包装。' },
      { title: '筛选分级', text: '挑出发芽、变绿、腐坏和明显损伤的土豆，再按约4–8cm大小分拣。' },
      { title: '避光包装', text: '按2.5kg或5kg称重，装入透气内袋与遮光纸箱，减少挤压和闷湿。' }
    ],
    variants: [
      { id: 'small', label: '尝鲜装', weight: '净重 2.5kg', price: 1990, hint: '少量选购，做几道家常菜' },
      { id: 'family', label: '家庭装', weight: '净重 5kg', price: 3290, hint: '按家庭消耗量选择，注意避光保存' }
    ]
  },
  {
    id: 'corn', category: 'vegetable', image: 'assets/corn.jpg',
    name: '景泰鲜食玉米', origin: '甘肃 · 白银 · 景泰（模拟产地）',
    subtitle: '把一份玉米香，留给家常餐桌',
    tags: ['生鲜玉米 · 示例', '按根计量', '非真空熟制品'],
    summary: '鲜食玉米以16–20cm果穗为例，颗粒排列紧实，适合煮、蒸等家常做法。6根或10根按数装箱，保留包叶并用纸箱减轻碰撞。规格为模拟示例。',
    storage: '收货后检查果穗，尽快冷藏并及时煮熟食用；暂不食用时可分装冷冻，避免反复解冻，生熟食材分开放置。',
    sizeNote: '按根计量；单根大小、净重与保鲜要求待实货确认',
    facts: [['商品形态', '生鲜玉米，需煮熟食用'], ['果穗规格', '约16–20cm，单根约200–300g'], ['产地', '甘肃景泰（模拟）'], ['计量与包装', '6根 / 10根，包叶与保温内衬加纸箱']],
    harvestSteps: [
      { title: '适时采收', text: '在鲜食成熟阶段采收，轻放果穗并整理包叶，减少果粒磕碰和失水。' },
      { title: '挑选计数', text: '按16–20cm果穗长度挑选，检查明显虫伤与缺粒，再核对装箱根数。' },
      { title: '保鲜包装', text: '装箱前尽快降温，保留包叶并分层摆放，配合适合生鲜的保温包装。' }
    ],
    variants: [
      { id: 'small', label: '尝鲜装', weight: '6根', price: 2990, hint: '按根数体验，单根大小仅为示意' },
      { id: 'family', label: '家庭装', weight: '10根', price: 4590, hint: '按家庭需要选择，正式保鲜条件待确认' }
    ]
  },
  {
    id: 'onion', category: 'vegetable', image: 'assets/onion.jpg',
    name: '景泰洋葱', origin: '甘肃 · 白银 · 景泰（模拟产地）',
    subtitle: '一颗洋葱，添一份家常香气',
    tags: ['鲜洋葱 · 示例', '两种净重可选', '颜色品种待确认'],
    summary: '紫红皮鲜洋葱以球径6–9cm、单颗约150–250g为例，层片紧实，切丝炒菜或炖煮都方便。2.5kg与5kg按净重装箱。规格为模拟示例。',
    storage: '整颗置于干燥、阴凉、通风处，保留干燥外皮，避免密封积潮；切开后放入密封盒冷藏并尽快使用。',
    sizeNote: '每份净重，不含包装；单颗大小与外皮差异为示例',
    facts: [['商品形态', '紫红皮未加工鲜洋葱'], ['大小', '球径约6–9cm，单颗约150–250g'], ['产地', '甘肃景泰（模拟）'], ['包装', '透气网袋 + 外层纸箱']],
    harvestSteps: [
      { title: '采收整理', text: '采后晾干表皮与根颈，整理多余根叶，保留完整干燥外皮保护葱球。' },
      { title: '分拣称重', text: '挑出腐坏、软烂和明显磕伤的洋葱，按6–9cm球径分拣，再核对净重。' },
      { title: '通风包装', text: '用透气网袋装好后放入纸箱，避免密封积潮，填稳空隙减轻碰撞。' }
    ],
    variants: [
      { id: 'small', label: '尝鲜装', weight: '净重 2.5kg', price: 1690, hint: '小份选购，搭配日常菜肴' },
      { id: 'family', label: '家庭装', weight: '净重 5kg', price: 2690, hint: '先看消耗量，再选择合适规格' }
    ]
  }
].map(product => freezeProduct({
  ...product, status: 'published',
  video: '',
  videoTitle: '采收视频 · 待补充',
  videoNote: '暂无视频，后续可选择上传模拟素材。'
})));

export let CATALOG = BASE_CATALOG;
export let PRODUCT = BASE_CATALOG[0];

export function normalizeCatalogProduct(input, fallback = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('商品资料格式无效');
  const source = { ...fallback, ...input };
  const text = (value, label, max, required = false) => {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${label}${required ? '必填且' : ''}最多${max}字`);
    return value.trim();
  };
  if (typeof source.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(source.id)) throw new Error('商品编号需为2至64位小写字母、数字或连字符');
  if (!['fruit', 'dried', 'vegetable'].includes(source.category)) throw new Error('请选择有效的商品分类');
  if (!['published', 'draft', 'offline'].includes(source.status)) throw new Error('商品状态无效');
  if (typeof source.image !== 'string' || !/^assets\/(?!.*\.\.)[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp|gif|svg)$/.test(source.image)) throw new Error('请选择有效的商品示意图片');
  const video = source.video ?? '';
  if (typeof video !== 'string' || (video && !/^assets\/(?!.*\.\.)[a-zA-Z0-9/_-]+\.(mp4|webm|mov)$/.test(video))) throw new Error('商品视频路径无效');
  const stringList = (values, label, maxLength) => {
    if (!Array.isArray(values) || values.length > 12) throw new Error(`${label}格式无效`);
    return values.map(value => text(value, label, maxLength));
  };
  if (!Array.isArray(source.facts) || source.facts.length > 20 || source.facts.some(row => !Array.isArray(row) || row.length !== 2)) throw new Error('商品事实资料格式无效');
  if (!Array.isArray(source.harvestSteps) || source.harvestSteps.length > 12 || source.harvestSteps.some(step => !step || typeof step !== 'object')) throw new Error('采收记录格式无效');
  if (!Array.isArray(source.variants) || source.variants.length !== 2 || new Set(source.variants.map(value => value?.id)).size !== 2) throw new Error('商品需保留两种规格');
  const variants = ['small', 'family'].map(id => {
    const value = source.variants.find(variant => variant?.id === id);
    if (!value) throw new Error('规格编号需为small和family');
    const variant = { ...fallback.variants?.find(item => item.id === id), ...value };
    if (!Number.isSafeInteger(variant.price) || variant.price < 1 || variant.price > 999999) throw new Error('规格价格需为1至999999分的整数');
    return { id, label: text(variant.label, '规格名称', 40, true), weight: text(variant.weight, '规格数量或净重', 80, true), price: variant.price, hint: text(variant.hint ?? '', '规格提示', 200) };
  });
  const product = {
    id: source.id, name: text(source.name, '商品名称', 40, true), category: source.category,
    status: source.status, image: source.image, origin: text(source.origin ?? '', '产地', 120),
    subtitle: text(source.subtitle ?? '', '简述', 160), summary: text(source.summary ?? '', '商品介绍', 2000),
    storage: text(source.storage ?? '', '储存说明', 1000), sizeNote: text(source.sizeNote ?? '', '规格说明', 300),
    tags: stringList(source.tags ?? [], '标签', 40),
    facts: source.facts.map(([key, value]) => [text(key, '资料名称', 60), text(value, '资料内容', 300)]),
    harvestSteps: source.harvestSteps.map(step => ({ title: text(step.title, '采收步骤名称', 60), text: text(step.text, '采收步骤内容', 1000) })),
    variants, video, videoTitle: text(source.videoTitle ?? '', '视频标题', 120), videoNote: text(source.videoNote ?? '', '视频说明', 1000)
  };
  for (const key of ['imageMediaId', 'videoMediaId']) {
    if (source[key] !== undefined && source[key] !== '') product[key] = text(source[key], '媒体编号', 120, true);
  }
  return freezeProduct(product);
}

export function setCatalog(items) {
  if (!Array.isArray(items) || items.length > 200) throw new Error('商品目录格式无效');
  const next = items.map(item => normalizeCatalogProduct(item));
  if (new Set(next.map(item => item.id)).size !== next.length) throw new Error('商品编号不能重复');
  CATALOG = Object.freeze(next);
  PRODUCT = CATALOG.find(item => item.id === 'jingtai-apple') || BASE_CATALOG[0];
  return CATALOG;
}

export function isProductAvailable(product) { return product?.status === 'published'; }

export function getProduct(id) { return CATALOG.find(product => product.id === id) || null; }
export const ADDRESSES = Object.freeze([
  { id: 'gansu', label: '甘肃省内', person: '体验用户 A', phone: '演示号码（无需填写）', address: '甘肃省兰州市 · 示例收货地址', shipping: 600 },
  { id: 'shaanxi', label: '陕西地区', person: '体验用户 B', phone: '演示号码（无需填写）', address: '陕西省西安市 · 示例收货地址', shipping: 1000 },
  { id: 'other', label: '其他地区', person: '体验用户 C', phone: '演示号码（无需填写）', address: '其他地区 · 待确认配送范围', shipping: null }
]);
export const STORAGE_KEY = 'longshang-demo-orders-v1';
export const CART_KEY = 'longshang-demo-cart-v1';

export function validCart(value) {
  if (!Array.isArray(value)) return [];
  const entries = [], bySku = new Map();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const product = getProduct(row.productId);
    if (!product?.variants.some(variant => variant.id === row.variant)
      || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 10
      || (row.selected !== undefined && typeof row.selected !== 'boolean')) continue;
    const key = `${product.id}::${row.variant}`;
    const selected = row.selected ?? true;
    const existing = bySku.get(key);
    if (existing) {
      existing.quantity = Math.min(10, existing.quantity + row.quantity);
      existing.selected = existing.selected || selected;
    } else if (entries.length < 12) {
      const entry = { productId: product.id, variant: row.variant, quantity: row.quantity, selected };
      entries.push(entry); bySku.set(key, entry);
    }
  }
  return entries;
}

export function addToCart(cart, selection) {
  const product = getProduct(selection?.productId);
  if (!product?.variants.some(variant => variant.id === selection.variant)) throw new Error('请选择有效的商品与规格');
  if (!isProductAvailable(product)) throw new Error('这款商品已下架或尚未上架，暂不能加入购物车');
  const quantity = selection.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('商品数量需为正整数');
  const result = validCart(cart);
  const existing = result.find(row => row.productId === product.id && row.variant === selection.variant);
  if (existing) {
    existing.quantity = Math.min(10, existing.quantity + quantity);
    existing.selected = true;
  } else {
    if (result.length >= 12) throw new Error('购物车最多保留12种规格');
    result.push({ productId: product.id, variant: selection.variant, quantity: Math.min(10, quantity), selected: true });
  }
  return result;
}

export function quoteCart(cart, addressId = 'gansu') {
  const address = ADDRESSES.find(item => item.id === addressId) || ADDRESSES[0];
  const items = validCart(cart).filter(row => row.selected).map(row => {
    const product = getProduct(row.productId);
    const variant = product.variants.find(item => item.id === row.variant);
    return {
      productId: product.id, product: product.name, image: product.image,
      ...(product.imageMediaId ? { imageMediaId: product.imageMediaId } : {}),
      variant: variant.id, variantLabel: variant.label, weight: variant.weight,
      unitPrice: variant.price, quantity: row.quantity, subtotal: variant.price * row.quantity
    };
  });
  const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
  const shipping = address.shipping;
  const unavailableItems = items.filter(item => !isProductAvailable(getProduct(item.productId)));
  const available = items.length > 0 && unavailableItems.length === 0;
  return { items, quantity, subtotal, shipping, total: !available || shipping === null ? null : subtotal + shipping, address, unavailableItems, available };
}

export function createCartOrder(cart, addressId, id, createdAt = new Date().toISOString()) {
  const q = quoteCart(cart, addressId);
  if (!q.items.length) throw new Error('请先选择需要结算的商品');
  if (q.unavailableItems.length) throw new Error('选中商品包含已下架或尚未上架的商品，请先移除或取消勾选');
  if (q.total === null) throw new Error('请选择支持演示的配送地区');
  const first = q.items[0];
  const productCount = new Set(q.items.map(item => item.productId)).size;
  return {
    id, createdAt, ...first,
    product: productCount > 1 ? `${first.product}等${productCount}款商品` : first.product,
    items: q.items, quantity: q.quantity, subtotal: q.subtotal,
    shipping: q.shipping, total: q.total, address: q.address.id, status: 'created'
  };
}

export function quote(variantId = 'small', quantity = 1, addressId = 'gansu', productId = PRODUCT.id) {
  const product = getProduct(productId);
  if (!product) throw new Error('商品不存在，请重新选择');
  const variant = product.variants.find(v => v.id === variantId) || product.variants[0];
  const address = ADDRESSES.find(a => a.id === addressId) || ADDRESSES[0];
  const qty = Math.min(10, Math.max(1, Math.floor(Number(quantity) || 1)));
  const subtotal = variant.price * qty;
  const available = isProductAvailable(product);
  return { product, variant, address, quantity: qty, subtotal, shipping: address.shipping, total: !available || address.shipping === null ? null : subtotal + address.shipping, available };
}
export const money = cents => (cents / 100).toFixed(2);

export function createOrder(selection, id, createdAt = new Date().toISOString()) {
  const q = quote(selection.variant, selection.quantity, selection.address, selection.productId);
  if (!q.available) throw new Error('这款商品已下架或尚未上架，暂不能生成订单');
  if (q.total === null) throw new Error('请选择支持演示的配送地区');
  return {
    id, createdAt, productId: q.product.id, product: q.product.name, image: q.product.image,
    ...(q.product.imageMediaId ? { imageMediaId: q.product.imageMediaId } : {}),
    variant: q.variant.id, variantLabel: q.variant.label, weight: q.variant.weight,
    unitPrice: q.variant.price, quantity: q.quantity, subtotal: q.subtotal,
    shipping: q.shipping, total: q.total, address: q.address.id, status: 'created'
  };
}

const AFTER_SALE_TYPES = ['refund', 'replacement'];
const AFTER_SALE_REASONS = ['damaged', 'spec', 'delivery', 'other'];
const AFTER_SALE_STATUSES = ['submitted', 'resolved', 'withdrawn'];
const isDate = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isPlainText = (value, maxLength) => typeof value === 'string' && value.length <= maxLength && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const isDescription = value => typeof value === 'string' && value.length <= 300;
const isAfterSaleId = value => isPlainText(value, 100) && value.trim().length > 0;

export function createAfterSale(order, input, id, now = new Date().toISOString()) {
  if (!order || order.status !== 'created') throw new Error('仅已生成的演示订单可申请售后');
  if (order.afterSale?.status === 'submitted') throw new Error('这笔订单已有待处理的演示售后，请勿重复申请');
  if (!input || !AFTER_SALE_TYPES.includes(input.type)) throw new Error('请选择演示售后方式');
  if (!AFTER_SALE_REASONS.includes(input.reason)) throw new Error('请选择演示售后原因');
  if (!isDescription(input.description)) throw new Error('问题描述限300字以内');
  if (typeof input.hasEvidence !== 'boolean') throw new Error('请确认是否有演示凭证');
  if (!isAfterSaleId(id) || !isDate(now)) throw new Error('演示售后编号或时间无效');
  return {
    ...order,
    afterSale: {
      id, type: input.type, reason: input.reason, description: input.description.trim(),
      hasEvidence: input.hasEvidence, status: 'submitted', createdAt: now, updatedAt: now
    }
  };
}

export function updateAfterSale(order, status, now = new Date().toISOString()) {
  if (!['resolved', 'withdrawn'].includes(status)) throw new Error('演示售后仅可标记处理完成或撤回');
  const afterSale = cleanAfterSale(order?.afterSale);
  if (!afterSale || afterSale.status !== 'submitted') throw new Error('仅待处理的演示售后可变更状态');
  if (!isDate(now) || Date.parse(now) < Date.parse(afterSale.updatedAt)) throw new Error('演示售后更新时间无效');
  return { ...order, afterSale: { ...afterSale, status, updatedAt: now } };
}

export function shipOrder(order, carrier, tracking, now = new Date().toISOString()) {
  if (!order || order.status !== 'created') throw new Error('已取消的订单不能发货');
  if (order.afterSale?.status === 'resolved' && order.afterSale.type === 'refund') throw new Error('已完成整单模拟退款的订单不能发货');
  if (order.fulfillment?.status === 'shipped') throw new Error('这笔演示订单已发货，请勿重复操作');
  if (order.afterSale?.status === 'submitted') throw new Error('请先处理或撤回待处理的售后申请');
  if (typeof carrier !== 'string' || !carrier.trim() || carrier.length > 40) throw new Error('快递名称必填且最多40字');
  if (typeof tracking !== 'string' || !/^DEMO-[A-Z0-9-]{1,75}$/i.test(tracking.trim())) throw new Error('请填写以DEMO-开头的演示单号');
  if (!isDate(now)) throw new Error('演示发货时间无效');
  return { ...order, fulfillment: { status: 'shipped', carrier: carrier.trim(), tracking: tracking.trim(), shippedAt: now } };
}

export function saveOrderNote(order, note) {
  if (!order || !['created', 'cancelled'].includes(order.status)) throw new Error('订单不存在');
  if (!isDescription(note)) throw new Error('商家备注限300字以内');
  return { ...order, merchantNote: note.trim() };
}

export function resolveAfterSale(order, reply, now = new Date().toISOString()) {
  if (!isDescription(reply)) throw new Error('售后处理意见限300字以内');
  const result = updateAfterSale(order, 'resolved', now);
  return { ...result, afterSale: { ...result.afterSale, merchantReply: reply.trim() } };
}

function cleanAfterSale(value) {
  if (!value || !isAfterSaleId(value.id) || !AFTER_SALE_TYPES.includes(value.type)
    || !AFTER_SALE_REASONS.includes(value.reason) || !isDescription(value.description)
    || typeof value.hasEvidence !== 'boolean' || !AFTER_SALE_STATUSES.includes(value.status)
    || !isDate(value.createdAt) || !isDate(value.updatedAt)
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return null;
  const result = {
    id: value.id, type: value.type, reason: value.reason, description: value.description.trim(),
    hasEvidence: value.hasEvidence, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt
  };
  if (value.merchantReply !== undefined && isDescription(value.merchantReply)) result.merchantReply = value.merchantReply.trim();
  return result;
}

function snapshotText(value, fallback) {
  return isPlainText(value, 120) && value.trim() ? value.trim() : fallback;
}

function cleanOrderItem(item, legacy = false, cloudSnapshot = false) {
  if (!item || typeof item !== 'object') return null;
  const productId = legacy && item.productId === undefined ? 'jingtai-apple' : item.productId;
  // A versioned server order owns its historical snapshot. Its product may now be
  // offline, deleted from the public catalog, renamed, or have different prices.
  if (cloudSnapshot && (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(productId || '')
    || !['product', 'variantLabel', 'weight'].every(key => typeof item[key] === 'string' && item[key].trim() && item[key].length <= 120)
    || !['small', 'family'].includes(item.variant)
    || typeof item.image !== 'string' || !/^assets\/(?!.*\.\.)[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp|gif|svg)$/.test(item.image))) return null;
  const product = cloudSnapshot
    ? { id: productId, name: item.product, image: item.image, variants: [{ id: item.variant, label: item.variantLabel, weight: item.weight }] }
    : getProduct(productId) || BASE_CATALOG.find(value => value.id === productId);
  const variant = product?.variants.find(value => value.id === item.variant);
  if (!product || !variant || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10
    || !['unitPrice', 'subtotal'].every(key => Number.isSafeInteger(item[key]) && item[key] >= 0)
    || item.subtotal !== item.unitPrice * item.quantity) return null;
  const batchFields = ['batchId', 'batchCode', 'harvestDate', 'batchNote'];
  const hasBatch = batchFields.some(key => item[key] !== undefined);
  const batchText = (value, length) => typeof value === 'string' && value.length <= length && !/[\u0000-\u001f\u007f]/.test(value);
  if (hasBatch && (!batchText(item.batchId, 100) || !item.batchId || !batchText(item.batchCode, 80) || !item.batchCode.trim()
    || !batchText(item.batchNote, 300) || typeof item.harvestDate !== 'string'
    || (item.harvestDate !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(item.harvestDate) || !Number.isFinite(Date.parse(item.harvestDate)) || new Date(item.harvestDate).toISOString().slice(0, 10) !== item.harvestDate)))) return null;
  return {
    productId: product.id, product: snapshotText(item.product, product.name),
    image: typeof item.image === 'string' && /^assets\/(?!.*\.\.)[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp|gif|svg)$/.test(item.image) ? item.image : product.image,
    ...(typeof item.imageMediaId === 'string' && item.imageMediaId.length > 0 && item.imageMediaId.length <= 120 ? { imageMediaId: item.imageMediaId } : {}),
    variant: variant.id, variantLabel: snapshotText(item.variantLabel, variant.label),
    weight: snapshotText(item.weight, variant.weight), unitPrice: item.unitPrice,
    quantity: item.quantity, subtotal: item.subtotal,
    ...(hasBatch ? Object.fromEntries(batchFields.map(key => [key, item[key]])) : {})
  };
}

export function orderItems(order) {
  if (!order || typeof order !== 'object') return [];
  const cloudSnapshot = Number.isSafeInteger(order.version) && order.version >= 1;
  if (order.items !== undefined) {
    if (!Array.isArray(order.items) || !order.items.length || order.items.length > 12) return [];
    const items = order.items.map(item => cleanOrderItem(item, false, cloudSnapshot));
    if (items.some(item => !item) || new Set(items.map(item => `${item.productId}::${item.variant}`)).size !== items.length) return [];
    return items;
  }
  const item = cleanOrderItem(order, true, cloudSnapshot);
  return item ? [item] : [];
}

export function validOrders(value) {
  if (!Array.isArray(value)) return [];
  const result = [], ids = new Set();
  for (const order of value) {
    if (!order || typeof order !== 'object') continue;
    const items = orderItems(order);
    if (!items.length || typeof order.id !== 'string' || !/^DEMO-[A-Z0-9-]+$/.test(order.id)
      || ids.has(order.id) || !isDate(order.createdAt) || !['created', 'cancelled'].includes(order.status)
      || !ADDRESSES.some(a => a.id === order.address && a.shipping !== null)
      || !Number.isInteger(order.quantity) || order.quantity !== items.reduce((sum, item) => sum + item.quantity, 0)
      || !['subtotal', 'shipping', 'total'].every(key => Number.isSafeInteger(order[key]) && order[key] >= 0)
      || order.subtotal !== items.reduce((sum, item) => sum + item.subtotal, 0)
      || order.total !== order.subtotal + order.shipping) continue;
    const first = items[0];
    const productCount = new Set(items.map(item => item.productId)).size;
    const fallbackName = productCount > 1 ? `${first.product}等${productCount}款商品` : first.product;
    const cleaned = {
      id: order.id, createdAt: order.createdAt, ...first,
      product: snapshotText(order.product, fallbackName), quantity: order.quantity,
      subtotal: order.subtotal, shipping: order.shipping, total: order.total, address: order.address, status: order.status
    };
    if (order.items !== undefined) cleaned.items = items;
    if (order.merchantNote !== undefined && isDescription(order.merchantNote)) cleaned.merchantNote = order.merchantNote.trim();
    const fulfillment = order.fulfillment;
    if (fulfillment?.status === 'shipped' && typeof fulfillment.carrier === 'string' && fulfillment.carrier.trim()
      && fulfillment.carrier.length <= 40 && typeof fulfillment.tracking === 'string'
      && /^DEMO-[A-Z0-9-]{1,75}$/i.test(fulfillment.tracking) && isDate(fulfillment.shippedAt)) {
      cleaned.fulfillment = { status: 'shipped', carrier: fulfillment.carrier.trim(), tracking: fulfillment.tracking, shippedAt: fulfillment.shippedAt };
    }
    const afterSale = cleanAfterSale(order.afterSale);
    if (afterSale) cleaned.afterSale = afterSale;
    result.push(cleaned); ids.add(order.id);
    if (result.length === 100) break;
  }
  return result;
}
