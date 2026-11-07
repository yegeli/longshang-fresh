const {market,page,productView,toast}=require('../_shared');
const canPreview=session=>session&&session.user&&typeof session.user.id==='string'&&!!session.user.id&&session.canManage&&(session.role==='admin'||session.role==='merchant'&&(session.permissions||[]).includes('products'));
const validId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
page({
 data:{allowed:false,product:null,video:'',videoError:false},
 init(){wx.hideShareMenu?.({menus:['shareAppMessage','shareTimeline']});},
 async load(){
  this.setData({allowed:false,product:null,video:'',videoError:false});
  const session=await market.getSession();
  if(market.mode!=='cloud'||!canPreview(session))return {allowed:false};
  const id=this._query.id;if(!validId(id))throw Error('商品编号无效，请从商品编辑页重新进入。');
  const [saved,stock]=await Promise.all([market.getManagementProduct(id),market.getManagementInventory()]);
  const current=await market.getSession();
  if(!canPreview(current)||current.user.id!==session.user.id)return {allowed:false,product:null,video:''};
  const source=saved.product;
  if(!source||source.id!==id)throw Error('商品不存在或当前账户无权预览。');
  const product=productView(source,stock.inventories),video=market.videoFor(source);
  product.factRows=product.factRows.map((row,index)=>({...row,rowKey:'fact-'+index}));product.harvestSteps=(product.harvestSteps||[]).map((row,index)=>({...row,rowKey:'step-'+index}));
  return {allowed:true,product,video,imageError:false,videoUnavailable:!!source.videoMediaId&&!video,
   imageFallback:!!source.imageMediaId&&product.image===market.assetUrl(source.image),
   statusText:({published:'已上架',draft:'草稿 · 尚未上架',offline:'已下架'})[source.status]||'尚未上架',videoError:false};
 },
 onHide(){this._loadSeq++;this.setData({allowed:false,product:null,video:''});},
 previewImage(){const url=this.data.product&&this.data.product.image;if(url)wx.previewImage({current:url,urls:[url],fail:()=>toast('图片暂时无法打开，请稍后重试')});},
 videoFailed(){this.setData({videoError:true});},
 backToEdit(){
  const id=this._query.id,url=validId(id)?'/pages/manage-product/index?id='+encodeURIComponent(id):'/pages/workbench/index';
  const fallback=()=>wx.redirectTo?wx.redirectTo({url}):wx.navigateTo({url});
  const stack=typeof getCurrentPages==='function'?getCurrentPages():[],previous=stack[stack.length-2];
  if(wx.navigateBack&&previous&&previous.route==='pages/manage-product/index'&&previous.options?.id===id)wx.navigateBack({delta:1,fail:fallback});else fallback();
 },
 onShareAppMessage(){return {title:'家乡好物 · 模拟体验',path:'/pages/mine/index'};}
});
