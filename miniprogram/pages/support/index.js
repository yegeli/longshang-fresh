const {market,page,toast}=require('../_shared');
const {side,scope,inboxView,filterThreads}=require('./model');
page({
 data:{allowed:false,needLogin:false,serviceMode:'buyer',threads:[],visibleThreads:[],unreadCount:0,filter:'all',query:''},
 init(){this._supportSeq=0;this._scope='';wx.hideShareMenu?.({menus:['shareAppMessage','shareTimeline']});},
 async load(){return {};},
 onHide(){this._supportSeq++;this.setData({allowed:false,threads:[],visibleThreads:[],unreadCount:0});},
 onUnload(){this._alive=false;this._supportSeq++;this._loadSeq++;},
 async refresh(){
  const seq=++this._supportSeq,current=()=>this._alive&&seq===this._supportSeq;
  const mode=side(this._query.mode);this.setData({loading:true,error:'',allowed:false,needLogin:false,threads:[],visibleThreads:[],unreadCount:0,serviceMode:mode});
  try{
   if(this._query.mode!==undefined&&!['buyer','merchant'].includes(this._query.mode))throw Error('咨询入口无效，请重新进入。');
   if(market.mode!=='cloud'){this.setData({loading:false});return;}
   const session=await market.getSession();if(!current())return;
   const nextScope=scope(session,mode,market.mode);
   if(!nextScope){this._scope='';this.setData({loading:false,needLogin:!session?.user});return;}
   if(this._scope!==nextScope)this.setData({filter:'all',query:''});
   this._scope=nextScope;
   const result=inboxView(await market.listSupportThreads(mode),mode);if(!current())return;
   if(scope(await market.getSession(),mode,market.mode)!==nextScope)throw Object.assign(Error('账号或权限已变化，请重新登录后查看咨询。'),{code:'account_changed'});
   if(!current())return;
   this.setData({...result,allowed:true,loading:false,visibleThreads:filterThreads(result.threads,this.data.filter,this.data.query)});
  }catch(error){if(current())this.setData({loading:false,error:error.message||'咨询读取失败，请重试。',allowed:false,threads:[],visibleThreads:[],unreadCount:0});}
  finally{wx.stopPullDownRefresh?.();}
 },
 chooseFilter(e){const filter=e.currentTarget.dataset.value;if(!['all','unread','open','closed'].includes(filter))return;this.setData({filter,visibleThreads:filterThreads(this.data.threads,filter,this.data.query)});},
 search(e){this.setData({query:e.detail.value,visibleThreads:filterThreads(this.data.threads,this.data.filter,e.detail.value)});},
 openThread(e){const thread=this.data.visibleThreads.find(row=>row.id===e.currentTarget.dataset.id);if(thread&&this.data.allowed)wx.navigateTo({url:'/pages/conversation/index?mode='+this.data.serviceMode+'&id='+encodeURIComponent(thread.id)});},
 login(){if(market.mode!=='cloud')return;return this.act(()=>market.login(),async()=>{await this.refresh();toast('微信登录成功');});},
 onShareAppMessage(){return {title:'家乡好物 · 模拟体验',path:'/pages/home/index'};}
});
