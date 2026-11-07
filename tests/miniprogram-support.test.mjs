import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const ID='SUPPORT-11111111-1111-4111-8111-111111111111',SHOP='shop-'+'a'.repeat(24),ORDER='DEMO-22222222-2222-4222-8222-222222222222';
const A='wechat:'+'a'.repeat(64),B='wechat:'+'b'.repeat(64),TIME='2026-11-07T10:00:00.000Z';
const tap=dataset=>({currentTarget:{dataset}}),input=value=>({detail:{value}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const msg=(seq,side='buyer',text='模拟问题')=>({id:'message-'+seq,seq,side,senderLabel:side==='buyer'?'买家':'采购者',text,createdAt:TIME});
function thread(extra={}){return {id:ID,context:{kind:'product',id:'jingtai-apple',title:'景泰苹果（模拟）',shopId:SHOP},subject:'景泰苹果（模拟）',status:'open',version:1,createdAt:TIME,updatedAt:TIME,lastMessageAt:TIME,lastMessage:'模拟问题',lastSeq:1,readSeq:0,unreadCount:0,canReply:true,canManage:true,canReopen:false,messages:[msg(1)],...extra};}
function fixture({mode='cloud',role='buyer',permissions=[],storage=new Map()}={}){
 const calls=[],notices=[],navigation=[];
 const state={session:{user:{id:A},role,permissions,canManage:role!=='buyer'},thread:thread(),threads:null,read:async()=>({thread:clone(state.thread)}),writeFailure:null,failStorage:false,failCleanup:false};
 let key=0;
 const market={mode,storageNamespace:'test-env',newRequestKey:()=> 'SUPPORT-KEY-'+(++key),
  getSession:async()=>clone(state.session),login:async()=>{state.session={user:{id:A},role:'buyer',permissions:[],canManage:false};return {session:clone(state.session)};},
  getCatalog:async()=>({products:[{id:'jingtai-apple',name:'景泰苹果（模拟）',shopId:SHOP}]}),getStorefront:async()=>({shops:[{id:SHOP,name:'景泰演示店'}]}),getOrder:async id=>({order:{id,shopId:SHOP}}),
  listSupportThreads:async mode=>{calls.push({method:'list',mode});return state.list?state.list():{threads:clone(state.threads||[state.thread]),nextCursor:null,unreadCount:(state.threads||[state.thread]).reduce((sum,row)=>sum+row.unreadCount,0)};},
  getSupportThread:async(id,mode)=>{calls.push({method:'get',id,mode});return state.get?state.get():{thread:clone(state.thread)};},
  createSupportThread:async(payload,actor)=>{calls.push({method:'create',payload:clone(payload),actor});if(state.writeFailure)throw state.writeFailure;if(state.create)return state.create(payload);state.thread=thread({messages:[msg(1,'buyer',payload.text)],lastMessage:payload.text});return {thread:clone(state.thread)};},
  sendSupportMessage:async(id,payload,mode,actor)=>{calls.push({method:'send',id,payload:clone(payload),mode,actor});if(state.writeFailure)throw state.writeFailure;if(state.send)return state.send(payload);const message=msg(state.thread.lastSeq+1,mode,payload.text);state.thread={...state.thread,messages:[...state.thread.messages,message],lastSeq:message.seq,lastMessage:message.text,version:state.thread.version+1};return {thread:clone(state.thread)};},
  markSupportRead:async(id,payload,mode,actor)=>{calls.push({method:'read',id,payload:clone(payload),mode,actor});return state.read(payload);},
  setSupportStatus:async(id,payload,mode,actor)=>{calls.push({method:'status',id,payload:clone(payload),mode,actor});if(state.status)return state.status(payload);if(payload.expectedVersion!==state.thread.version)throw Object.assign(Error('资料已更新，请刷新'),{status:409,code:'version_conflict'});state.thread={...state.thread,status:payload.status,canReply:payload.status==='open',canReopen:payload.status==='closed',version:state.thread.version+1};return {thread:clone(state.thread)};},
 };
 const wx={stopPullDownRefresh(){},hideShareMenu(){},showToast:options=>notices.push(options.title),showModal:options=>options.success({confirm:true}),
  getStorageSync:key=>clone(storage.get(key)),setStorageSync:(key,value)=>{if(state.failStorage)throw Error('storage full');storage.set(key,clone(value));},removeStorageSync:key=>{if(state.failCleanup)throw Error('storage blocked');storage.delete(key);},
  navigateTo:options=>navigation.push(options.url),redirectTo:options=>navigation.push(options.url),switchTab:options=>navigation.push(options.url)};
 const modules=new Map();let definition;
 function load(path){path=resolve(path);if(!path.endsWith('.js'))path+='.js';if(path===resolve('miniprogram/services/market.js'))return {getMarket:()=>market};if(modules.has(path))return modules.get(path).exports;
  const module={exports:{}};modules.set(path,module);vm.runInContext(readFileSync(path,'utf8'),vm.createContext({wx,console,module,exports:module.exports,Page:value=>{definition=value;},require:relative=>load(resolve(dirname(path),relative))}),{filename:path});return module.exports;}
 function make(name,query={}){const path=resolve('miniprogram/pages',name,'index.js');modules.delete(path);load(path);const page={...definition,data:clone(definition.data),setData(patch,callback){Object.assign(this.data,clone(patch));callback?.();}};page.onLoad(query);return page;}
 async function open(name,query={}){const page=make(name,query);await page.onShow();await tick();return page;}
 return {state,market,wx,calls,notices,navigation,storage,make,open};
}

test('native support refuses mock, unauthenticated management and forged routes without loading private threads',async()=>{
 const mock=fixture({mode:'mock'});assert.equal((await mock.open('support')).data.allowed,false);assert.equal((await mock.open('conversation',{productId:'jingtai-apple'})).data.allowed,false);assert.equal(mock.calls.length,0);
 const buyer=fixture();assert.equal((await buyer.open('support',{mode:'merchant'})).data.allowed,false);assert.equal((await buyer.open('conversation',{mode:'merchant',id:ID})).data.allowed,false);assert.equal(buyer.calls.length,0);
 const invalid=await buyer.open('conversation',{id:ID,productId:'jingtai-apple'});assert.match(invalid.data.error,/编号无效/);assert.equal(buyer.calls.length,0);
 const anonymous=fixture();anonymous.state.session={user:null};const page=await anonymous.open('conversation',{productId:'jingtai-apple'});assert.equal(page.data.needLogin,true);assert.equal(anonymous.calls.length,0);await page.login();assert.equal(page.data.allowed,true);assert.equal(page.data.context.id,'jingtai-apple');assert.equal(anonymous.calls.some(row=>row.method==='create'),false);
});

test('inbox filters full authorized summaries, shows unread counts and navigates to the correct side',async()=>{
 const r=fixture({role:'merchant',permissions:['aftersales']});r.state.threads=[thread({unreadCount:1}),thread({id:'SUPPORT-33333333-3333-4333-8333-333333333333',subject:'模拟土豆',context:{kind:'product',id:'potato',title:'模拟土豆',shopId:SHOP},status:'closed',unreadCount:0})];
 const page=await r.open('support',{mode:'merchant'});assert.equal(page.data.unreadCount,1);assert.equal(page.data.visibleThreads.length,2);
 page.chooseFilter(tap({value:'unread'}));assert.equal(page.data.visibleThreads.length,1);page.search(input('土豆'));assert.equal(page.data.visibleThreads.length,0);page.chooseFilter(tap({value:'all'}));assert.equal(page.data.visibleThreads.length,1);page.search(input('苹果'));assert.equal(page.data.visibleThreads.length,1);page.openThread(tap({id:ID}));assert.equal(r.navigation[0],'/pages/conversation/index?mode=merchant&id='+ID);
 await page.refresh();assert.equal(page.data.query,'苹果');assert.equal(page.data.threads.length,2);assert.equal(page.data.visibleThreads.length,1);
});

test('inbox late responses and permission changes never reveal a previous account consultation',async()=>{
 const r=fixture(),wait=deferred();r.state.list=()=>wait.promise;const page=r.make('support'),opening=page.onShow();await tick();page.onHide();wait.resolve({threads:[thread()],nextCursor:null,unreadCount:0});await opening;assert.equal(page.data.allowed,false);assert.equal(page.data.threads.length,0);
 r.state.list=null;await page.onShow();assert.equal(page.data.allowed,true);r.state.session={user:{id:B},role:'merchant',canManage:true,permissions:['products']};page._query.mode='merchant';await page.refresh();assert.equal(page.data.allowed,false);assert.equal(page.data.threads.length,0);
});

test('first question creates only on send, saves complete pending payload and binds subsequent sends to returned thread',async()=>{
 const r=fixture(),page=await r.open('conversation',{productId:'jingtai-apple'});assert.equal(r.calls.some(row=>row.method==='create'),false);assert.equal(page.data.context.title,'景泰苹果（模拟）');page.input(input('  苹果大小是多少（模拟）？  '));await page.send();await tick();
 const create=r.calls.find(row=>row.method==='create');assert.deepEqual(create.payload,{context:{kind:'product',id:'jingtai-apple'},text:'苹果大小是多少（模拟）？',idempotencyKey:'SUPPORT-KEY-1'});assert.equal(create.actor,A);assert.equal(page.data.thread.id,ID);assert.equal(page.data.text,'');assert.equal(page.data.pending,false);assert.equal(r.storage.size,0);assert.equal(page._query.id,ID);
 page.input(input('请再介绍包装（模拟）'));await page.send();assert.equal(r.calls.filter(row=>row.method==='create').length,1);assert.equal(r.calls.filter(row=>row.method==='send').length,1);assert.equal(page.data.messages.length,2);
});

test('uncertain first send persists the exact key and text across hide and reopen and retries without a second logical message',async()=>{
 const r=fixture(),page=await r.open('conversation',{shopId:SHOP});r.state.writeFailure=Object.assign(Error('网络未确认'),{code:'network_error'});page.input(input('模拟店铺咨询'));await page.send();assert.equal(page.data.pending,true);assert.equal(r.storage.size,1);const before=clone(r.calls.find(row=>row.method==='create').payload);page.input(input('不应覆盖待核对消息'));assert.equal(page.data.text,'模拟店铺咨询');page.onHide();
 const reopened=await r.open('conversation',{shopId:SHOP});assert.equal(reopened.data.text,'模拟店铺咨询');assert.equal(reopened.data.pending,true);r.state.writeFailure=null;await reopened.send();assert.deepEqual(r.calls.filter(row=>row.method==='create')[1].payload,before);assert.equal(reopened.data.messages.length,1);assert.equal(reopened.data.pending,false);assert.equal(r.storage.size,0);
});

test('pending persistence failure blocks writes and a failed cleanup does not turn confirmed delivery into a failed send',async()=>{
 const r=fixture(),page=await r.open('conversation',{orderId:ORDER});page.input(input('模拟订单问题'));r.state.failStorage=true;await page.send();assert.match(page.data.sendError,/尚未发送/);assert.equal(r.calls.some(row=>row.method==='create'),false);assert.equal(page.data.text,'模拟订单问题');
 r.state.failStorage=false;r.state.failCleanup=true;await page.send();assert.equal(page.data.thread.id,ID);assert.equal(page.data.text,'');assert.equal(page.data.sendError,'');assert.match(page.data.syncWarning,/消息已发送/);assert.equal(page.data.pending,false);
});

test('read acknowledgment covers only the rendered sequence and cannot make concurrent unseen messages disappear',async()=>{
 const r=fixture();r.state.thread=thread({messages:[msg(1,'merchant','模拟回复')],unreadCount:1});r.state.read=async()=>({thread:thread({version:2,messages:[msg(1,'merchant','模拟回复'),msg(2,'merchant','未显示的新回复')],lastSeq:2,readSeq:1,unreadCount:1})});
 const page=await r.open('conversation',{id:ID});await tick();const read=r.calls.find(row=>row.method==='read');assert.equal(read.payload.lastReadSeq,1);assert.equal(page.data.messages.length,1);assert.equal(page.data.thread.version,1);assert.match(page.data.unreadHint,/有新消息/);assert.equal(page.data.thread.readSeq,1);
});

test('read failure preserves displayed messages and hides stale data if identity changes during an acknowledgement',async()=>{
 const r=fixture();r.state.read=async()=>{throw Error('标记网络失败');};const page=await r.open('conversation',{id:ID});await tick();assert.equal(page.data.messages.length,1);assert.match(page.data.readWarning,/尚未同步/);
 r.state.read=async()=>{r.state.session.user.id=B;return {thread:thread({readSeq:1})};};await page.refresh();await tick();assert.equal(page.data.allowed,false);assert.equal(page.data.messages.length,0);assert.match(page.data.error,/账号或权限/);
});

test('late detail responses after hiding never render or acknowledge unseen messages',async()=>{
 const r=fixture(),wait=deferred();r.state.get=()=>wait.promise;const page=r.make('conversation',{id:ID}),opening=page.onShow();await tick();page.onHide();wait.resolve({thread:thread()});await opening;await tick();assert.equal(page.data.allowed,false);assert.equal(page.data.messages.length,0);assert.equal(r.calls.some(row=>row.method==='read'),false);
});

test('send protects in-flight input and never restores messages after switching accounts',async()=>{
 const r=fixture(),page=await r.open('conversation',{id:ID}),wait=deferred();r.state.send=()=>wait.promise;page.input(input('准备发送的模拟问题'));const sending=page.send();await tick();page.input(input('飞行期不应接受的内容'));assert.equal(page.data.text,'准备发送的模拟问题');r.state.session.user.id=B;wait.resolve({thread:thread({version:2,lastSeq:2,messages:[msg(1),msg(2)]})});await sending;assert.equal(page.data.allowed,false);assert.equal(page.data.messages.length,0);assert.equal(page.data.text,'');assert.equal(r.storage.size,1);
});

test('closed consultations keep history and editable drafts; reopening and closing use the displayed version',async()=>{
 const r=fixture(),page=await r.open('conversation',{id:ID});page.input(input('保留中的模拟草稿'));await page.changeStatus(tap({status:'closed'}));assert.equal(page.data.thread.status,'closed');assert.equal(page.data.messages.length,1);assert.equal(page.data.text,'保留中的模拟草稿');await page.send();assert.match(page.data.sendError,/已结束/);assert.equal(r.calls.some(row=>row.method==='send'),false);
 await page.changeStatus(tap({status:'open'}));assert.equal(page.data.thread.status,'open');assert.deepEqual(r.calls.filter(row=>row.method==='status').map(row=>row.payload.expectedVersion),[1,2]);r.state.thread.version=5;await page.changeStatus(tap({status:'closed'}));assert.match(page.data.sendError,/资料已更新/);assert.equal(page.data.text,'保留中的模拟草稿');assert.equal(page.data.thread.version,3);
});

test('a pending payload cannot cross accounts, and explicit discard is required before editing different content',async()=>{
 const r=fixture(),page=await r.open('conversation',{id:ID});r.state.writeFailure=Error('网络未确认');page.input(input('原待发送内容'));await page.send();assert.equal(page.data.pending,true);await page.discardPending();assert.equal(page.data.pending,false);page.input(input('经核对后的新内容'));assert.equal(page.data.text,'经核对后的新内容');
 await page.send();const oldKey=[...r.storage.keys()][0];r.state.session.user.id=B;const other=await r.open('conversation',{id:ID});assert.equal(other.data.pending,false);assert.equal(other.data.text,'');assert.equal(r.storage.has(oldKey),true);
});

test('uncertain creates remain recoverable after the original product is no longer in the public catalogue',async()=>{
 const r=fixture(),first=await r.open('conversation',{productId:'jingtai-apple'});r.state.writeFailure=Object.assign(Error('响应丢失'),{code:'network_error'});first.input(input('模拟已送达但未确认'));await first.send();first.onHide();
 r.market.getCatalog=async()=>{throw Error('商品已下架');};const recovered=await r.open('conversation',{productId:'jingtai-apple'});assert.equal(recovered.data.allowed,true);assert.equal(recovered.data.pending,true);assert.match(recovered.data.context.title,/待核对/);r.state.writeFailure=null;await recovered.send();assert.equal(recovered.data.thread.id,ID);assert.equal(recovered.data.sendError,'');assert.equal(r.calls.filter(row=>row.method==='create')[0].payload.idempotencyKey,r.calls.filter(row=>row.method==='create')[1].payload.idempotencyKey);
});

test('a pending send can replay after closure while a fresh message cannot bypass closed status',async()=>{
 const r=fixture(),first=await r.open('conversation',{id:ID});r.state.writeFailure=Error('响应丢失');first.input(input('待核对的原消息'));await first.send();first.onHide();r.state.thread={...r.state.thread,status:'closed',canReply:false,canReopen:true};
 const recovered=await r.open('conversation',{id:ID});assert.equal(recovered.data.pending,true);r.state.writeFailure=null;r.state.send=async()=>({thread:thread({status:'closed',canReply:false,canReopen:true,version:2,lastSeq:2,messages:[msg(1),msg(2,'buyer','待核对的原消息')]}),replayed:true});await recovered.send();assert.equal(recovered.data.pending,false);assert.equal(recovered.data.messages.length,2);assert.equal(recovered.data.thread.status,'closed');recovered.input(input('新的问题'));await recovered.send();assert.match(recovered.data.sendError,/已结束/);assert.equal(r.calls.filter(row=>row.method==='send').length,2);
});

test('leaving and returning during uncertain sends unlocks controls and recovers the original pending text',async()=>{
 const r=fixture(),page=await r.open('conversation',{id:ID}),wait=deferred();r.state.send=()=>wait.promise;page.input(input('离开页面前的模拟问题'));const sending=page.send();await tick();page.onHide();await page.onShow();assert.equal(page.data.allowed,false);wait.reject(Object.assign(Error('网络未确认'),{code:'network_error'}));await sending;await tick();assert.equal(page.data.allowed,true);assert.equal(page.data.sending,false);assert.equal(page.data.processing,false);assert.equal(page.data.pending,true);assert.equal(page.data.text,'离开页面前的模拟问题');
});

test('old read acknowledgements never replace newer messages confirmed by a send',async()=>{
 const r=fixture(),read=deferred();r.state.read=()=>read.promise;const page=await r.open('conversation',{id:ID});page.input(input('更新的模拟问题'));await page.send();assert.equal(page.data.messages.length,2);read.resolve({thread:thread({readSeq:1})});await tick();assert.equal(page.data.messages.length,2);assert.equal(page.data.thread.version,2);assert.equal(page.data.messages[1].text,'更新的模拟问题');
});

test('malformed message sequences fail closed rather than showing partial or duplicated history',async()=>{
 const r=fixture();r.state.thread=thread({lastSeq:2,messages:[msg(1),msg(1)]});const page=await r.open('conversation',{id:ID});assert.equal(page.data.allowed,false);assert.equal(page.data.messages.length,0);assert.match(page.data.error,/格式无效/);assert.equal(r.calls.some(row=>row.method==='read'),false);
});

test('a hidden confirmed send retains its replay marker until the visible page can adopt the returned thread',async()=>{
 const r=fixture(),page=await r.open('conversation',{productId:'jingtai-apple'}),wait=deferred();r.state.create=()=>wait.promise;page.input(input('离开时已送达的模拟问题'));const sending=page.send();await tick();const original=r.calls.find(row=>row.method==='create').payload;page.onHide();wait.resolve({thread:thread({messages:[msg(1,'buyer',original.text)]})});await sending;assert.equal(r.storage.size,1);assert.equal(page.data.allowed,false);
 await page.onShow();assert.equal(page.data.pending,true);r.state.create=async()=>({thread:thread({messages:[msg(1,'buyer',original.text)]}),replayed:true});await page.send();assert.equal(page.data.pending,false);assert.equal(page.data.thread.id,ID);assert.equal(page.data.messages.length,1);assert.deepEqual(r.calls.filter(row=>row.method==='create')[1].payload,original);assert.equal(r.storage.size,0);
});
