const {market,page,confirm,toast}=require('../_shared');
const M=require('../support/model');
const clone=value=>JSON.parse(JSON.stringify(value));
const KEY=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
function pendingFor(value,route,actor){
 if(!value)return null;
 if(typeof value!=='object'||value.actor!==actor||value.target!==route.target||value.mode!==route.mode||!['create','send'].includes(value.kind)||!KEY.test(value.idempotencyKey||'')||typeof value.text!=='string'||!value.text.trim()||value.text.length>600||value.kind==='send'&&value.threadId!==route.id||value.kind==='create'&&(route.id||value.context?.kind!==route.context?.kind||value.context?.id!==route.context?.id))throw Error('待发送记录与当前咨询不匹配，请返回原咨询核对。');
 return clone(value);
}
page({
 data:{allowed:false,needLogin:false,serviceMode:'buyer',thread:null,messages:[],context:null,text:'',pending:false,sendError:'',syncWarning:'',readWarning:'',unreadHint:'',sending:false},
 init(){this._conversationSeq=0;this._scope='';this._pending=null;this._hidden=false;wx.hideShareMenu?.({menus:['shareAppMessage','shareTimeline']});},
 async load(){return {};},
 onShow(){this._hidden=false;return this.refresh();},
 onHide(){this._hidden=true;this._conversationSeq++;this._readNext=null;this.setData({allowed:false,thread:null,messages:[],context:null});},
 onUnload(){this._alive=false;this._hidden=true;this._conversationSeq++;this._loadSeq++;},
 current(seq,scope){return this._alive&&!this._hidden&&seq===this._conversationSeq&&(!scope||scope===this._scope);},
 storageKey(actor,target){return 'longshang-support-pending:'+(market.storageNamespace||market.mode)+':'+actor+':'+this._route.mode+':'+target;},
 clearPrivate(){this._scope='';this._pending=null;this._actor='';this.setData({allowed:false,thread:null,messages:[],context:null,text:'',pending:false,sending:false,processing:false,sendError:'',readWarning:'',unreadHint:''});},
 async verify(scope){const session=await market.getSession();if(M.scope(session,this._route.mode,market.mode)!==scope)throw Object.assign(Error('账号或权限已变化，请重新登录后查看。'),{code:'account_changed'});return session;},
 async contextPreview(context){
  if(context.kind==='product'){const source=(await market.getCatalog()).products.find(row=>row.id===context.id);if(!source)throw Error('这件商品已下架，请从已有咨询或订单联系商家。');return {...context,title:source.name,shopId:source.shopId||''};}
  if(context.kind==='order'){const {order}=await market.getOrder(context.id);if(!order||order.id!==context.id)throw Error('订单不存在或当前账户无权查看。');return {...context,title:'订单 '+order.id,shopId:order.shopId||''};}
  const shop=(await market.getStorefront()).shops.find(row=>row.id===context.id&&!row.preview);if(!shop)throw Error('这家店铺暂时无法咨询，请从自己的订单联系商家。');return {...context,title:shop.name,shopId:shop.id};
 },
 async refresh(){
  if(this._sending||this._changing){toast('请等待当前操作完成');wx.stopPullDownRefresh?.();return;}
  const seq=++this._conversationSeq,current=()=>this.current(seq);
  this.setData({loading:true,error:'',allowed:false,needLogin:false,thread:null,messages:[],context:null,readWarning:'',unreadHint:'',sending:false,processing:false});
  try{
   this._route=M.route(this._query);this.setData({serviceMode:this._route.mode});
   if(market.mode!=='cloud'){this.setData({loading:false});return;}
   const session=await market.getSession();if(!current())return;
   const scope=M.scope(session,this._route.mode,market.mode);
   if(!scope){this.clearPrivate();this.setData({loading:false,needLogin:!session?.user});return;}
   if(scope!==this._scope){this.setData({text:'',sendError:'',syncWarning:'',pending:false});this._pending=null;}
   this._scope=scope;this._actor=session.user.id;this._pendingKey=this.storageKey(this._actor,this._route.target);
   this._pending=pendingFor(wx.getStorageSync(this._pendingKey),this._route,this._actor);
   if(this._pending)this.setData({text:this._pending.text,pending:true});else this.setData({pending:false});
   const result=this._route.id?M.threadView((await market.getSupportThread(this._route.id,this._route.mode)).thread,this._route.mode,true):this._pending?.kind==='create'?{...this._route.context,title:'待核对的'+({product:'商品',order:'订单',shop:'店铺'})[this._route.context.kind]+'咨询',shopId:''}:await this.contextPreview(this._route.context);
   if(!current())return;await this.verify(scope);if(!current())return;
   if(this._route.id)this.renderThread(result,seq,scope,{loading:false,allowed:true});
   else this.setData({loading:false,allowed:true,context:result});
  }catch(error){if(current()){if(M.privateFailure(error))this.clearPrivate();this.setData({loading:false,error:error.message||'咨询读取失败，请重试。',allowed:false,thread:null,messages:[],context:null});}}
  finally{wx.stopPullDownRefresh?.();}
 },
 renderThread(thread,seq,scope,extra={}){
  if(!this.current(seq,scope))return;
  const existing=this.data.thread;
  if(existing&&existing.id===thread.id&&existing.version>thread.version)return;
  this.setData({thread,context:thread.context,messages:thread.messages,...extra},()=>{
   if(this.current(seq,scope)&&thread.readSeq<thread.lastSeq)this.ackRead(thread.id,thread.lastSeq,seq,scope);
  });
 },
 async ackRead(id,lastReadSeq,seq,scope){
  if(!this.current(seq,scope))return;
  if(this._reading){this._readNext={id,lastReadSeq,seq,scope};return;}
  const run={};this._reading=run;
  try{
   await this.verify(scope);if(!this.current(seq,scope))return;
   const response=await market.markSupportRead(id,{lastReadSeq},this._route.mode,this._actor);
   const acknowledged=M.threadView(response.thread,this._route.mode,true);
   await this.verify(scope);if(!this.current(seq,scope)||this.data.thread?.id!==id)return;
   const thread=this.data.thread,readSeq=Math.max(thread.readSeq,Math.min(lastReadSeq,acknowledged.readSeq));
   this.setData({thread:{...thread,readSeq,unreadCount:acknowledged.lastSeq===thread.lastSeq?acknowledged.unreadCount:thread.unreadCount},readWarning:'',unreadHint:acknowledged.lastSeq>thread.lastSeq?'有新消息，点击刷新后查看。':''});
  }catch(error){if(this.current(seq,scope)){if(M.privateFailure(error)){this.clearPrivate();this.setData({error:error.message});}else this.setData({readWarning:'未读标记尚未同步，刷新可重试；消息记录仍保留。'});}}
  finally{if(this._reading===run){this._reading=null;const next=this._readNext;this._readNext=null;if(next&&this.current(next.seq,next.scope))this.ackRead(next.id,next.lastReadSeq,next.seq,next.scope);}}
 },
 input(e){if(this._sending||this._changing||this._pending||!this.data.allowed)return;this.setData({text:e.detail.value,sendError:''});},
 async send(){
  if(this._sending||this._changing||this.data.loading||!this.data.allowed)return;
  const route=this._route,scope=this._scope,actor=this._actor,seq=this._conversationSeq;
  if(!route||!scope||!actor)return;
  let pending=this._pending;
  this._sending=true;this.setData({sending:true,processing:true,sendError:'',syncWarning:''});
  try{
   await this.verify(scope);if(!this.current(seq,scope))return;
   if(!pending&&this.data.thread&&!this.data.thread.canReply)throw Error('这条咨询已结束，请先重新开启后发送。');
   if(!pending){
    const text=this.data.text.trim();if(!text||text.length>600)throw Error('请填写1至600字的咨询内容。');
    const idempotencyKey=market.newRequestKey();if(!KEY.test(idempotencyKey))throw Error('发送编号未能生成，请重新进入。');
    pending={actor,target:route.target,mode:route.mode,kind:route.id?'send':'create',...(route.id?{threadId:route.id}:{context:route.context}),text,idempotencyKey};
    try{wx.setStorageSync(this._pendingKey,pending);}catch{throw Error('待发送记录未能保存，本次尚未发送，请恢复本机存储后重试。');}
    this._pending=pending;this.setData({pending:true,text:pending.text});
   }
   const pendingKey=this._pendingKey;
   const response=pending.kind==='create'?await market.createSupportThread({context:pending.context,text:pending.text,idempotencyKey:pending.idempotencyKey},actor):await market.sendSupportMessage(pending.threadId,{text:pending.text,idempotencyKey:pending.idempotencyKey},route.mode,actor);
   const thread=M.threadView(response.thread,route.mode,true);await this.verify(scope);
   if(!this.current(seq,scope))return;
   let cleanupFailed=false;try{wx.removeStorageSync(pendingKey);}catch{cleanupFailed=true;}
   if(!this.current(seq,scope))return;
   this._pending=null;this._route={mode:route.mode,id:thread.id,target:'thread:'+thread.id};this._query={mode:route.mode,id:thread.id};this._pendingKey=this.storageKey(actor,this._route.target);
   this.setData({text:'',pending:false,sendError:'',syncWarning:cleanupFailed?'消息已发送，本机核对标记稍后清理。重新进入原咨询时请先核对记录。':''});
   this.renderThread(thread,seq,scope,{allowed:true});toast(response.replayed?'已核对，这条消息已送达':'消息已发送');
  }catch(error){if(this.current(seq,scope)){if(M.privateFailure(error)){this.clearPrivate();this.setData({error:error.message});}else this.setData({sendError:error.message||'发送结果尚未确认，请核对后重试。',pending:!!this._pending});}}
  finally{this._sending=false;if(this.current(seq,scope))this.setData({sending:false,processing:false});else if(this._alive&&!this._hidden&&seq!==this._conversationSeq)await this.refresh();}
 },
 async discardPending(){
  if(this._sending||this._changing||!this._pending)return;
  const seq=this._conversationSeq,scope=this._scope;
  if(!await confirm('放弃本机重试记录？','上条消息可能已送达。请先刷新核对；放弃只解除本页输入锁定，不撤回云端消息。'))return;
  try{await this.verify(scope);if(!this.current(seq,scope))return;wx.removeStorageSync(this._pendingKey);this._pending=null;this.setData({pending:false,sendError:'',syncWarning:'已放弃本机重试记录，请核对云端消息后再编辑。'});}
  catch(error){if(this.current(seq,scope)){if(M.privateFailure(error))this.clearPrivate();this.setData({sendError:error.message||'未能清理重试记录，请稍后再试。'});}}
 },
 async changeStatus(e){
  if(this._sending||this._changing||!this.data.allowed||!this.data.thread)return;
  const status=e.currentTarget.dataset.status,thread=this.data.thread,scope=this._scope,seq=this._conversationSeq,actor=this._actor;
  if(!['open','closed'].includes(status)||!thread.canManage||status==='open'&&!thread.canReopen)return;
  if(!await confirm(status==='closed'?'结束这条咨询？':'重新开启咨询？',status==='closed'?'历史消息仍会保留，后续有问题可以重新开启。':'开启后可以继续发送模拟咨询消息。'))return;
  this._changing=true;this.setData({processing:true,sendError:''});
  try{await this.verify(scope);if(!this.current(seq,scope))return;const response=await market.setSupportStatus(thread.id,{status,expectedVersion:thread.version},this._route.mode,actor);const saved=M.threadView(response.thread,this._route.mode,true);await this.verify(scope);if(this.current(seq,scope))this.renderThread(saved,seq,scope);}
  catch(error){if(this.current(seq,scope)){if(M.privateFailure(error)){this.clearPrivate();this.setData({error:error.message});}else this.setData({sendError:error.message||'状态未确认，请刷新后核对。'});}}
  finally{this._changing=false;if(this.current(seq,scope))this.setData({processing:false});else if(this._alive&&!this._hidden&&seq!==this._conversationSeq)await this.refresh();}
 },
 login(){if(market.mode!=='cloud')return;return this.act(()=>market.login(),async()=>{await this.refresh();toast('微信登录成功');});},
 inbox(){wx.redirectTo({url:'/pages/support/index?mode='+this.data.serviceMode});},
 onShareAppMessage(){return {title:'家乡好物 · 模拟体验',path:'/pages/home/index'};}
});
