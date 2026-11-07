const {market,page,productView,orderView,confirm,toast}=require('../_shared');
const {project,scopeOf}=require('./model');
const emptyLists=()=>({allowed:false,products:[],orders:[],visibleProducts:[],visibleOrders:[],selected:null,actorId:'',scope:'',canProducts:false,canOrders:false,canAfter:false,note:'',noteVersion:0});
function managedOrder(row,canOrders,canAfter){const {merchantNote,...withoutNote}=row;const order=orderView(canOrders?row:withoutNote);return {...order,canShip:canOrders&&order.canCancel,canResolve:canAfter&&row.afterSale?.status==='submitted'};}
page({
  data:{...emptyLists(),tab:'products',productQuery:'',orderQuery:'',afterQuery:'',productFilter:'all',orderFilter:'all',afterFilter:'submitted',counts:{},carrier:'模拟物流',tracking:'',reply:''},
  async load(){
    const loadSeq=this._loadSeq,current=()=>this._alive&&loadSeq===this._loadSeq;
    try{
      const session=await market.getSession(),scope=scopeOf(session,market.mode);
      if(!current())return {};
      if(!scope){this._noteDirty=false;return {...emptyLists(),session};}
      const can=value=>session.role==='admin'||(session.permissions||[]).includes(value);
      const canProducts=can('products'),canOrders=can('orders'),canAfter=can('aftersales');
      const [catalog,stock,result]=await Promise.all([
        canProducts?market.getManagementProducts():{products:[]},canProducts?market.getManagementInventory():{inventories:[]},
        canOrders||canAfter?market.listManagementOrders():{orders:[]}
      ]);
      if(!current())return {};
      const latest=await market.getSession();if(!current())return {};
      if(scopeOf(latest,market.mode)!==scope)throw Error('账号或权限已变化，请重新读取工作台。');
      const sameScope=this.data.scope===scope,products=catalog.products.map(p=>productView(p,stock.inventories));
      const orders=result.orders.map(row=>managedOrder(row,canOrders,canAfter));
      const tabs=[canProducts&&'products',canOrders&&'orders',canAfter&&'after'].filter(Boolean);
      const filters=sameScope?{}:{productQuery:'',orderQuery:'',afterQuery:'',productFilter:'all',orderFilter:'all',afterFilter:'submitted'};
      const selected=sameScope&&this.data.selected?orders.find(row=>row.id===this.data.selected.id)||null:null;
      if(!sameScope||!selected)this._noteDirty=false;
      const next={...filters,allowed:true,session,scope,actorId:session.user.id,canProducts,canOrders,canAfter,
        tab:tabs.includes(this.data.tab)?this.data.tab:tabs[0],products,orders,selected,
        note:canOrders&&selected?(this._noteDirty?this.data.note:selected.merchantNote||''):'',
        noteVersion:canOrders&&selected?(this._noteDirty?this.data.noteVersion:selected.version):0};
      return {...next,...project({...this.data,...next})};
    }catch(error){if(current()){this.setData(emptyLists());this._noteDirty=false;}throw error;}
  },
  recompute(patch){const next={...this.data,...patch};this.setData({...patch,...project(next)});},
  chooseTab(e){const tab=e.currentTarget.dataset.tab;if(this._busy||!({products:this.data.canProducts,orders:this.data.canOrders,after:this.data.canAfter})[tab])return;this.recompute({tab,selected:null,note:'',noteVersion:0,error:''});this._noteDirty=false;},
  search(e){const field={products:'productQuery',orders:'orderQuery',after:'afterQuery'}[this.data.tab];if(field)this.recompute({[field]:e.detail.value});},
  filter(e){const field={products:'productFilter',orders:'orderFilter',after:'afterFilter'}[this.data.tab];if(field)this.recompute({[field]:e.currentTarget.dataset.value});},
  clearSearch(){const field={products:'productQuery',orders:'orderQuery',after:'afterQuery'}[this.data.tab];if(field)this.recompute({[field]:''});},
  selectOrder(e){
    if(this._busy)return;const selected=this.data.visibleOrders.find(row=>row.id===e.currentTarget.dataset.id);
    if(selected){this._noteDirty=false;this.setData({selected,note:this.data.canOrders?selected.merchantNote||'':'',noteVersion:this.data.canOrders?selected.version:0,carrier:'模拟物流',tracking:'DEMO-'+Date.now(),reply:'已完成模拟处理，无真实退款或补发。',error:''});wx.pageScrollTo?.({selector:'#order-management-panel',duration:250});}
  },
  field(e){if(this._busy)return;const key=e.currentTarget.dataset.field;if(['carrier','tracking','reply','note'].includes(key)){if(key==='note'){if(!this.data.canOrders)return;this._noteDirty=true;}this.setData({[key]:e.detail.value});}},
  closeOrder(){if(this._busy)return;this._noteDirty=false;this.setData({selected:null,note:'',noteVersion:0});},
  async reloadNote(){
    if(this._busy||!this.data.canOrders||!this.data.selected)return;
    if(this._noteDirty&&!await confirm('放弃未保存的备注草稿？','保留云端最新备注，当前未保存的文字将被替换。'))return;
    this._noteDirty=false;await this.refresh();
  },
  saveNote(){
    const order=this.data.selected,actorId=this.data.actorId,note=this.data.note,noteVersion=this.data.noteVersion,scope=this.data.scope;
    return this.act(async()=>{
      if(!order||!actorId||!this.data.canOrders)throw Error('当前账户没有订单备注权限。');
      if(note.length>300)throw Error('内部备注最多300字。');
      if(noteVersion!==order.version)throw Error('订单已更新，备注草稿仍保留。请核对后读取最新备注再修改。');
      try{
        const result=await market.saveManagementOrderNote(order.id,{expectedVersion:noteVersion,note:note.trim()},actorId);
        if(scopeOf(await market.getSession(),market.mode)!==scope||this.data.scope!==scope)throw Object.assign(Error('账号或权限已变化，请重新读取工作台。'),{code:'account_changed'});
        return result;
      }catch(error){
        if(this.data.scope===scope&&(error.status===401||error.status===403||['stale_session','account_changed','session_invalid','sign_in_required','forbidden'].includes(error.code))){this._noteDirty=false;if(this._alive)this.setData(emptyLists());}
        throw error;
      }
    },result=>{
      if(!result?.order)return;
      const selected=managedOrder(result.order,this.data.canOrders,this.data.canAfter);
      this._noteDirty=false;
      this.recompute({orders:this.data.orders.map(row=>row.id===selected.id?selected:row),selected,note:selected.merchantNote||'',noteVersion:selected.version});
      toast('内部备注已保存');
    });
  },
  operate(e){
    const action=e.currentTarget.dataset.action,order=this.data.selected,actorId=this.data.actorId;
    if(!order||!actorId)return;
    const input=action==='ship'?{expectedVersion:order.version,carrier:this.data.carrier.trim(),tracking:this.data.tracking.trim()}:{expectedVersion:order.version,reply:this.data.reply.trim()};
    return this.act(async()=>{
      if(action==='ship'&&!order.canShip||action==='resolve'&&!order.canResolve)throw Error('当前订单或权限不支持此操作，请重新读取。');
      if(!['ship','resolve'].includes(action))throw Error('操作无效。');
      if(!await confirm(action==='ship'?'保存模拟发货？':'完成模拟售后？','订单 '+order.id+'。不生成真实运单，不实际退款或补发。'))return false;
      if(action==='ship')await market.shipManagementOrder(order.id,input,actorId);
      else await market.resolveManagementAfterSale(order.id,input,actorId);
      return true;
    },async saved=>{if(saved){await this.refresh();toast('模拟处理已保存到云端');}});
  }
});
