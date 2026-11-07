const {market,page,confirm,toast,money}=require('../_shared');
const model=require('../../services/generated/model');
const picker=require('./media-picker');
const editor=require('./product-form');
const count=value=>{if(!/^\d{1,15}$/.test(String(value)))throw Error('库存请填写非负整数。');const result=Number(value);if(!Number.isSafeInteger(result)||result>999999)throw Error('库存须为0至999999的整数份。');return result;};
const newProduct=template=>({...model.normalizeCatalogProduct({...template,id:'demo-'+template.id+'-'+market.newRequestKey().replace(/[^a-f0-9]/gi,'').slice(-12).toLowerCase(),status:'draft'}),version:0});
function form(product,inventory){return {product,inventory,...editor.toForm(product),hasProductChanges:false,smallPrice:money(product.variants.find(row=>row.id==='small').price),familyPrice:money(product.variants.find(row=>row.id==='family').price),published:product.status==='published',smallStock:String(inventory.stocks.small),familyStock:String(inventory.stocks.family),batchCode:inventory.batchCode,harvestDate:inventory.harvestDate,note:inventory.note,reason:'',mediaImageUrl:market.imageFor(product),mediaVideoUrl:market.videoFor(product),mediaDirty:false,mediaError:'',mediaStatus:'',mediaRetry:false};}
const blankStock=()=>({version:0,stocks:{small:0,family:0},batchCode:'',harvestDate:'',note:''});
const canEdit=session=>session&&session.user&&typeof session.user.id==='string'&&!!session.user.id&&session.canManage&&(session.role==='admin'||session.role==='merchant'&&(session.permissions||[]).includes('products'));
page({
  data:{product:null,inventory:null,uploading:false,uploadPercent:-1,uploadPhase:'',uploadKind:'',previewRefreshing:'',mediaDirty:false,mediaError:'',mediaStatus:'',mediaRetry:false},
  async load(){
    const session=await market.getSession();
    if(market.mode!=='cloud'||!canEdit(session))return {allowed:false,product:null,inventory:null,actorId:''};
    this._dirty=false;this._stockDirty=false;
    if(!this._query.id)return {allowed:true,actorId:session.user.id,isNew:true,templates:model.BASE_CATALOG.map(row=>({id:row.id,name:row.name})),...form(newProduct(model.BASE_CATALOG[0]),blankStock())};
    const [catalog,stock]=await Promise.all([market.getManagementProducts(),market.getManagementInventory()]);
    const current=await market.getSession();
    if(!canEdit(current)||current.user.id!==session.user.id)return {allowed:false,product:null,inventory:null,actorId:''};
    const product=catalog.products.find(row=>row.id===this._query.id);
    if(!product)throw Error('商品不存在或当前账户无权管理。');
    const inventory=stock.inventories.find(row=>row.productId===product.id)||{version:0,stocks:{small:0,family:0},batchCode:'',harvestDate:'',note:''};
    this._dirty=false;
    return {allowed:true,actorId:session.user.id,isNew:false,...form(product,inventory)};
  },
  onShow(){
    // Native media pickers can trigger onHide/onShow. Re-reading here would erase edited prices.
    if(!this.data.product||this.data.loading)return this.refresh();
    return this.verifyMediaAccess().catch(error=>{if(this._alive)this.setData({mediaError:error.message||'账号核验失败，请稍后重试。'});});
  },
  onHide(){if(!this._picking)this.cancelUpload();this._previewRun=null;if(this._alive)this.setData({previewRefreshing:''});},
  onUnload(){this._alive=false;this._loadSeq++;this.cancelUpload();this._previewRun=null;this._selectedMedia=null;},
  async reloadProduct(){
    if(this.data.uploading){toast('请先等待或取消上传');return;}
    if(this._dirty&&!await confirm('重新读取商品？','本页尚未保存的资料、价格和素材选择将被放弃。'))return;
    this._selectedMedia=null;this._dirty=false;return this.refresh();
  },
  async onPullDownRefresh(){try{return await this.reloadProduct();}finally{wx.stopPullDownRefresh?.();}},
  async verifyMediaAccess(){
    const actorId=this.data.actorId,session=await market.getSession();
    if(!this._alive)return false;
    if(!canEdit(session)||!actorId||session.user.id!==actorId){
      this.cancelUpload();this._selectedMedia=null;
      this.setData({allowed:false,mediaRetry:false,mediaError:'账号或商品权限已变化，请重新进入商家工作台。'});return false;
    }
    return true;
  },
  changed(stock=false){this._dirty=true;if(stock)this._stockDirty=true;else this.setData({hasProductChanges:true});},
  field(e){const key=e.currentTarget.dataset.field;if(this._busy)return;if([...editor.fields,...editor.stockFields].includes(key)){this.changed(editor.stockFields.includes(key));this.setData({[key]:e.detail.value});}},
  category(e){if(this._busy)return;const index=Number(e.detail.value),row=editor.categories[index];if(row){this.changed();this.setData({category:row.id,categoryIndex:index});}},
  rowField(e){
    if(this._busy)return;const {kind,key}=e.currentTarget.dataset,index=Number(e.currentTarget.dataset.index);
    if(!['facts','harvestSteps'].includes(kind)||!Number.isInteger(index)||index<0||!this.data[kind][index]||!(kind==='facts'?['label','value']:['title','text']).includes(key))return;
    const rows=this.data[kind].map((row,i)=>i===index?{...row,[key]:e.detail.value}:row);this.changed();this.setData({[kind]:rows});
  },
  addRow(e){
    if(this._busy)return;const kind=e.currentTarget.dataset.kind;if(!['facts','harvestSteps'].includes(kind))return;
    const max=kind==='facts'?20:12;if(this.data[kind].length>=max){toast('最多添加'+max+'条');return;}
    this._rowKey=(this._rowKey||0)+1;const rowKey=kind+'-'+this._rowKey,row=kind==='facts'?{rowKey,label:'',value:''}:{rowKey,title:'',text:''};
    this.changed();this.setData({[kind]:[...this.data[kind],row]});
  },
  removeRow(e){if(this._busy)return;const kind=e.currentTarget.dataset.kind,index=Number(e.currentTarget.dataset.index);if(!['facts','harvestSteps'].includes(kind)||!Number.isInteger(index)||index<0||index>=this.data[kind].length)return;this.changed();this.setData({[kind]:this.data[kind].filter((row,i)=>i!==index)});},
  async template(e){if(this._busy||!this.data.isNew)return;const template=model.BASE_CATALOG.find(row=>row.id===e.currentTarget.dataset.id);if(!template)return;if(this._dirty&&!await confirm('切换模拟模板？','本页未保存的商品和库存填写将被替换。'))return;this._dirty=false;this._stockDirty=false;this.setData({...form(newProduct(template),blankStock()),error:''});},
  published(e){if(this._busy)return;this.changed();this.setData({published:!!e.detail.value});},
  async previewSaved(){
    if(this._busy||this.data.uploading||this._picking||!this.data.product)return;if(!this.data.product.version){toast('请先保存商品草稿，再预览');return;}
    if(this.data.hasProductChanges&&!await confirm('预览已保存商品？','本页有未保存的资料、价格或素材，预览只显示上一次保存的版本；本页修改会保留。'))return;
    if(await this.verifyMediaAccess())wx.navigateTo({url:'/pages/product-preview/index?id='+encodeURIComponent(this.data.product.id)});
  },
  async records(e){const kind=e.currentTarget.dataset.kind;if(this._busy||this.data.uploading||this._picking||!['product','inventory'].includes(kind)||!this.data.product?.version)return;if(await this.verifyMediaAccess())wx.navigateTo({url:'/pages/records/index?kind='+kind+'&id='+encodeURIComponent(this.data.product.id)});},
  async chooseMedia(e){
    const kind=e.currentTarget.dataset.kind;
    if(!['image','video'].includes(kind)||this._busy||this.data.uploading||this._picking)return;
    if(!this.data.product||!this.data.product.version){toast('请先保存商品草稿，再上传素材');return;}
    const picking={};this._picking=picking;
    try{
      if(!await this.verifyMediaAccess())return;
      const file=await picker.choose(wx,kind);
      if(!file||!this._alive)return;
      const selected=await picker.validate(wx,file,kind);
      if(!this._alive||!await this.verifyMediaAccess())return;
      this._selectedMedia={...selected,kind};
      this._picking=false;
      return await this.startMediaUpload();
    }catch(error){if(this._alive)this.setData({mediaError:error.message||'文件读取失败，请重新选择。'});}
    finally{if(this._picking===picking)this._picking=false;}
  },
  async startMediaUpload(){
    if(this.data.uploading||!this._selectedMedia||this._busy)return;
    const selected=this._selectedMedia,actorId=this.data.actorId,productId=this.data.product.id;
    const run={};this._mediaRun=run;
    this.setData({uploading:true,uploadKind:selected.kind,uploadPercent:-1,uploadPhase:'preparing',mediaError:'',mediaRetry:false,mediaStatus:''});
    try{
      if(!await this.verifyMediaAccess()||this._mediaRun!==run)return;
      run.task=market.uploadProductMedia({...selected,productId,expectedUserId:actorId,onProgress:value=>{
        if(!this._alive||this._mediaRun!==run)return;
        const percent=Number(typeof value==='object'?value.progress:value);
        if(Number.isFinite(percent))this.setData({uploadPercent:Math.max(0,Math.min(100,Math.round(percent))),uploadPhase:value&&value.phase==='verifying'?'verifying':'uploading'});
      }});
      const uploaded=await run.task.promise;
      if(!this._alive||this._mediaRun!==run||!await this.verifyMediaAccess()||this._mediaRun!==run)return;
      const kind=selected.kind,product={...this.data.product,[kind==='image'?'imageMediaId':'videoMediaId']:uploaded.mediaId};
      this.changed();this._selectedMedia=null;
      this.setData({product,[kind==='image'?'mediaImageUrl':'mediaVideoUrl']:uploaded.url,mediaDirty:true,mediaRetry:false,mediaStatus:'已上传到云端，保存商品后买家才会看到。'});
    }catch(error){
      if(this._alive&&this._mediaRun===run)this.setData({mediaError:error.message||'上传未完成，请重试。',mediaRetry:true});
    }finally{
      if(this._mediaRun===run){this._mediaRun=null;if(this._alive)this.setData({uploading:false});}
    }
  },
  cancelUpload(){
    const run=this._mediaRun;if(!run)return;
    this._mediaRun=null;if(run.task)run.task.abort();
    if(this._alive)this.setData({uploading:false,mediaRetry:!!this._selectedMedia,mediaError:'',mediaStatus:'已取消上传，商品原素材未更改。'});
  },
  retryUpload(){return this.startMediaUpload();},
  restoreImage(){
    if(this.data.uploading||this._busy)return;
    this.changed();this._selectedMedia=null;
    this.setData({product:{...this.data.product,imageMediaId:''},mediaImageUrl:market.assetUrl(this.data.product.image),mediaDirty:true,mediaError:'',mediaRetry:false,mediaStatus:'已选用默认示意图片，保存商品后生效。'});
  },
  removeVideo(){
    if(this.data.uploading||this._busy)return;
    this.changed();this._selectedMedia=null;
    this.setData({product:{...this.data.product,videoMediaId:'',video:''},mediaVideoUrl:'',mediaDirty:true,mediaError:'',mediaRetry:false,mediaStatus:'已移除本页视频选择，保存商品后生效。'});
  },
  previewMediaImage(){if(this.data.mediaImageUrl)wx.previewImage({current:this.data.mediaImageUrl,urls:[this.data.mediaImageUrl]});},
  mediaFailed(){this.setData({mediaError:'素材暂时无法预览。请检查网络，再点对应的“刷新预览”，本页未保存的价格和素材会保留。'});},
  async refreshMediaPreview(e){
    const kind=e.currentTarget.dataset.kind;
    if(!['image','video'].includes(kind)||this.data.previewRefreshing||this.data.uploading||this._busy)return;
    const field=kind==='image'?'imageMediaId':'videoMediaId',mediaId=this.data.product&&this.data.product[field],actorId=this.data.actorId;
    if(!mediaId)return;
    const run={};this._previewRun=run;this.setData({previewRefreshing:kind,mediaError:''});
    try{
      if(!await this.verifyMediaAccess()||this._previewRun!==run)return;
      const result=await market.getManagementMedia(mediaId,actorId);
      if(!this._alive||this._previewRun!==run||this.data.product[field]!==mediaId||!await this.verifyMediaAccess()||this._previewRun!==run)return;
      this.setData({[kind==='image'?'mediaImageUrl':'mediaVideoUrl']:result.url});
    }catch(error){if(this._alive&&this._previewRun===run)this.setData({mediaError:error.message||'预览刷新失败，请稍后重试。'});}
    finally{if(this._previewRun===run){this._previewRun=null;if(this._alive)this.setData({previewRefreshing:''});}}
  },
  saveProduct(){
    if(this.data.uploading||this._picking){toast('请先等待或取消素材上传');return;}
    const actorId=this.data.actorId,source=this.data.product;
    return this.act(async()=>{
      if(!source||!actorId)throw Error('请先重新读取商品。');
      const product=editor.toProduct(source,this.data);
      if(!await confirm(source.version===0?'新增模拟商品草稿？':'保存商品资料？',product.name+'。新商品可售库存为0；已有订单快照不变。'))return false;
      return market.saveManagementProduct(product,source.version,actorId);
    },async saved=>{if(saved){
      const pendingStock=this._stockDirty?{...Object.fromEntries(editor.stockFields.map(key=>[key,this.data[key]])),inventory:this.data.inventory}:null;
      this._query.id=saved.product.id;this._dirty=false;this._selectedMedia=null;await this.refresh();
      if(pendingStock&&this.data.allowed){this.setData(pendingStock);this._stockDirty=true;this._dirty=true;}
      toast('商品已保存到云端');
    }});
  },
  saveStock(){
    if(this.data.uploading||this._picking){toast('请先等待或取消素材上传');return;}
    const actorId=this.data.actorId,product=this.data.product,inventory=this.data.inventory;
    return this.act(async()=>{
      if(!product||!inventory||!actorId||!product.version)throw Error('请先保存商品草稿，再配置库存。');
      const input={expectedVersion:inventory.version,stocks:{small:count(this.data.smallStock),family:count(this.data.familyStock)},batchCode:this.data.batchCode.trim(),harvestDate:this.data.harvestDate.trim(),note:this.data.note.trim(),reason:this.data.reason.trim()};
      if(!input.batchCode||!input.reason)throw Error('请填写批次编号和调整原因。');
      if(!await confirm('保存模拟库存？','数量是当前可售份数。更换批次后，旧批次取消订单可能需要人工核对。'))return false;
      return market.saveManagementInventory(product.id,input,actorId);
    },async saved=>{if(saved){const inventory=saved.inventory;this.setData({inventory,smallStock:String(inventory.stocks.small),familyStock:String(inventory.stocks.family),batchCode:inventory.batchCode,harvestDate:inventory.harvestDate,note:inventory.note,reason:''});this._stockDirty=false;this._dirty=!!this.data.hasProductChanges;toast('库存已保存到云端');}});
  }
});
