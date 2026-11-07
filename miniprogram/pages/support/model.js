const {dateTime}=require('../../services/display-time');
const THREAD=/^SUPPORT-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const CONTEXT={product:/^[a-z0-9][a-z0-9-]{1,63}$/,order:/^DEMO-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/,shop:/^shop-[a-f0-9]{24}$/};
const side=value=>value==='merchant'?'merchant':'buyer';
function scope(session,mode,serviceMode){
 if(serviceMode!=='cloud'||!session?.user||typeof session.user.id!=='string'||!session.user.id)return '';
 if(mode==='merchant'&&(!session.canManage||session.role!=='admin'&&!(session.role==='merchant'&&(session.permissions||[]).includes('aftersales'))))return '';
 return session.user.id+'|'+mode+'|'+session.role+'|'+[...(session.permissions||[])].sort().join(',');
}
function route(query){
 if(query.mode!==undefined&&!['buyer','merchant'].includes(query.mode))throw Error('咨询入口无效，请从商品、订单或工作台重新进入。');
 const mode=side(query.mode),kinds=Object.keys(CONTEXT).filter(kind=>query[kind+'Id']);
 if(query.id){if(!THREAD.test(query.id)||kinds.length)throw Error('咨询编号无效，请从消息列表重新进入。');return {mode,id:query.id,target:'thread:'+query.id};}
 if(mode==='merchant'||kinds.length!==1)throw Error('请从商品、店铺或自己的订单发起咨询。');
 const kind=kinds[0],id=query[kind+'Id'];if(!CONTEXT[kind].test(id))throw Error('咨询对象无效，请重新进入。');
 return {mode,context:{kind,id},target:kind+':'+id};
}
const integer=value=>Number.isSafeInteger(value)&&value>=0;
function threadView(row,mode,details=false){
 if(!row||!THREAD.test(row.id||'')||!row.context||!CONTEXT[row.context.kind]?.test(row.context.id||'')||!CONTEXT.shop.test(row.context.shopId||'')||typeof row.context.title!=='string'||!row.context.title||!['open','closed'].includes(row.status)||!integer(row.version)||row.version<1||!integer(row.lastSeq)||row.lastSeq<1||!integer(row.readSeq)||row.readSeq>row.lastSeq||!integer(row.unreadCount)||row.unreadCount>row.lastSeq||typeof row.subject!=='string'||typeof row.lastMessage!=='string'||typeof row.canReply!=='boolean'||typeof row.canManage!=='boolean'||typeof row.canReopen!=='boolean')throw Error('咨询资料格式无效，请重新读取。');
 const thread={id:row.id,context:{kind:row.context.kind,id:row.context.id,title:row.context.title,shopId:row.context.shopId},subject:row.subject,status:row.status,version:row.version,createdAt:row.createdAt,updatedAt:row.updatedAt,lastMessageAt:row.lastMessageAt,lastMessage:row.lastMessage,lastSeq:row.lastSeq,readSeq:row.readSeq,unreadCount:row.unreadCount,canReply:row.canReply,canManage:row.canManage,canReopen:row.canReopen,
  statusText:row.status==='closed'?'已结束':'咨询中',time:dateTime(row.lastMessageAt),contextLabel:({product:'商品咨询',order:'订单咨询',shop:'店铺咨询'})[row.context.kind]};
 if(details){
  if(!Array.isArray(row.messages)||row.messages.length!==row.lastSeq||row.messages.length>200)throw Error('消息记录不完整，请重新读取。');
  const ids=new Set();thread.messages=row.messages.map((message,index)=>{
   if(!message||typeof message.id!=='string'||!message.id||ids.has(message.id)||message.seq!==index+1||!['buyer','merchant'].includes(message.side)||typeof message.senderLabel!=='string'||!message.senderLabel||typeof message.text!=='string'||!message.text.trim()||message.text.length>600||!dateTime(message.createdAt))throw Error('消息记录格式无效，请重新读取。');
   ids.add(message.id);return {id:message.id,seq:message.seq,side:message.side,senderLabel:message.senderLabel,text:message.text,createdAt:message.createdAt,time:dateTime(message.createdAt),own:message.side===mode};
  });
 }
 return thread;
}
function inboxView(result,mode){
 if(!result||!Array.isArray(result.threads)||result.threads.length>200||result.nextCursor!=null||!integer(result.unreadCount))throw Error('咨询列表格式无效，请重新读取。');
 const ids=new Set(),threads=result.threads.map(row=>{const thread=threadView(row,mode);if(ids.has(thread.id))throw Error('咨询列表出现重复，请重新读取。');ids.add(thread.id);return thread;});
 return {threads,unreadCount:threads.reduce((sum,row)=>sum+row.unreadCount,0)};
}
function filterThreads(threads,filter,query){
 const term=(query||'').trim().toLowerCase();return threads.filter(row=>(filter==='all'||filter==='unread'&&row.unreadCount>0||row.status===filter)&&(!term||[row.subject,row.context.title,row.lastMessage].join(' ').toLowerCase().includes(term)));
}
const privateFailure=error=>error?.status===401||error?.status===403||['account_changed','stale_session','session_invalid','sign_in_required','forbidden'].includes(error?.code);
module.exports={THREAD,CONTEXT,side,scope,route,threadView,inboxView,filterThreads,privateFailure};
