function scopeOf(session,mode){
  if(mode!=='cloud'||!session?.user||!session.canManage||!['admin','merchant'].includes(session.role))return '';
  return session.user.id+'|'+session.role+'|'+[...(session.permissions||[])].sort().join(',');
}
const contains=(values,query)=>!query||values.filter(Boolean).join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
const low=row=>row.stock?.configured&&row.variants.some(v=>v.stock<=5);
const orderState=row=>row.status==='cancelled'?'cancelled':row.afterSale?.status==='resolved'&&row.afterSale.type==='refund'?'refunded':row.receipt?.status==='received'?'completed':row.fulfillment?.status==='shipped'?'shipped':'waiting';
function project(data){
  const products=data.canProducts?data.products:[],orders=data.canOrders||data.canAfter?data.orders:[];
  const counts={products:products.length,published:products.filter(p=>p.status==='published').length,low:products.filter(low).length,
    unconfigured:products.filter(p=>!p.stock?.configured).length,waiting:data.canOrders?orders.filter(row=>row.canCancel).length:0,
    shipped:data.canOrders?orders.filter(row=>row.canReceive).length:0,after:data.canAfter?orders.filter(o=>o.afterSale?.status==='submitted').length:0};
  const visibleProducts=products.filter(row=>contains([row.id,row.name,row.region,row.origin,row.category,row.summary],data.productQuery)&&
    (data.productFilter==='all'||data.productFilter==='low'&&low(row)||data.productFilter==='unconfigured'&&!row.stock?.configured||row.status===data.productFilter));
  const after=data.tab==='after',query=after?data.afterQuery:data.orderQuery,filter=after?data.afterFilter:data.orderFilter;
  const visibleOrders=orders.filter(row=>{
    if(after&&(!data.canAfter||!row.afterSale))return false;
    if(!after&&!data.canOrders)return false;
    return contains([row.id,row.product,...(row.lines||[]).map(l=>l.product),row.fulfillment?.tracking,row.afterSale?.reason,row.afterSale?.description],query)&&
      (filter==='all'||(after?row.afterSale?.status===filter:orderState(row)===filter));
  });
  return {visibleProducts,visibleOrders,counts};
}
module.exports={scopeOf,project};
