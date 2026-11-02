'use strict';
const {randomUUID,randomBytes}=require('node:crypto');
const {digest,fail}=require('./store');
const {has}=require('./auth');
const V=require('./validation');
const uuid=prefix=>prefix+'-'+randomUUID().toUpperCase();
const clone=value=>JSON.parse(JSON.stringify(value));
const emptyShopping=()=>({cart:[],favorites:[],recent:[],preferredAddress:'gansu'});
function requireMethod(actual,...allowed) {if(!allowed.includes(actual))fail(405,'method_not_allowed','该接口不支持此操作。');}
function requirePermission(user,...permissions) {if(!user||!permissions.some(p=>has(user,p)))fail(403,'forbidden','当前账号没有此项管理权限。');}
function sameVersion(row,expected) {if((row?.version||0)!==expected)fail(409,'version_conflict','资料已在其他设备更新，请刷新后重新操作；本次未覆盖。');}
function productDTO(row) {return {...clone(row.product),version:row.version,updatedAt:row.updatedAt,shopId:'shop-'+digest(row.ownerId).slice(0,24)};}
function inventoryDTO(row,id) {if(!row)return {productId:id,configured:false,stocks:{small:0,family:0},batchId:'',batchCode:'',harvestDate:'',note:'',version:0,updatedAt:null}; const {updatedBy,...data}=row;return {...clone(data),configured:true};}
function orderDTO(row,admin=false) {const data=clone(row.data);if(!admin)delete data.merchantNote;return {...data,version:row.version,updatedAt:row.updatedAt};}
async function sellerVisible(docs,id,appId,write=false) {const user=await docs.get('users',id);if(!user||user.appId!==appId)return false;if(write)await docs.set('users',id,{...user,authorizationFence:randomBytes(16).toString('hex')});if(user.role==='admin')return true;if(user.role!=='merchant'||!user.merchantId)return false;const merchant=await docs.get('merchants',id);if(write&&merchant)await docs.set('merchants',id,{...merchant,authorizationFence:randomBytes(16).toString('hex')});return merchant?.status==='enabled';}
function ownProduct(row,user,permission='products') {requirePermission(user,permission);if(!row||(user.role!=='admin'&&row.ownerId!==user.id))fail(404,'not_found','商品不存在或当前账号无权访问。');return row;}
function ownOrder(row,user,admin=false,permission) {if(admin)requirePermission(user,...(permission?[permission]:['orders','aftersales']));const visible=row&&(admin?(user.role==='admin'||row.sellerId===user.id)&&(has(user,'orders')||!!row.data.afterSale):row.buyerId===user.id);if(!visible)fail(404,'not_found','订单不存在或当前账号无权访问。');return row;}
function decodeCursor(value) {if(value===null)return null;try{if(!/^[A-Za-z0-9_-]{1,240}$/.test(value))throw Error();const key=Buffer.from(value,'base64url').toString();if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\|[A-Z]+-[A-F0-9-]{36}$/.test(key))throw Error();return key;}catch{fail(400,'cursor_invalid','分页参数无效，请重新读取列表。');}}
function cursorOf(row) {return row?Buffer.from(row.sortKey).toString('base64url'):null;}
async function page(docs,collection,filter,cursor) {const rows=await docs.list(collection,filter,{limit:100,cursor});return {rows,nextCursor:rows.length===100?cursorOf(rows.at(-1)):null};}
async function allProducts(docs,filter={}) {const first=await docs.list('products',filter,{limit:100});return first.length===100?[...first,...await docs.list('products',filter,{limit:100,cursor:first.at(-1).sortKey})]:first;}
async function inventoryEvent(tx,before,after,actorId,action,reason,time,orderId=null,eventId=uuid('STOCK')) {await tx.set('inventoryEvents',eventId,{id:eventId,productId:after.productId,actorId,action,reason,orderId,before:inventoryDTO(before,after.productId),after:inventoryDTO(after,after.productId),createdAt:time,sortKey:time+'|'+eventId});await tx.set('meta','inventory-ever:'+after.productId,{productId:after.productId,seen:true});}
module.exports={V,uuid,clone,emptyShopping,requireMethod,requirePermission,sameVersion,productDTO,inventoryDTO,orderDTO,sellerVisible,ownProduct,ownOrder,decodeCursor,cursorOf,page,allProducts,inventoryEvent};
