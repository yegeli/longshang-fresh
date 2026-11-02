const {market,page,productView,orderView,confirm,toast}=require('../_shared');
page({
  data:{tab:'products',products:[],orders:[],selected:null,carrier:'模拟物流',tracking:'',reply:''},
  async load(){
    const session=await market.getSession();
    const allowed=market.mode==='cloud'&&!!session.user&&session.canManage;
    if(!allowed)return {allowed:false,session,products:[],orders:[],selected:null,actorId:''};
    const can=value=>session.role==='admin'||(session.permissions||[]).includes(value);
    const canProducts=can('products'),canOrders=can('orders'),canAfter=can('aftersales');
    const [catalog,stock,orders]=await Promise.all([
      canProducts?market.getManagementProducts():{products:[]},canProducts?market.getManagementInventory():{inventories:[]},
      canOrders||canAfter?market.listManagementOrders():{orders:[]}
    ]);
    const tabs=[canProducts&&'products',canOrders&&'orders',canAfter&&'after'].filter(Boolean);
    return {allowed,session,actorId:session.user.id,canProducts,canOrders,canAfter,tab:tabs.includes(this.data.tab)?this.data.tab:tabs[0],
      products:catalog.products.map(p=>productView(p,stock.inventories)),orders:orders.orders.map(row=>{const order=orderView(row);return {...order,canShip:canOrders&&order.canCancel,canResolve:canAfter&&row.afterSale?.status==='submitted'};}),selected:null};
  },
  chooseTab(e){this.setData({tab:e.currentTarget.dataset.tab,selected:null,error:''});},
  selectOrder(e){if(this._busy)return;const selected=this.data.orders.find(row=>row.id===e.currentTarget.dataset.id);if(selected)this.setData({selected,carrier:'模拟物流',tracking:'DEMO-'+Date.now(),reply:'已完成模拟处理，无真实退款或补发。',error:''},()=>wx.pageScrollTo?.({selector:'#order-management-panel',duration:250}));},
  field(e){const key=e.currentTarget.dataset.field;if(['carrier','tracking','reply'].includes(key))this.setData({[key]:e.detail.value});},
  closeOrder(){this.setData({selected:null});},
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
