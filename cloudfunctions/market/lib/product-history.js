'use strict';
const {fail}=require('./store');

// History shares the existing meta collection. Long descriptions, signed URLs,
// identity IDs and complete product snapshots never enter this bounded log.
const LIMIT=50,MAX_BYTES=128*1024;
const FIELDS=['name','category','status','image','origin','subtitle','summary','storage','sizeNote','tags','facts','harvestSteps','variants','video','videoTitle','videoNote','imageMediaId','videoMediaId'];
const MEDIA_ID=/^CLOUD-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const historyKey=id=>'product-history:'+id;
function summary(product) {
 if(!product)return null;
 return {name:product.name,status:product.status,prices:Object.fromEntries(['small','family'].map(id=>[id,product.variants.find(v=>v.id===id).price])),image:product.image,imageMediaId:product.imageMediaId||'',videoMediaId:product.videoMediaId||''};
}
function invalid(){fail(503,'product_history_invalid','商品变更记录暂时不可用，请保留当前资料并重试。');}
function summaryDTO(value) {
 if(value===null)return null;
 if(!value||typeof value.name!=='string'||value.name.length>40||!['published','draft','offline'].includes(value.status)||typeof value.image!=='string'||value.image.length>100||!/^assets\/[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp|gif|svg)$/.test(value.image)||!['small','family'].every(id=>Number.isSafeInteger(value.prices?.[id])&&value.prices[id]>=1&&value.prices[id]<=999999)||!['imageMediaId','videoMediaId'].every(field=>value[field]===''||typeof value[field]==='string'&&MEDIA_ID.test(value[field])))invalid();
 return {name:value.name,status:value.status,prices:{small:value.prices.small,family:value.prices.family},image:value.image,imageMediaId:value.imageMediaId,videoMediaId:value.videoMediaId};
}
function eventDTO(value,productId) {
 if(!value||!/^PRODUCT-[A-F0-9-]{36}$/.test(value.id)||value.productId!==productId||!['created','updated'].includes(value.action)||typeof value.createdAt!=='string'||value.createdAt.length!==24||!Number.isFinite(Date.parse(value.createdAt))||!Number.isSafeInteger(value.version)||value.version<1||!['admin','merchant'].includes(value.actorRole)||!Array.isArray(value.changedFields)||value.changedFields.length>FIELDS.length||value.changedFields.some(field=>!FIELDS.includes(field))||new Set(value.changedFields).size!==value.changedFields.length)invalid();
 const before=summaryDTO(value.before),after=summaryDTO(value.after);
 if(!after||value.action==='created'&&before!==null||value.action==='updated'&&before===null)invalid();
 return {id:value.id,productId,action:value.action,createdAt:value.createdAt,version:value.version,actorRole:value.actorRole,changedFields:[...value.changedFields],before,after};
}
function eventsDTO(row,productId) {
 if(!row)return [];
 if(row.schemaVersion!==1||row.productId!==productId||!Array.isArray(row.events)||row.events.length>LIMIT)invalid();
 return row.events.map(value=>eventDTO(value,productId));
}
async function appendProductHistory(tx,before,after,actorRole,id) {
 const previous=await tx.get('meta',historyKey(after.id));
 const event={id,productId:after.id,action:before?'updated':'created',createdAt:after.updatedAt,version:after.version,actorRole,changedFields:FIELDS.filter(field=>JSON.stringify(before?.product[field]??(['imageMediaId','videoMediaId'].includes(field)?'':null))!==JSON.stringify(after.product[field]??(['imageMediaId','videoMediaId'].includes(field)?'':null))),before:summary(before?.product),after:summary(after.product)};
 const row={schemaVersion:1,productId:after.id,events:[eventDTO(event,after.id),...eventsDTO(previous,after.id)].slice(0,LIMIT)};
 if(Buffer.byteLength(JSON.stringify(row),'utf8')>MAX_BYTES)invalid();
 await tx.set('meta',historyKey(after.id),row);
}
async function readProductHistory(store,productId){return {events:eventsDTO(await store.get('meta',historyKey(productId)),productId),nextCursor:null};}
module.exports={appendProductHistory,readProductHistory,LIMIT,MAX_BYTES};
