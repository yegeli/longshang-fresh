'use strict';
const {randomBytes}=require('node:crypto');
const {digest,fail}=require('./store');
const {fields,USER_ID,PERMISSIONS}=require('./validation');
const TOKEN=/^wxs_[a-f0-9]{64}$/;
const TTL=7*24*60*60*1000;
const clone=v=>JSON.parse(JSON.stringify(v));
const fence=()=>randomBytes(16).toString('hex');
function subject(context,env) {
 if(!/^wx[a-f0-9]{16}$/.test(env.WECHAT_APP_ID||''))fail(503,'cloudbase_unconfigured','云开发应用编号尚未配置。');
 if(!context||context.APPID!==env.WECHAT_APP_ID||typeof context.OPENID!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(context.OPENID))fail(401,'wechat_context_invalid','请从当前微信小程序重新进入。');
 return {id:'wechat:'+digest(context.APPID+'\0'+context.OPENID),appId:context.APPID};
}
function merchantDTO(row) {if(!row)return null;return {id:row.id,userId:row.userId,name:row.name,email:'',region:row.region,status:row.status,permissions:clone(row.permissions),version:row.version,createdAt:row.createdAt,updatedAt:row.updatedAt,bound:true,authProvider:'wechat'};}
async function withMerchant(docs,user,write=false) { if(!user)return null;const row=user.merchantId?await docs.get('merchants',user.id):null;if(write&&row)await docs.set('merchants',user.id,{...row,authorizationFence:fence()});return {...user,merchant:merchantDTO(row),permissions:user.role==='admin'?[...PERMISSIONS]:user.role==='merchant'&&row?.status==='enabled'?[...row.permissions]:[]}; }
function sessionDTO(user) {return {user:user?{id:user.id,email:'',name:user.name}:null,role:user?.role||'anonymous',canManage:!!user?.permissions?.length,permissions:user?.permissions||[],merchant:user?.merchant||null,signInUrl:null,signOutUrl:null,authProvider:'cloudbase'};}
function has(user,permission) {return user?.role==='admin'||(user?.role==='merchant'&&user.merchant?.status==='enabled'&&user.permissions.includes(permission));}
function createAuth({store,env,now}) {
 async function identity(docs,event,caller,required=true,write=false) {
  if(event.expectedUserId!==undefined&&event.expectedUserId!==caller.id)fail(409,'account_changed','微信账号已变化，请重新登录并核对资料。');
  if(!event.sessionToken) {if(required)fail(401,'sign_in_required','请先登录再同步个人资料。');return null;}
  if(typeof event.sessionToken!=='string'||!TOKEN.test(event.sessionToken))fail(401,'session_invalid','登录状态无效，请重新登录。');
  const session=await docs.get('sessions',digest(event.sessionToken));
  if(!session||session.userId!==caller.id||session.appId!==caller.appId||session.revokedAt||session.expiresAt<=now())fail(401,'session_invalid','登录状态已失效，请重新登录。');
  const user=await docs.get('users',caller.id);
  if(!user||user.appId!==caller.appId||!['buyer','merchant','admin'].includes(user.role))fail(401,'session_invalid','登录账号无效，请重新登录。');
  if(write){await docs.set('sessions',digest(event.sessionToken),{...session,authorizationFence:fence()});await docs.set('users',user.id,{...user,authorizationFence:fence()});}
  return withMerchant(docs,user,write);
 }
 async function login(body,caller) {
  fields(body,[]);const time=now(),token='wxs_'+randomBytes(32).toString('hex'),expiresAt=new Date(Date.parse(time)+TTL).toISOString();
  const user=await store.transaction(async tx=>{
   const previous=await tx.get('users',caller.id),bootstrap=await tx.get('meta','admin-bootstrap'),rate=await tx.get('meta','login-rate:'+caller.id);
   const minute=Math.floor(Date.parse(time)/60000),count=rate?.minute===minute?rate.count+1:1;if(count>10)fail(429,'login_rate_limited','登录过于频繁，请稍后再试。');
   let value=previous||{id:caller.id,appId:caller.appId,name:'微信买家',role:'buyer',merchantId:null,createdAt:time};
   if(value.appId!==caller.appId)fail(401,'wechat_context_invalid','应用身份不匹配。');
   if(env.BOOTSTRAP_ADMIN_ACCOUNT_ID&&USER_ID.test(env.BOOTSTRAP_ADMIN_ACCOUNT_ID)&&env.BOOTSTRAP_ADMIN_ACCOUNT_ID===caller.id&&!bootstrap&&value.role==='buyer'&&!value.merchantId) {
    value={...value,role:'admin',name:'平台管理员'};
    await tx.set('meta','admin-bootstrap',{userId:caller.id,appId:caller.appId,claimedAt:time,source:'explicit_environment_account'});
   }
   value={...value,updatedAt:time};await tx.set('users',caller.id,value);
   await tx.set('sessions',digest(token),{userId:caller.id,appId:caller.appId,createdAt:time,expiresAt,revokedAt:null});
   await tx.set('meta','login-rate:'+caller.id,{minute,count,updatedAt:time});return withMerchant(tx,value);
  });
  return {token,expiresAt,session:sessionDTO(user)};
 }
 async function logout(body,event,caller) {
  fields(body,[]);if(!TOKEN.test(event.sessionToken||''))fail(401,'session_invalid','登录状态无效，请重新登录。');
  if(event.expectedUserId!==undefined&&event.expectedUserId!==caller.id)fail(409,'account_changed','微信账号已变化。');
  await store.transaction(async tx=>{const value=await tx.get('sessions',digest(event.sessionToken));if(!value)return;if(value.userId!==caller.id||value.appId!==caller.appId)fail(401,'session_invalid','登录状态无效。');if(!value.revokedAt)await tx.set('sessions',digest(event.sessionToken),{...value,revokedAt:now()});});
  return {signedOut:true};
 }
 return {identity,login,logout};
}
module.exports={subject,sessionDTO,merchantDTO,has,createAuth};
