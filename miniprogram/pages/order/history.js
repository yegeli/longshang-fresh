const {dateTime}=require('../../services/display-time');
const valid=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const date=value=>dateTime(value,true)||'未记录具体时间';
const reasons={damaged:'商品或包装破损（模拟）',spec:'规格不符（模拟）',delivery:'配送问题（模拟）',other:'其他模拟问题'};
function orderHistory(order){
  const events=[],seen=new Set();
  const add=(id,title,at,detail)=>{if(seen.has(id))return;seen.add(id);events.push({id,title,time:date(at),at:valid(at)?Date.parse(at):null,detail:detail||'',sequence:events.length});};
  add('created','生成模拟订单',order.createdAt,'订单已保存，实际付款 ¥0.00。');
  if(order.fulfillment?.status==='shipped')add('shipped','商家已模拟发货',order.fulfillment.shippedAt,[order.fulfillment.carrier,order.fulfillment.tracking].filter(Boolean).join(' · '));
  if(order.receipt?.status==='received')add('received','买家已确认模拟收货',order.receipt.receivedAt,'仅记录模拟收货状态。');
  const snapshots=[...(Array.isArray(order.afterSaleHistory)?order.afterSaleHistory:[]),order.afterSale].filter(Boolean);
  for(const after of snapshots){
    if(!['submitted','withdrawn','resolved'].includes(after.status))continue;
    const key=after.id||after.createdAt||'legacy';
    add('after-'+key+'-submitted','申请模拟售后',after.createdAt,[(after.type==='replacement'?'模拟补发':'模拟退款'),reasons[after.reason]||'未分类的模拟问题',after.description].filter(Boolean).join(' · '));
    if(after.status==='withdrawn')add('after-'+key+'-withdrawn-'+(after.updatedAt||''),'买家撤回模拟售后',after.updatedAt,'申请已撤回，可重新申请。');
    if(after.status==='resolved')add('after-'+key+'-resolved-'+(after.updatedAt||''),'商家完成模拟售后',after.updatedAt,[after.merchantReply,'未执行真实退款或补发。'].filter(Boolean).join(' '));
  }
  const release=order.stockRelease||order.inventoryRelease;
  let cancellation='';
  if(order.status==='cancelled'){
    cancellation=release?.status==='released'?'该模拟订单已取消，占用的份数已回补原批次库存。':release?.status==='review'?'该模拟订单已取消，原批次无法安全回补，需采购者人工核对；不会自动补入当前批次。':'该模拟订单已取消。未记录可自动回补的原批次库存，需采购者核对。';
    add('cancelled','取消模拟订单',order.cancelledAt,cancellation);
  }
  events.sort((a,b)=>a.at===null?(b.at===null?a.sequence-b.sequence:1):b.at===null?-1:a.at-b.at||a.sequence-b.sequence);
  return {timeline:events.map(({at,sequence,...event})=>event),cancellation};
}
module.exports={orderHistory};
