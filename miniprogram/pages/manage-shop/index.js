const {market,page,confirm,toast}=require('../_shared');
const picker=require('../manage-product/media-picker');
const {scopeOf}=require('../workbench/model');
const canEdit=session=>!!scopeOf(session,market.mode)&&(session.role==='admin'||(session.permissions||[]).includes('products'));
const empty=()=>({allowed:false,shop:null,actorId:'',name:'',description:'',serviceNote:'',image:'assets/apples.jpg',imageMediaId:'',previewUrl:'',dirty:false,uploading:false,mediaRetry:false,refreshingImage:false});
const form=shop=>({shop,name:shop.name,description:shop.description||'',serviceNote:shop.serviceNote||'',image:shop.image,imageMediaId:shop.imageMediaId||'',previewUrl:market.imageFor(shop),dirty:false,imageError:false,mediaError:'',mediaStatus:''});
function validate(data){
 const shop={name:data.name.trim(),description:data.description.trim(),serviceNote:data.serviceNote.trim(),image:data.image,imageMediaId:data.imageMediaId};
 if(!shop.name||shop.name.length>60||shop.description.length>2000||shop.serviceNote.length>500)throw Error('请填写60字以内的店铺名称，介绍最多2000字，咨询说明最多500字。');
 return shop;
}
page({
 data:{...empty(),uploadPercent:-1,uploadPhase:'',mediaError:'',mediaStatus:'',refreshingImage:false},
 async load(){
  const seq=this._loadSeq,session=await market.getSession();
  if(!canEdit(session))return empty();
  const scope=scopeOf(session,market.mode),result=await market.getManagementShop(),latest=await market.getSession();
  if(!this._alive||seq!==this._loadSeq)return {};
  if(!canEdit(latest)||scopeOf(latest,market.mode)!==scope)return empty();
  if(!result.shop||!/^shop-[a-f0-9]{24}$/.test(result.shop.id))throw Error('店铺资料读取异常，请重新读取。');
  this._scope=scope;this._selectedImage=null;
  return {allowed:true,actorId:session.user.id,...form(result.shop)};
 },
 onShow(){this._visible=true;if(!this.data.shop||this.data.loading)return this.refresh();return this.verify().catch(error=>{if(this._alive)this.setData({error:error.message});});},
 onHide(){this._visible=false;this._loadSeq++;this._verifySeq=(this._verifySeq||0)+1;this._previewRun=null;this.setData({refreshingImage:false});if(!this._picking)this.cancelUpload();},
 onUnload(){this._alive=false;this._loadSeq++;this.cancelUpload();this._selectedImage=null;this._previewRun=null;},
 async verify(){
  const seq=this._verifySeq=(this._verifySeq||0)+1,actor=this.data.actorId,session=await market.getSession();
  if(!this._alive||seq!==this._verifySeq)return false;
  if(!canEdit(session)||session.user.id!==actor||scopeOf(session,market.mode)!==this._scope){this.cancelUpload();this._selectedImage=null;this.setData({...empty(),error:'账号或店铺权限已变化，请重新进入工作台。'});return false;}
  return true;
 },
 field(e){const field=e.currentTarget.dataset.field;if(this._busy||!['name','description','serviceNote'].includes(field))return;this.setData({[field]:e.detail.value,dirty:true});},
 async reload(){if(this._busy||this.data.uploading)return;if(this.data.dirty&&!await confirm('重新读取店铺资料？','本页未保存的文字和图片选择将被放弃。'))return;this._selectedImage=null;return this.refresh();},
 async onPullDownRefresh(){try{return await this.reload();}finally{wx.stopPullDownRefresh?.();}},
 save(){
  if(this.data.uploading||this._picking){toast('请先等待或取消图片上传');return;}
  const actorId=this.data.actorId,version=this.data.shop?.version;
  return this.act(async()=>{
   if(!this.data.shop||!await this.verify())throw Error('请先重新核对店铺管理权限。');
   const input=validate(this.data);if(!await confirm('保存店铺资料？','保存后，有在售商品的店铺会向买家展示这份介绍和图片。当前资料仍为模拟。'))return false;
   return market.saveManagementShop(input,version,actorId);
  },async result=>{if(result&&await this.verify()){this._selectedImage=null;this.setData(form(result.shop));toast('店铺资料已保存到云端');}});
 },
 async chooseImage(){
  if(this._busy||this._picking||this.data.uploading)return;const run={};this._picking=run;
  try{if(!await this.verify())return;const file=await picker.choose(wx,'image');if(!file||!this._alive)return;const selected=await picker.validate(wx,file,'image');if(!this._alive||!await this.verify())return;this._selectedImage=selected;this._picking=null;return await this.startUpload();}
  catch(error){if(this._alive)this.setData({mediaError:error.message||'未能读取图片，请重试。'});}
  finally{if(this._picking===run)this._picking=null;}
 },
 async startUpload(){
  if(this._busy||this.data.uploading||!this._selectedImage||!this.data.shop)return;
  const run={},selected=this._selectedImage,actor=this.data.actorId,shopId=this.data.shop.id;this._uploadRun=run;
  this.setData({uploading:true,uploadPercent:-1,uploadPhase:'preparing',mediaRetry:false,mediaError:'',mediaStatus:''});
  try{
   if(!await this.verify()||this._uploadRun!==run)return;
   run.task=market.uploadShopImage({...selected,shopId,expectedUserId:actor,source:'采购者上传的模拟店铺展示图片，非真实供货证明。',onProgress:value=>{if(this._alive&&this._uploadRun===run)this.setData({uploadPercent:value.progress,uploadPhase:value.phase});}});
   const result=await run.task.promise;if(!this._alive||this._uploadRun!==run||!await this.verify()||this._uploadRun!==run)return;
   this._selectedImage=null;this.setData({imageMediaId:result.mediaId,previewUrl:result.url,imageError:false,dirty:true,mediaStatus:'图片已上传，保存店铺资料后买家才能看到。'});
  }catch(error){if(this._alive&&this._uploadRun===run)this.setData({mediaRetry:true,mediaError:error.message||'上传未完成，可重试。'});}
  finally{if(this._uploadRun===run){this._uploadRun=null;if(this._alive)this.setData({uploading:false});}}
 },
 cancelUpload(){const run=this._uploadRun;if(!run)return;this._uploadRun=null;run.task?.abort();if(this._alive)this.setData({uploading:false,mediaRetry:!!this._selectedImage,mediaError:'',mediaStatus:'上传已暂停，已保存的店铺图片未改变。'});},
 retryUpload(){return this.startUpload();},
 useDefault(){if(this._busy||this.data.uploading)return;this._selectedImage=null;this._previewRun=null;this.setData({image:'assets/apples.jpg',imageMediaId:'',previewUrl:market.assetUrl('assets/apples.jpg'),refreshingImage:false,imageError:false,dirty:true,mediaRetry:false,mediaError:'',mediaStatus:'已选用默认示意图，保存后生效。'});},
 async refreshImage(){
  if(this._busy||this.data.uploading||this.data.refreshingImage||!this.data.imageMediaId)return;
  const run={},id=this.data.imageMediaId;this._previewRun=run;this.setData({refreshingImage:true,mediaError:''});
  try{if(!await this.verify()||this._previewRun!==run)return;const result=await market.getManagementMedia(id,this.data.actorId);const allowed=await this.verify();if(allowed&&this._alive&&this._previewRun===run&&id===this.data.imageMediaId)this.setData({previewUrl:result.url,imageError:false});}
  catch(error){if(this._alive&&this._previewRun===run)this.setData({mediaError:error.message||'图片暂不可用，请稍后重试。'});}
  finally{if(this._previewRun===run){this._previewRun=null;if(this._alive)this.setData({refreshingImage:false});}}
 },
 previewImage(){if(this.data.previewUrl)wx.previewImage({urls:[this.data.previewUrl],current:this.data.previewUrl});},
 async viewShop(){
  if(this._busy||this.data.uploading)return;
  if(this.data.dirty&&!await confirm('查看已保存的店铺？','未保存的文字和图片不会显示，当前填写会保留。'))return;
  return this.act(async()=>{if(!await this.verify())return false;const directory=await market.getStorefront();if(!directory.shops.some(s=>s.id===this.data.shop.id&&!s.preview))throw Error('店铺还没有上架商品，暂未对买家展示。');return this.data.shop.id;},id=>{if(id)wx.navigateTo({url:'/pages/shop/index?id='+encodeURIComponent(id)});});
 }
});
