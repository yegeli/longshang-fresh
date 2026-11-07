const {dateTime}=require('../../services/display-time');
const text=value=>typeof value==='string'?value:'';
const status=value=>({published:'已上架',draft:'草稿',offline:'已下架',enabled:'已启用',disabled:'已停用'})[value]||'未记录';
const money=value=>Number.isSafeInteger(value)?'¥'+(value/100).toFixed(2):'未记录';
const permission=value=>(Array.isArray(value)?value:[]).map(v=>({products:'商品与库存',orders:'订单发货',aftersales:'售后处理'})[v]).filter(Boolean).join('、')||'无管理权限';
const time=value=>dateTime(value,true)||'未记录具体时间';
function viewEvent(kind,event){
  const before=event.before||{},after=event.after||{},lines=[];
  const add=(label,first,last)=>{if(!event.before||first!==last)lines.push({label,before:event.before?String(first||'未填写'):'',after:String(last||'未填写')});};
  let title='操作记录',description='';
  if(kind==='product'){
    title=event.action==='created'?'创建商品':'更新商品';
    description=event.actorRole==='admin'?'平台管理员操作':event.actorRole==='merchant'?'采购者操作':'';
    add('商品名称',text(before.name),text(after.name));add('上架状态',status(before.status),status(after.status));
    for(const [id,label] of [['small','尝鲜装价格'],['family','家庭装价格']])add(label,money(before.prices?.[id]),money(after.prices?.[id]));
    if((before.imageMediaId||'')!==(after.imageMediaId||''))lines.push({label:'商品图片',before:'',after:after.imageMediaId?'已绑定新图片':'已移除云端图片'});
    if((before.videoMediaId||'')!==(after.videoMediaId||''))lines.push({label:'采摘视频',before:'',after:after.videoMediaId?'已绑定新视频':'已移除云端视频'});
    const labels={name:'名称',status:'状态',summary:'简介',subtitle:'副标题',storage:'保存方式',sizeNote:'大小与规格说明',tags:'标签',region:'产地',origin:'产地介绍',category:'分类',variants:'规格与价格',facts:'商品参数',detail:'详情',details:'详情',harvestSteps:'采摘说明',harvestTitle:'采摘标题',harvestNote:'采摘介绍',procurement:'采购者',procurementName:'采购者',procurementNote:'采购说明',description:'介绍',image:'封面',imageMediaId:'云端图片',video:'视频',videoMediaId:'云端视频',videoTitle:'视频标题',videoNote:'视频介绍'};
    const changed=(event.changedFields||[]).map(key=>labels[key]).filter(Boolean);
    if(changed.length)description+=(description?' · ':'')+'修改：'+[...new Set(changed)].join('、');
  }else if(kind==='inventory'){
    title=({initialized:'首次配置库存',adjusted:'调整库存',reserved:'模拟下单预留库存',released:'取消订单回补库存',release_review:'取消回库待人工核对'})[event.action]||'库存变更';
    description=text(event.reason);
    for(const [id,label] of [['small','尝鲜装可售库存'],['family','家庭装可售库存']])add(label,Number.isSafeInteger(before.stocks?.[id])?before.stocks[id]+' 份':'未记录',Number.isSafeInteger(after.stocks?.[id])?after.stocks[id]+' 份':'未记录');
    add('批次编号',text(before.batchCode),text(after.batchCode));add('采摘日期',text(before.harvestDate),text(after.harvestDate));add('批次说明',text(before.note),text(after.note));
  }else{
    title=event.action==='created'?'添加采购者授权':'变更采购者授权';
    add('采购者名称',text(before.name),text(after.name));add('负责地区',text(before.region),text(after.region));
    add('账号状态',status(before.status),status(after.status));add('管理权限',permission(before.permissions),permission(after.permissions));
  }
  return {id:event.id,title,time:time(event.createdAt),description,version:Number.isSafeInteger(event.version)?event.version:null,lines};
}
function eventPage(kind,result){
  if(!result||!Array.isArray(result.events)||result.nextCursor!=null&&typeof result.nextCursor!=='string')throw Error('操作记录格式无效，请重新读取。');
  const ids=new Set(),events=[];
  for(const event of result.events){if(!event||typeof event.id!=='string'||!event.id)throw Error('操作记录编号无效，请重新读取。');if(!ids.has(event.id)){ids.add(event.id);events.push(viewEvent(kind,event));}}
  return {events,nextCursor:result.nextCursor||null};
}
module.exports={eventPage};
