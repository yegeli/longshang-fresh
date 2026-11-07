'use strict';
const {MarketError,fail}=require('./store');
const {subject,sessionDTO,createAuth}=require('./auth');
const {object,fields}=require('./validation');
const {requireMethod}=require('./common');
const {createCatalog}=require('./catalog');
const {createCommerce}=require('./commerce');
const {createMerchants}=require('./merchants');
const {requireReady}=require('./readiness');
const {createMedia}=require('./media');
const {createShops}=require('./shops');
const {createSupport}=require('./support');
function createMarketApi({store,getContext,env={},now=()=>new Date().toISOString(),storage}) {
 const auth=createAuth({store,env,now}),media=createMedia({store,auth,now,env,storage}),shops=createShops({store,auth,now,media}),support=createSupport({store,auth,now}),catalog=createCatalog({store,auth,now,media,shops}),commerce=createCommerce({store,auth,now}),merchants=createMerchants({store,auth,now});
 return async function market(event) {
  try {
   const chunkRequest=typeof event?.path==='string'&&/^\/api\/v1\/admin\/media\/CLOUD-[A-F0-9-]{36}\/chunks$/.test(event.path)&&event.method==='POST';
   if(!object(event)||Object.keys(event).some(k=>!['path','method','body','sessionToken','expectedUserId'].includes(k))||Buffer.byteLength(JSON.stringify(event),'utf8')>(chunkRequest?400*1024:98304))fail(400,'event_invalid','云函数请求格式无效或内容过大。');
   if(typeof event.path!=='string'||event.path.length>1000||!event.path.startsWith('/api/v1/')||/[#\\\u0000-\u001f]/.test(event.path)||!['GET','POST','PUT'].includes(event.method||'GET'))fail(400,'event_invalid','云函数接口路径或方法无效。');
   const url=new URL(event.path,'https://cloudbase.local'),path=url.pathname.slice('/api/v1'.length),method=event.method||'GET',body=event.body===undefined?{}:event.body;
   if(url.origin!=='https://cloudbase.local'||[...url.searchParams.keys()].some(k=>k!=='cursor')||url.searchParams.getAll('cursor').length>1||(url.searchParams.has('cursor')&&method!=='GET'))fail(400,'cursor_invalid','接口参数无效。');
   const context=await getContext(),caller=subject(context,env);await requireReady(store,caller,context,env);const ctx={path,method,body,event,caller,url};
   if(path==='/session'){requireMethod(method,'GET');fields(body,[]);return {status:200,body:sessionDTO(await auth.identity(store,event,caller,false))};}
   if(path==='/auth/wechat/login'){requireMethod(method,'POST');return {status:200,body:await auth.login(body,caller)};}
   if(path==='/auth/wechat/logout'){requireMethod(method,'POST');return {status:200,body:await auth.logout(body,event,caller)};}
   // These handlers authorize every private read and re-authorize all writes
   // inside the same transaction as business changes. A stale cached role never
   // authorizes an operation; only trusted wx context establishes identity.
   for(const handler of [media.handle,shops.handle,support.handle,catalog.handle,merchants.handle,commerce.shopping,commerce.orders]){const result=await handler(ctx);if(result!==null)return result?.status&&result?.body?result:{status:200,body:result};}
   fail(404,'not_found','云端接口不存在。');
  } catch(error) {if(error instanceof MarketError)return {status:error.status,body:{error:{code:error.code,message:error.message}}};return {status:503,body:{error:{code:'cloudbase_unavailable',message:'云端暂时不可用，本次操作未确认；请保留提交编号后重试。'}}};}
 };
}
module.exports={createMarketApi};
