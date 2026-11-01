import { buildStorefront } from '../public/storefront-data.js';
import { visibleSellerSQL } from './merchant-access.js';

async function publicShopId(ownerId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ownerId));
  return `shop-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24)}`;
}

export async function handleStorefrontApi(request, env, helpers) {
  if (new URL(request.url).pathname !== '/api/v1/storefront') return null;
  const { requireDB, method, json } = helpers;
  method(request, ['GET']);
  const db = requireDB(env);
  // Read display fields only. There is no identity call, claim, seed or write.
  const result = await db.prepare(`SELECT p.id,p.owner_id,p.product_json,p.updated_at,u.role,
    m.name AS merchant_name,m.region AS merchant_region,m.updated_at AS merchant_updated_at
    FROM products p LEFT JOIN users u ON u.user_id=p.owner_id
    LEFT JOIN merchant_accounts m ON m.user_id=p.owner_id AND m.status='enabled'
    WHERE p.status='published' AND ${visibleSellerSQL('p.owner_id')} ORDER BY p.id`).all();
  const rows = result.results || [], owners = new Map(), products = [];
  let updatedAt = null;
  for (const row of rows) {
    if (!owners.has(row.owner_id)) {
      const id = await publicShopId(row.owner_id);
      const merchant = row.role !== 'admin' && row.merchant_name;
      owners.set(row.owner_id, { id, name: merchant || '景泰好物示范店', procurementName: merchant || '示范采购员',
        regionLabel: merchant ? row.merchant_region : '',
        description: merchant ? '采购者店铺演示：查看这家店的已上架特产及其产区。商品、价格与采购合作资料均为模拟，正式资料待核实。'
          : '从景泰出发的好物示范店，展示当前已上架的模拟特产与采收介绍；商品与采购资料待真实货源核实。' });
    }
    const product = JSON.parse(row.product_json);
    products.push({ id: row.id, origin: product.origin, image: product.image, shopId: owners.get(row.owner_id).id });
    for (const value of [row.updated_at, row.merchant_updated_at]) if (value && (!updatedAt || value > updatedAt)) updatedAt = value;
  }
  return json(buildStorefront(products, [...owners.values()], updatedAt));
}
