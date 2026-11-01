import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('user_id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['buyer', 'merchant', 'admin'] }).notNull().default('buyer'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, table => [check('users_role', sql`${table.role} in ('buyer', 'merchant', 'admin')`)]);

// A durable singleton binds bootstrap administration to one stable hosted identity.
export const adminBootstrap = sqliteTable('admin_bootstrap', {
  singleton: integer('singleton').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  claimedAt: text('claimed_at').notNull()
}, table => [check('one_admin_bootstrap', sql`${table.singleton} = 1`)]);

export const media = sqliteTable('media', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  objectKey: text('object_key').notNull().unique(),
  name: text('name').notNull(),
  type: text('mime_type').notNull(),
  kind: text('kind', { enum: ['image', 'video'] }).notNull(),
  size: integer('size').notNull(),
  source: text('source').notNull(),
  createdAt: text('created_at').notNull()
}, table => [
  index('media_owner').on(table.ownerId),
  check('media_kind', sql`${table.kind} in ('image', 'video')`),
  check('media_type', sql`(${table.kind} = 'image' and ${table.type} in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')) or (${table.kind} = 'video' and ${table.type} in ('video/mp4', 'video/webm'))`),
  check('media_size', sql`${table.size} > 0 and ((${table.kind} = 'image' and ${table.size} <= 5242880) or (${table.kind} = 'video' and ${table.size} <= 31457280))`),
  check('media_source', sql`length(${table.source}) between 1 and 500`)
]);

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  productJson: text('product_json').notNull(),
  status: text('status', { enum: ['draft', 'published', 'offline'] }).notNull(),
  version: integer('version').notNull(),
  imageMediaId: text('image_media_id').references(() => media.id),
  videoMediaId: text('video_media_id').references(() => media.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').notNull().references(() => users.id)
}, table => [
  index('products_owner').on(table.ownerId),
  index('products_status').on(table.status),
  index('products_image_media').on(table.imageMediaId),
  index('products_video_media').on(table.videoMediaId),
  check('products_status_valid', sql`${table.status} in ('draft', 'published', 'offline')`),
  check('products_version', sql`${table.version} >= 1 and ${table.version} <= 9007199254740991`),
  check('products_json', sql`json_valid(${table.productJson})`)
]);

// One merchant per combined simulated order. Snapshots outlive catalog changes.
export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(),
  buyerId: text('buyer_id').notNull().references(() => users.id),
  sellerId: text('seller_id').notNull().references(() => users.id),
  requestKey: text('request_key').notNull(),
  requestJson: text('request_json').notNull(),
  orderJson: text('order_json').notNull(),
  version: integer('version').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, table => [
  uniqueIndex('orders_buyer_request').on(table.buyerId, table.requestKey),
  index('orders_buyer_created').on(table.buyerId, table.createdAt, table.id),
  index('orders_seller_created').on(table.sellerId, table.createdAt, table.id),
  index('orders_created').on(table.createdAt, table.id),
  check('orders_version', sql`${table.version} >= 1 and ${table.version} <= 9007199254740991`),
  check('orders_request_json', sql`json_valid(${table.requestJson})`),
  check('orders_snapshot_json', sql`json_valid(${table.orderJson})`),
  check('orders_status', sql`json_extract(${table.orderJson}, '$.status') in ('created', 'cancelled')`)
]);
