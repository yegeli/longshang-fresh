const { getMarket } = require('../services/market');
const market = getMarket();
const routes = ['home','regions','region','shops','shop','product','cart','checkout','orders','order','aftersale','mine','guide','workbench','manage-product','merchants','product-preview','records','support','conversation','manage-shop'];
const tabs = ['home','regions','cart','mine'];
const money = value => (Number(value || 0) / 100).toFixed(2);
const image = value => market.assetUrl(value || 'assets/apples.jpg');
const date = require('../services/display-time').dateTime;
function productView(product, inventories = []) {
 const stock = inventories.find(row => row.productId === product.id);
 return { ...product, image: market.imageFor(product), priceText: money(product.variants[0].price), stock: stock || { configured:false, stocks:{small:0,family:0} },
  factRows:(product.facts||[]).map(([label,value])=>({label,value})),
  variants:product.variants.map(v=>({...v, priceText:money(v.price),stock:stock?.stocks?.[v.id] || 0})) };
}
function orderView(order) {
 const after = order.afterSale;
 const status = order.status==='cancelled'?'已取消':after?.status==='resolved'&&after.type==='refund'?'模拟退款完成':after?.status==='submitted'?'售后处理中':order.receipt?.status==='received'?'已完成':order.fulfillment?.status==='shipped'?'待收货':'待发货';
 return { ...order, statusText:status,totalText:money(order.total),shippingText:money(order.shipping),createdText:date(order.createdAt),
  lines:(order.items || [order]).map((item,index)=>({...item,key:item.productId+'-'+item.variant+'-'+index,image:market.imageFor(item),priceText:money(item.unitPrice)})),
  canCancel:order.status==='created'&&!order.fulfillment&&!order.receipt&&after?.status!=='submitted'&&!(after?.status==='resolved'&&after.type==='refund'),
  canReceive:order.status==='created'&&order.fulfillment?.status==='shipped'&&!order.receipt&&after?.status!=='submitted'&&!(after?.status==='resolved'&&after.type==='refund'),
  canApply:order.status==='created'&&after?.status!=='submitted'&&!(after?.status==='resolved'&&after.type==='refund'),
  canMockShip:market.mode==='mock'&&order.status==='created'&&!order.fulfillment&&!order.receipt&&after?.status!=='submitted'&&!(after?.status==='resolved'&&after.type==='refund'),
  canMockResolve:market.mode==='mock'&&after?.status==='submitted', afterLabel:after?({submitted:'等待处理',resolved:'已模拟处理',withdrawn:'已撤回'})[after.status]:'',
  afterType:after?.type==='replacement'?'模拟补发':'模拟退款' };
}
function navigate(page,id) {
 if(!routes.includes(page)) return;
 const url='/pages/'+page+'/index'+(id?'?id='+encodeURIComponent(id):'');
 if(tabs.includes(page)) wx.switchTab({url:'/pages/'+page+'/index'}); else wx.navigateTo({url});
}
function confirm(title,content) { return new Promise(resolve=>wx.showModal({title,content,success:result=>resolve(!!result.confirm),fail:()=>resolve(false)})); }
function toast(title) { wx.showToast({title,icon:'none'}); }
function page(spec) {
 const definition = { data:{loading:true,error:'',processing:false,mode:market.mode,modeLabel:market.mode==='mock'?'本机模拟体验 · 不付款':'云端模拟体验 · 不付款',...spec.data},
  onLoad(query) { this._query=query || {};this._alive=true;this._loadSeq=0;if(spec.init)spec.init.call(this,this._query); },
  onShow() {return this.refresh();}, onUnload(){this._alive=false;this._loadSeq++;},
  async refresh(){const seq=++this._loadSeq;this.setData({loading:true,error:''});try{const next=await spec.load.call(this);if(this._alive&&seq===this._loadSeq)this.setData({...next,loading:false});}catch(error){if(this._alive&&seq===this._loadSeq)this.setData({error:error.message||'读取失败，请重试。',loading:false});}finally{wx.stopPullDownRefresh?.();}},
  onPullDownRefresh(){return this.refresh();},
  async act(operation,success){if(this._busy)return;this._busy=true;this.setData({processing:true,error:''});try{const result=await operation();if(!this._alive)return;if(success)await success(result);else await this.refresh();}catch(error){if(this._alive){this.setData({error:error.message||'操作未确认成功，请重新读取后核对。'});toast(error.message||'操作未确认成功');}}finally{this._busy=false;if(this._alive)this.setData({processing:false});}},
  go(event){const target=event.currentTarget.dataset;if(target.page==='records'&&['product','inventory','merchant'].includes(target.kind)){wx.navigateTo({url:'/pages/records/index?kind='+target.kind+'&id='+encodeURIComponent(target.id||'')});return;}if(target.page==='orders'&&['waiting','shipped','after'].includes(target.filter)){wx.navigateTo({url:'/pages/orders/index?filter='+target.filter});return;}navigate(target.page,target.id);},
  imageFailed(){this.setData({imageError:true});},
  openProduct(event){navigate('product',event.currentTarget.dataset.id);},
  ...Object.fromEntries(Object.entries(spec).filter(([key])=>!['data','load','init'].includes(key))) };
 Page(definition);return definition;
}
module.exports={market,page,money,image,date,productView,orderView,navigate,confirm,toast};
