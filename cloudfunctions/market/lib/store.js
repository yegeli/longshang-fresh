'use strict';
const { createHash } = require('node:crypto');
const COLLECTIONS = Object.freeze({ users:'lsf_users', sessions:'lsf_sessions', products:'lsf_products', inventory:'lsf_inventory', orders:'lsf_orders', requests:'lsf_order_requests', shopping:'lsf_shopping', consumptions:'lsf_order_consumptions', merchants:'lsf_merchants', merchantIds:'lsf_merchant_ids', merchantAudit:'lsf_merchant_audit', inventoryEvents:'lsf_inventory_events', meta:'lsf_meta' });
const digest = value => createHash('sha256').update(value).digest('hex');
const key = value => digest(String(value)).slice(0,32);
class MarketError extends Error { constructor(status,code,message) { super(message); Object.assign(this,{status,code}); } }
const fail = (status,code,message) => { throw new MarketError(status,code,message); };
class Documents {
  constructor(db,inTransaction=false) { this.db=db; this.inTransaction=inTransaction; this.operations=0; }
  doc(collection,id) { if (!COLLECTIONS[collection]) throw new Error('Unknown collection'); if (++this.operations>90 && this.inTransaction) fail(422,'transaction_limit','本次操作超出事务范围，请减少商品数量。'); return this.db.collection(COLLECTIONS[collection]).doc(key(id)); }
  async get(collection,id) { const result=await this.doc(collection,id).get(); const value=Array.isArray(result.data)?result.data[0]:result.data; if(!value)return null; const {_id,...data}=value; return data; }
  async set(collection,id,data) { const clean={...data}; delete clean._id; await this.doc(collection,id).set({data:clean}); }
  async list(collection,filter={}, {limit=100,cursor,order='sortKey'}={}) { if(this.inTransaction)throw new Error('Transactions only support doc access'); let query=this.db.collection(COLLECTIONS[collection]); const conditions={...filter,...(cursor?{[order]:this.db.command.lt(cursor)}:{})}; if(Object.keys(conditions).length)query=query.where(conditions); const result=await query.orderBy(order,'desc').limit(limit).get(); return (result.data||[]).map(({_id,...data})=>data); }
}
class CloudbaseStore extends Documents {
  async transaction(action) {
    // Use explicit SDK transactions: the bundled SDK runTransaction implementation
    // retries business errors and discards callback values. No outside I/O occurs
    // in this callback; transient commits may safely be retried via stored keys.
    for(let attempt=0;attempt<3;attempt++) {
      let transaction;
      try { transaction=await this.db.startTransaction(); const result=await action(new Documents(transaction,true)); await transaction.commit(); return result; }
      catch(error) { if(transaction)await transaction.rollback().catch(()=>{}); if(error instanceof MarketError || attempt===2)throw error; }
    }
  }
}
module.exports={COLLECTIONS,digest,key,MarketError,fail,CloudbaseStore};
