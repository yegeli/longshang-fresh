'use strict';
const {fail}=require('./store');
const {ADDRESSES,normalizeCatalogProduct}=require('./model.cjs');
const PRODUCT_ID=/^[a-z0-9][a-z0-9-]{1,63}$/;
const USER_ID=/^wechat:[a-f0-9]{64}$/;
const ORDER_ID=/^DEMO-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const MERCHANT_ID=/^MERCHANT-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const PERMISSIONS=['products','orders','aftersales'];
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fields(body,allowed,code='body_invalid') { if(!object(body)||Object.keys(body).some(k=>!allowed.includes(k)))fail(400,code,'请求包含未知字段或格式无效。'); }
function version(value,minimum=0) { if(!Number.isSafeInteger(value)||value<minimum||value>=Number.MAX_SAFE_INTEGER)fail(400,'version_invalid','资料版本无效，请重新读取。'); return value; }
function text(body,key,max,required=false) { if(typeof body[key]!=='string'||body[key].length>max||/[\u0000-\u001f\u007f]/.test(body[key])||(required&&!body[key].trim()))fail(400,'body_invalid','请填写有效的资料内容。'); return body[key].trim(); }
function selection(body) {
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>12)fail(400,'items_invalid','请选择1至12种商品规格。');
 const seen=new Set(); const items=body.items.map(item=> {fields(item,['productId','variant','quantity'],'items_invalid'); const sku=item.productId+':'+item.variant;
 if(!PRODUCT_ID.test(item.productId)||!['small','family'].includes(item.variant)||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>10||seen.has(sku))fail(400,'items_invalid','商品规格或数量无效，每种规格限1至10份。');seen.add(sku);return {productId:item.productId,variant:item.variant,quantity:item.quantity}; }).sort((a,b)=>(a.productId+':'+a.variant).localeCompare(b.productId+':'+b.variant,'en'));
 if(!ADDRESSES.some(a=>a.id===body.address&&a.shipping!==null))fail(400,'address_invalid','请选择可配送的示例地区，不需要真实地址。');return {items,address:body.address};
}
function shopping(value) {
 fields(value,['cart','favorites','recent','preferredAddress'],'shopping_invalid');
 if(Object.keys(value).length!==4||!Array.isArray(value.cart)||value.cart.length>12||!ADDRESSES.some(a=>a.id===value.preferredAddress))fail(400,'shopping_invalid','购物资料格式无效。');
 const seen=new Set(); const cart=value.cart.map(row=> {fields(row,['productId','variant','quantity','selected'],'shopping_invalid'); const sku=row.productId+':'+row.variant;
 if(Object.keys(row).length!==4||!PRODUCT_ID.test(row.productId)||!['small','family'].includes(row.variant)||!Number.isSafeInteger(row.quantity)||row.quantity<1||row.quantity>10||typeof row.selected!=='boolean'||seen.has(sku))fail(400,'shopping_invalid','购物车资料格式无效。');seen.add(sku);return {...row}; });
 for(const name of ['favorites','recent'])if(!Array.isArray(value[name])||value[name].length>20||value[name].some(v=>typeof v!=='string'||!PRODUCT_ID.test(v))||new Set(value[name]).size!==value[name].length)fail(400,'shopping_invalid','收藏或足迹资料格式无效。');
 return {cart,favorites:[...value.favorites],recent:[...value.recent],preferredAddress:value.preferredAddress};
}
function product(input,id) {
 fields(input,['id','name','category','status','image','origin','subtitle','tags','summary','storage','sizeNote','facts','harvestSteps','variants','video','videoTitle','videoNote','imageMediaId','videoMediaId','version'],'product_invalid');
 if(input.id!==id||!PRODUCT_ID.test(id)||input.video!==''||['imageMediaId','videoMediaId'].some(k=>input[k]!==undefined&&input[k]!==''&&(typeof input[k]!=='string'||!/^CLOUD-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/.test(input[k])))||!['apples','goji','pear','potato','corn','onion','orchard','apple-orchard','apples-hero'].some(n=>input.image==='assets/'+n+'.jpg'))fail(400,'product_invalid','请使用有效商品编号、示意图片及已校验的云素材编号。');
 try{return normalizeCatalogProduct(input);}catch(e){fail(400,'product_invalid',e.message);}
}
function stock(body) {
 fields(body,['expectedVersion','stocks','batchCode','harvestDate','note','reason'],'inventory_invalid'); const expectedVersion=version(body.expectedVersion);
 if(!object(body.stocks)||Object.keys(body.stocks).length!==2||!['small','family'].every(k=>Number.isSafeInteger(body.stocks[k])&&body.stocks[k]>=0&&body.stocks[k]<=999999))fail(400,'stock_invalid','两种规格可售数须为0至999999份。');
 const harvestDate=text(body,'harvestDate',10);if(harvestDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(harvestDate)||!Number.isFinite(Date.parse(harvestDate))||new Date(harvestDate).toISOString().slice(0,10)!==harvestDate))fail(400,'inventory_invalid','采摘日期无效。');
 return {expectedVersion,stocks:{...body.stocks},batchCode:text(body,'batchCode',80,true),harvestDate,note:text(body,'note',300),reason:text(body,'reason',200,true)};
}
function merchant(body,updating=false) {
 fields(body,['userId','name','region','status','permissions',...(updating?['expectedVersion']:[])],'merchant_invalid');
 if(!USER_ID.test(body.userId)||!['enabled','disabled'].includes(body.status)||!Array.isArray(body.permissions)||body.permissions.length>3||body.permissions.some(p=>!PERMISSIONS.includes(p))||new Set(body.permissions).size!==body.permissions.length)fail(400,'merchant_invalid','采购者账号、状态或权限无效。');
 return {userId:body.userId,name:text(body,'name',80,true),region:text(body,'region',100,true),status:body.status,permissions:PERMISSIONS.filter(p=>body.permissions.includes(p)),...(updating?{expectedVersion:version(body.expectedVersion,1)}:{})};
}
module.exports={PRODUCT_ID,USER_ID,ORDER_ID,MERCHANT_ID,PERMISSIONS,object,fields,version,text,selection,shopping,product,stock,merchant};
