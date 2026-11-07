const {market,page}=require('../_shared');
const {scopeOf}=require('../workbench/model');
const {eventPage}=require('./presentation');
const definitions={product:{title:'商品操作记录',method:'getManagementProductHistory'},inventory:{title:'库存变更记录',method:'getManagementInventoryHistory'},merchant:{title:'采购者授权记录',method:'getWechatMerchantAudit'}};
const access=(session,kind)=>!!scopeOf(session,market.mode)&&(kind==='merchant'?session.role==='admin':session.role==='admin'||(session.permissions||[]).includes('products'));
const sensitive=error=>error.status===401||error.status===403||['stale_session','account_changed','session_invalid','sign_in_required','forbidden'].includes(error.code);
function changed(){const error=Error('账号或权限已变化，请重新读取记录。');error.code='account_changed';return error;}
page({
  data:{allowed:false,events:[],nextCursor:null,moreLoading:false,moreError:'',title:'操作记录',kind:'',recordId:''},
  init(){this._recordSeq=0;this._cursors=new Set();},
  async load(){return {};},
  onHide(){this._recordSeq++;this.setData({allowed:false,events:[],nextCursor:null,moreLoading:false});},
  onUnload(){this._alive=false;this._loadSeq++;this._recordSeq++;},
  async refresh(){
    const seq=++this._recordSeq,isCurrent=()=>this._alive&&seq===this._recordSeq;
    this._cursors=new Set();this._scope='';
    this.setData({loading:true,error:'',moreError:'',moreLoading:false,allowed:false,events:[],nextCursor:null});
    try{
      const {kind,id}=this._query,definition=definitions[kind];
      if(!definition||!(kind==='merchant'?/^MERCHANT-[A-F0-9-]{36}$/:/^[a-z0-9][a-z0-9-]{1,63}$/).test(id||''))throw Error('记录入口无效，请从工作台重新进入。');
      this.setData({kind,recordId:id,title:definition.title});
      const session=await market.getSession();if(!isCurrent())return;
      if(!access(session,kind))throw Object.assign(Error(kind==='merchant'?'仅平台管理员可查看采购者授权记录。':'当前账户没有商品或库存记录权限。'),{code:'forbidden'});
      const scope=scopeOf(session,market.mode),result=eventPage(kind,await market[definition.method](id));
      if(!isCurrent())return;
      const latest=await market.getSession();if(!isCurrent())return;
      if(!access(latest,kind)||scopeOf(latest,market.mode)!==scope)throw changed();
      this._scope=scope;this.setData({allowed:true,events:result.events,nextCursor:result.nextCursor,loading:false});
    }catch(error){if(isCurrent())this.setData({loading:false,error:error.message||'读取记录失败，请重试。',allowed:false,events:[],nextCursor:null});}
    finally{wx.stopPullDownRefresh?.();}
  },
  async more(){
    if(this.data.moreLoading||this.data.loading||!this.data.allowed||!this.data.nextCursor)return;
    const seq=this._recordSeq,cursor=this.data.nextCursor,scope=this._scope,{kind,recordId}=this.data;
    const isCurrent=()=>this._alive&&seq===this._recordSeq;
    this.setData({moreLoading:true,moreError:''});
    try{
      const session=await market.getSession();if(!isCurrent())return;
      if(!access(session,kind)||scopeOf(session,market.mode)!==scope)throw changed();
      const result=eventPage(kind,await market[definitions[kind].method](recordId,cursor));
      if(!isCurrent())return;
      const latest=await market.getSession();if(!isCurrent())return;
      if(!access(latest,kind)||scopeOf(latest,market.mode)!==scope)throw changed();
      if(result.nextCursor&&(result.nextCursor===cursor||this._cursors.has(result.nextCursor)))throw Error('记录分页重复，请刷新后核对。');
      const ids=new Set(this.data.events.map(row=>row.id));
      this._cursors.add(cursor);
      this.setData({events:[...this.data.events,...result.events.filter(row=>!ids.has(row.id))],nextCursor:result.nextCursor,moreLoading:false});
    }catch(error){
      if(!isCurrent())return;
      if(sensitive(error)){this._scope='';this.setData({allowed:false,events:[],nextCursor:null,error:error.message,moreLoading:false});}
      else this.setData({moreError:error.message||'更多记录读取失败，已加载的记录仍保留。',moreLoading:false});
    }
  }
});
