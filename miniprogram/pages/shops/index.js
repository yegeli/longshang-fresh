const {market,page,image}=require('../_shared');page({async load(){const data=await market.getStorefront();return {shops:data.shops.map(s=>({...s,image:market.imageFor(s)}))};}});
