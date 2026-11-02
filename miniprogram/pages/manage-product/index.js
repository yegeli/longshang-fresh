const {market,page,confirm,toast,money}=require('../_shared');
const model=require('../../services/generated/model');
const price=value=>{if(!/^\d{1,7}(?:\.\d{1,2})?$/.test(value.trim()))throw Error('价格请填写正数，最多两位小数。');const cents=Math.round(Number(value)*100);if(!Number.isSafeInteger(cents)||cents<=0)throw Error('价格需大于0。');return cents;};
const count=value=>{if(!/^\d{1,15}$/.test(String(value)))throw Error('库存请填写非负整数。');const result=Number(value);if(!Number.isSafeInteger(result)||result>999999)throw Error('库存须为0至999999的整数份。');return result;};
const KEYS=['id','name','category','status','image','origin','subtitle','tags','summary','storage','sizeNote','facts','harvestSteps','variants','video','videoTitle','videoNote','imageMediaId','videoMediaId','version'];
const newProduct=template=>({...model.normalizeCatalogProduct({...template,id:'demo-'+template.id+'-'+market.newRequestKey().replace(/[^a-f0-9]/gi,'').slice(-12).toLowerCase(),status:'draft'}),version:0});
function form(product,inventory){return {product,inventory,name:product.name,origin:product.origin,summary:product.summary,smallPrice:money(product.variants.find(row=>row.id==='small').price),familyPrice:money(product.variants.find(row=>row.id==='family').price),published:product.status==='published',smallStock:String(inventory.stocks.small),familyStock:String(inventory.stocks.family),batchCode:inventory.batchCode,harvestDate:inventory.harvestDate,note:inventory.note,reason:''};}
const blankStock=()=>({version:0,stocks:{small:0,family:0},batchCode:'',harvestDate:'',note:''});
page({
  data:{product:null,inventory:null},
  async load(){
    const session=await market.getSession();
    if(market.mode!=='cloud'||!session.user||!session.canManage||session.role!=='admin'&&!(session.permissions||[]).includes('products'))return {allowed:false,product:null,inventory:null,actorId:''};
    if(!this._query.id)return {allowed:true,actorId:session.user.id,isNew:true,templates:model.BASE_CATALOG.map(row=>({id:row.id,name:row.name})),...form(newProduct(model.BASE_CATALOG[0]),blankStock())};
    const [catalog,stock]=await Promise.all([market.getManagementProducts(),market.getManagementInventory()]);
    const product=catalog.products.find(row=>row.id===this._query.id);
    if(!product)throw Error('商品不存在或当前账户无权管理。');
    const inventory=stock.inventories.find(row=>row.productId===product.id)||{version:0,stocks:{small:0,family:0},batchCode:'',harvestDate:'',note:''};
    return {allowed:true,actorId:session.user.id,isNew:false,...form(product,inventory)};
  },
  field(e){const key=e.currentTarget.dataset.field;if(['name','origin','summary','smallPrice','familyPrice','smallStock','familyStock','batchCode','harvestDate','note','reason'].includes(key))this.setData({[key]:e.detail.value});},
  template(e){if(this._busy||!this.data.isNew)return;const template=model.BASE_CATALOG.find(row=>row.id===e.currentTarget.dataset.id);if(template)this.setData({...form(newProduct(template),blankStock()),error:''});},
  published(e){this.setData({published:!!e.detail.value});},
  saveProduct(){
    const actorId=this.data.actorId,source=this.data.product;
    return this.act(async()=>{
      if(!source||!actorId)throw Error('请先重新读取商品。');
      const product=Object.fromEntries(KEYS.filter(key=>source[key]!==undefined).map(key=>[key,source[key]]));
      product.name=this.data.name.trim();product.origin=this.data.origin.trim();product.summary=this.data.summary.trim();
      if(!product.name||!product.origin||!product.summary)throw Error('请填写商品名称、产地与介绍。');
      product.variants=source.variants.map(row=>({...row,price:price(this.data[row.id==='small'?'smallPrice':'familyPrice'])}));
      product.status=source.version===0?'draft':this.data.published?'published':'offline';
      if(!await confirm(source.version===0?'新增模拟商品草稿？':'保存商品资料？',product.name+'。新商品可售库存为0；已有订单快照不变。'))return false;
      return market.saveManagementProduct(product,source.version,actorId);
    },async saved=>{if(saved){this._query.id=saved.product.id;await this.refresh();toast('商品已保存到云端');}});
  },
  saveStock(){
    const actorId=this.data.actorId,product=this.data.product,inventory=this.data.inventory;
    return this.act(async()=>{
      if(!product||!inventory||!actorId||!product.version)throw Error('请先保存商品草稿，再配置库存。');
      const input={expectedVersion:inventory.version,stocks:{small:count(this.data.smallStock),family:count(this.data.familyStock)},batchCode:this.data.batchCode.trim(),harvestDate:this.data.harvestDate.trim(),note:this.data.note.trim(),reason:this.data.reason.trim()};
      if(!input.batchCode||!input.reason)throw Error('请填写批次编号和调整原因。');
      if(!await confirm('保存模拟库存？','数量是当前可售份数。更换批次后，旧批次取消订单可能需要人工核对。'))return false;
      await market.saveManagementInventory(product.id,input,actorId);return true;
    },async saved=>{if(saved){await this.refresh();toast('库存已保存到云端');}});
  }
});
