'use strict';
const {digest,fail}=require('./store');
const C=require('./common');
const SHOP_ID=/^shop-[a-f0-9]{24}$/;
const IMAGES=new Set(['apples','goji','pear','potato','corn','onion','orchard','apple-orchard','apples-hero'].map(name=>'assets/'+name+'.jpg'));
const MEDIA_ID=/^CLOUD-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const shopIdFor=ownerId=>'shop-'+digest(ownerId).slice(0,24);
const profileKey=ownerId=>'shop-profile:'+ownerId;
function text(value,max,required=false,multiline=false){
 if(typeof value!=='string'||value.length>max||(multiline?/[\u0000-\u0008\u000b-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(value)||(required&&!value.trim()))fail(400,'shop_invalid','请填写有效的店铺名称、介绍与服务说明。');
 return value.trim();
}
function profileInput(input){
 C.V.fields(input,['name','description','serviceNote','image','imageMediaId'],'shop_invalid');
 if(!IMAGES.has(input.image)||typeof input.imageMediaId!=='string'||input.imageMediaId!==''&&!MEDIA_ID.test(input.imageMediaId))fail(400,'shop_invalid','请选择默认示意图片或本店已上传的图片。');
 return {name:text(input.name,60,true),description:text(input.description,2000,false,true),serviceNote:text(input.serviceNote,500,false,true),image:input.image,imageMediaId:input.imageMediaId};
}
function baseProfile(user,row){
 const merchant=user.merchant||null;
 if(row&&(row.ownerId!==user.id||row.id!==shopIdFor(user.id)||!Number.isSafeInteger(row.version)||row.version<1))fail(503,'shop_unavailable','店铺资料暂时不可用，请稍后重试。');
 return {id:shopIdFor(user.id),name:row?.name||merchant?.name||'景泰采购演示店',description:row?row.description:'模拟采购者资料。商品货源、价格与履约均用于开发验证。',serviceNote:row?.serviceNote||'',image:row?.image||'assets/orchard.jpg',imageMediaId:row?.imageMediaId||'',version:row?.version||0,updatedAt:row?.updatedAt||null,regionLabel:merchant?.region||'甘肃 · 景泰',procurementName:merchant?.name||'平台采购者（模拟）'};
}
function createShops({store,auth,now,media}){
 async function dto(user,row){return media.shopDTO(baseProfile(user,row),user.id);}
 async function definitionFor(ownerId){
  const user=await store.get('users',ownerId);if(!user)fail(503,'shop_unavailable','店铺资料暂时不可用。');
  const merchant=user.merchantId?await store.get('merchants',ownerId):null;
  return dto({...user,merchant},await store.get('meta',profileKey(ownerId)));
 }
 async function handle(ctx){
  if(ctx.path!=='/admin/shop')return null;
  const user=await auth.identity(store,ctx.event,ctx.caller);C.requirePermission(user,'products');
  if(ctx.url.searchParams.has('cursor'))fail(400,'cursor_invalid','店铺资料不支持分页。');
  if(ctx.method==='GET'){C.V.fields(ctx.body,[]);return {shop:await dto(user,await store.get('meta',profileKey(user.id)))};}
  C.requireMethod(ctx.method,'PUT');C.V.fields(ctx.body,['expectedVersion','shop'],'shop_invalid');
  const expected=C.V.version(ctx.body.expectedVersion),input=profileInput(ctx.body.shop),time=now();
  const result=await store.transaction(async tx=>{
   const current=await auth.identity(tx,ctx.event,ctx.caller,true,true);C.requirePermission(current,'products');
   const previous=await tx.get('meta',profileKey(current.id));C.sameVersion(previous,expected);
   if(previous&&(previous.ownerId!==current.id||previous.id!==shopIdFor(current.id)))fail(503,'shop_unavailable','店铺资料暂时不可用。');
   const row={id:shopIdFor(current.id),ownerId:current.id,...input,version:expected+1,createdAt:previous?.createdAt||time,updatedAt:time};
   await media.bindShop(tx,row,current.id);await tx.set('meta',profileKey(current.id),row);return {user:current,row};
  });
  return {shop:await dto(result.user,result.row)};
 }
 return {handle,definitionFor};
}
module.exports={createShops,shopIdFor,profileKey,SHOP_ID,profileInput};
