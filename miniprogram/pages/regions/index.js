const {market,page,image}=require('../_shared');page({async load(){const data=await market.getStorefront();return {regions:data.regions.map(r=>({...r,image:image(r.image)}))};}});
