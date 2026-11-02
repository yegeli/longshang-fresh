export const MERCHANT_PERMISSIONS = ['products', 'orders', 'aftersales'];

export function merchantDTO(row) {
  const wechat = /^wechat:[a-f0-9]{64}$/.test(row.user_id || '');
  return { id: row.id, name: row.name, email: wechat ? '' : row.email, region: row.region, status: row.status,
    permissions: JSON.parse(row.permissions_json), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, bound: !!row.user_id,
    ...(wechat ? { userId: row.user_id, authProvider: 'wechat' } : {}) };
}

export function hasPermission(user, permission) {
  return user?.role === 'admin' || (user?.role === 'merchant' && user.merchant?.status === 'enabled' && user.permissions?.includes(permission));
}

// These expressions accept only source-controlled aliases/permission literals.
// Their single parameter is the currently trusted stable actor ID.
export function managementGuard(permissions = MERCHANT_PERMISSIONS) {
  const values = (Array.isArray(permissions) ? permissions : [permissions]);
  if (values.some(value => !MERCHANT_PERMISSIONS.includes(value))) throw new Error('Unknown management permission');
  return `EXISTS(SELECT 1 FROM users auth_user LEFT JOIN merchant_accounts auth_merchant ON auth_merchant.user_id=auth_user.user_id
    WHERE auth_user.user_id=? AND (auth_user.role='admin' OR (auth_user.role='merchant' AND auth_merchant.status='enabled'
    AND EXISTS(SELECT 1 FROM json_each(auth_merchant.permissions_json) WHERE value IN (${values.map(value => `'${value}'`).join(',')})))))`;
}

export function visibleSellerSQL(owner = 'owner_id') {
  if (!/^[a-z_]+(?:\.[a-z_]+)?$/.test(owner)) throw new Error('Invalid owner expression');
  return `NOT EXISTS(SELECT 1 FROM merchant_accounts disabled_merchant WHERE disabled_merchant.user_id=${owner} AND disabled_merchant.status='disabled')`;
}
