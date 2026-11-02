const {market,page,confirm,toast}=require('../_shared');
const empty=()=>({id:'',userId:'',name:'',region:'',enabled:true,products:false,orders:false,aftersales:false,version:0});
page({
  data:{merchants:[],form:empty()},
  async load(){
    const session=await market.getSession();
    if(market.mode!=='cloud'||!session.user||session.role!=='admin')return {allowed:false,session,merchants:[],form:empty(),actorId:''};
    const {merchants}=await market.listWechatMerchants();
    return {allowed:true,session,actorId:session.user.id,merchants:merchants.map(row=>({...row,permissionText:(row.permissions||[]).map(key=>({products:'商品与库存',orders:'订单发货',aftersales:'售后处理'})[key]).join('、')||'未分配管理权限'})),form:empty()};
  },
  create(){this.setData({form:empty(),error:''});},
  edit(e){if(this._busy)return;const row=this.data.merchants.find(item=>item.id===e.currentTarget.dataset.id);if(row)this.setData({form:{id:row.id,userId:row.userId,name:row.name,region:row.region,enabled:row.status==='enabled',products:row.permissions.includes('products'),orders:row.permissions.includes('orders'),aftersales:row.permissions.includes('aftersales'),version:row.version},error:''},()=>wx.pageScrollTo?.({selector:'#merchant-management-panel',duration:250}));},
  field(e){const key=e.currentTarget.dataset.field;if(['userId','name','region'].includes(key)&&!(key==='userId'&&this.data.form.id))this.setData({form:{...this.data.form,[key]:e.detail.value}});},
  toggle(e){const key=e.currentTarget.dataset.field;if(['enabled','products','orders','aftersales'].includes(key))this.setData({form:{...this.data.form,[key]:!!e.detail.value}});},
  save(){
    const form={...this.data.form},actorId=this.data.actorId;
    return this.act(async()=>{
      if(!actorId)throw Error('请先重新核对管理员权限。');
      const input={userId:form.userId.trim(),name:form.name.trim(),region:form.region.trim(),status:form.enabled?'enabled':'disabled',permissions:['products','orders','aftersales'].filter(key=>form[key])};
      if(!/^wechat:[a-f0-9]{64}$/.test(input.userId))throw Error('请粘贴采购者在“我的”复制的完整云端账户编号。');
      if(!input.name||!input.region)throw Error('请填写采购者名称和地区。');
      if(form.id)input.expectedVersion=form.version;
      if(!await confirm(form.id?'保存采购者授权？':'绑定微信采购者？',input.name+' · '+input.region+'。请确认账户编号属于本人；'+(form.enabled?'权限仅限其自己的资料。':'停用后将禁止管理，其商品不再对买家展示。')))return false;
      await market.saveWechatMerchant(input,form.id,actorId);return true;
    },async saved=>{if(saved){await this.refresh();toast('采购者授权已保存');}});
  }
});
