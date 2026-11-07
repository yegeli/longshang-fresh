'use strict';
const {randomUUID,randomBytes}=require('node:crypto');
const {digest,fail,MarketError}=require('./store');
const C=require('./common');
const ID=/^CLOUD-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;
const KEY=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const TYPES={image:new Set(['image/jpeg','image/png','image/webp']),video:new Set(['video/mp4'])};
const LIMITS={image:5*1024*1024,video:20*1024*1024};
const MEDIA_TTL=15*60*1000,URL_AGE=300,CHUNK_SIZE=256*1024;
const mediaKey=id=>'media:'+id;
function validateBytes(bytes,type,size) {
 if(!Buffer.isBuffer(bytes)||bytes.length!==size)fail(422,'media_size_mismatch','上传文件的实际长度与声明不一致，请重新选择。');
 const ascii=(a,b)=>bytes.toString('ascii',a,b);let valid=false;
 if(type==='image/png')valid=bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.readUInt32BE(8)===13&&ascii(12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0&&ascii(bytes.length-8,bytes.length-4)==='IEND';
 if(type==='image/jpeg')valid=bytes.length>=12&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217;
 if(type==='image/webp')valid=bytes.length>=20&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(ascii(12,16))&&bytes.readUInt32LE(4)+8===bytes.length;
 if(type==='video/mp4') {
  // Bound every top-level ISO BMFF box, not merely the user-supplied MIME.
  // Movie and media-data boxes must both exist; HEIF/QuickTime are rejected.
  let pos=0,ftyp=false,moov=false,mdat=false;
  while(pos+8<=bytes.length){let length=bytes.readUInt32BE(pos),header=8;const box=ascii(pos+4,pos+8);if(length===1){if(pos+16>bytes.length)break;const big=bytes.readBigUInt64BE(pos+8);if(big>BigInt(bytes.length))break;length=Number(big);header=16;}if(length===0)length=bytes.length-pos;if(length<header||pos+length>bytes.length)break;if(pos===0&&box==='ftyp'&&length>=16)ftyp=['isom','iso2','iso5','iso6','mp41','mp42','avc1','M4V ','dash'].includes(ascii(pos+8,pos+12));if(box==='moov'&&length>header)moov=true;if(box==='mdat'&&length>header)mdat=true;pos+=length;}
  valid=pos===bytes.length&&ftyp&&moov&&mdat;
 }
 if(!valid)fail(415,'media_type_invalid','文件内容不是支持的图片或MP4视频，请重新选择。');
}
function createMedia({store,auth,now,env,storage}) {
 async function ready(docs=store) {
  if(!storage)fail(503,'media_unconfigured','云素材存储尚未配置。');
  // Only the controlled inspector writes this proof; shared bucket rules never
  // change here. PRIVATE is approved for non-sensitive product display objects
  // written only by the server, not for confidential documents. Knowing a raw
  // CloudBase file ID may allow another native client to obtain a download URL;
  // these routes enforce application-level owner/published-binding access only.
  const proof=await docs.get('meta','media-storage-ready'),age=Date.parse(now())-Date.parse(proof?.verifiedAt);
  if(!proof||proof.id!=='media-storage-ready'||proof.ready!==true||proof.appId!==env.WECHAT_APP_ID||proof.envId!==env.CLOUDBASE_ENV_ID||!['ADMINONLY','PRIVATE'].includes(proof.acl)||proof.mediaPolicy!=='server-owned-display-v1'||!Number.isFinite(age)||age<0||age>7*24*60*60*1000)fail(503,'media_storage_unverified','请管理员先核验商品展示素材的服务端写入策略；未修改共享存储规则。');
 }
 function own(row,user){if(!row||user.role!=='admin'&&row.ownerId!==user.id)fail(404,'not_found','素材不存在或当前账号无权访问。');return row;}
 async function authorized(docs,event,caller,write=false){const user=await auth.identity(docs,event,caller,true,write);C.requirePermission(user,'products');return user;}
 async function owned(docs,id,user){const row=own(await docs.get('meta',mediaKey(id)),user);C.ownProduct(await docs.get('products',row.productId),user);return row;}
 async function issue(ctx) {
  const {body,event,caller}=ctx;C.V.fields(body,['productId','kind','contentType','size','source','idempotencyKey']);
  if(!C.V.PRODUCT_ID.test(body.productId)||!TYPES[body.kind]?.has(body.contentType)||!Number.isSafeInteger(body.size)||body.size<1)fail(400,'media_invalid','请提供有效商品、文件类型和大小。');
  if(body.size>LIMITS[body.kind])fail(413,'media_too_large',body.kind==='image'?'图片最大5MiB。':'视频最大20MiB。');
  const source=C.V.text(body,'source',200,true);if(!KEY.test(body.idempotencyKey||''))fail(400,'idempotency_invalid','上传提交编号无效。');
  const time=now(),ms=Date.parse(time),id='CLOUD-'+randomUUID().toUpperCase(),fingerprint=digest(JSON.stringify({productId:body.productId,kind:body.kind,contentType:body.contentType,size:body.size,source}));
  const row=await store.transaction(async tx=>{const user=await authorized(tx,event,caller,true),product=C.ownProduct(await tx.get('products',body.productId),user),requestKey='media-request:'+digest(user.id+'\0'+body.idempotencyKey),previous=await tx.get('meta',requestKey);
   if(previous){if(previous.fingerprint!==fingerprint)fail(409,'idempotency_conflict','上传编号已用于其他素材，请重新选择。');const existing=await owned(tx,previous.mediaId,user);if(existing.state==='ready')return existing;if(Date.parse(existing.expiresAt)<=ms||existing.state==='failed')fail(409,'media_upload_expired','此上传已失效，请重新选择素材。');return existing;}
   const rateKey='media-rate:'+user.id,rate=await tx.get('meta',rateKey),hour=Math.floor(ms/3600000),day=Math.floor(ms/86400000),hourCount=rate?.hour===hour?rate.hourCount+1:1,dayCount=rate?.day===day?rate.dayCount+1:1;if(hourCount>20||dayCount>100)fail(429,'media_rate_limited','本账号上传次数达到当前演示限额，请稍后再试。');
   const value={id,ownerId:product.ownerId,uploadedBy:user.id,productId:product.id,kind:body.kind,contentType:body.contentType,size:body.size,source,state:'pending',everBound:false,createdAt:time,expiresAt:new Date(ms+MEDIA_TTL).toISOString(),chunks:{},attempts:0};await tx.set('meta',mediaKey(id),value);await tx.set('meta',requestKey,{mediaId:id,fingerprint});await tx.set('meta',rateKey,{hour,day,hourCount,dayCount});return value;
  });
  if(row.state==='ready')return dto(row);
  return {mediaId:row.id,state:'pending',kind:row.kind,chunkSize:CHUNK_SIZE,chunkCount:Math.ceil(row.size/CHUNK_SIZE),uploadedChunks:Object.keys(row.chunks).map(Number),expiresAt:row.expiresAt};
 }
 async function chunk(ctx,id) {
  const {body,event,caller}=ctx;C.V.fields(body,['index','data']);if(!Number.isSafeInteger(body.index)||body.index<0||body.index>=80||typeof body.data!=='string'||body.data.length>349528||!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).test(body.data))fail(400,'media_chunk_invalid','上传分块格式无效。');
  const bytes=Buffer.from(body.data,'base64');if(bytes.toString('base64')!==body.data)fail(400,'media_chunk_invalid','上传分块编码无效。');const hash=digest(bytes),user=await authorized(store,event,caller),row=await owned(store,id,user),expected=Math.min(CHUNK_SIZE,row.size-body.index*CHUNK_SIZE);
  if(row.state!=='pending'||Date.parse(row.expiresAt)<=Date.parse(now()))fail(409,'media_upload_expired','上传已失效或正在校验，请重新读取。');if(expected<1||bytes.length!==expected)fail(422,'media_chunk_size','上传分块长度无效。');if(row.chunks[body.index]){if(row.chunks[body.index].sha256!==hash)fail(409,'media_chunk_conflict','同一分块内容已变化，请重新选择文件。');return {mediaId:id,index:body.index,uploaded:true,replayed:true};}
  const fileId=await storage.write('lsf-media/chunks/'+digest(row.ownerId).slice(0,24)+'/'+id+'/'+body.index+'-'+randomBytes(16).toString('hex'),bytes);
  try{return await store.transaction(async tx=>{const currentUser=await authorized(tx,event,caller,true),current=await owned(tx,id,currentUser);if(current.state!=='pending'||Date.parse(current.expiresAt)<=Date.parse(now()))fail(409,'media_upload_expired','上传已失效或正在校验。');const previous=current.chunks[body.index];if(previous){if(previous.sha256!==hash)fail(409,'media_chunk_conflict','同一分块内容已变化，请重新选择文件。');return {mediaId:id,index:body.index,uploaded:true,replayed:true};}await tx.set('meta',mediaKey(id),{...current,chunks:{...current.chunks,[body.index]:{fileId,sha256:hash}}});return {mediaId:id,index:body.index,uploaded:true,replayed:false};});}
  finally{const saved=await store.get('meta',mediaKey(id));if(saved?.chunks?.[body.index]?.fileId!==fileId)await storage.remove(fileId).catch(()=>{});}
 }
 async function dto(row){const urls=await storage.urls([row.fileId],URL_AGE);return {mediaId:row.id,state:'ready',kind:row.kind,size:row.size,contentType:row.contentType,source:row.source,url:urls[row.fileId],expiresAt:new Date(Date.parse(now())+URL_AGE*1000).toISOString()};}
 async function cleanupRecorded(id) {
  const row=await store.get('meta',mediaKey(id)),pending=row?.storageCleanup?.pending||[];if(!pending.length)return {finalDeleted:!row?.fileId,cleanupPending:false,cleanupStatusCodes:[]};
  let report;try{report=await storage.removeMany(pending)||{deleted:pending,failed:[]};}catch(error){report=error.deleteReport||{deleted:[],failed:pending.map(fileId=>({fileId,status:null}))};}
  const removed=new Set(report.deleted);
  return store.transaction(async tx=>{const current=await tx.get('meta',mediaKey(id));if(!current)return {finalDeleted:false,cleanupPending:true,cleanupStatusCodes:[]};const cleanup=current.storageCleanup;if(!cleanup)return {finalDeleted:!current.fileId,cleanupPending:false,cleanupStatusCodes:[]};const left=cleanup.pending.filter(fileId=>!removed.has(fileId)),pendingSet=new Set(left),statusCodes=[...new Set(report.failed.filter(file=>pendingSet.has(file.fileId)).map(file=>file.status).filter(Number.isInteger))],next={...current,storageCleanup:{...cleanup,pending:left,lastAttemptAt:now(),statusCodes,deletedCount:(cleanup.deletedCount||0)+cleanup.pending.length-left.length}};if(current.state==='failed'&&removed.has(current.fileId))delete next.fileId;await tx.set('meta',mediaKey(id),next);return {finalDeleted:!next.fileId,cleanupPending:left.length>0,cleanupStatusCodes:statusCodes};});
 }
 async function complete(ctx,id) {
  const {event,caller}=ctx;C.V.fields(ctx.body,[]);const lease=randomBytes(16).toString('hex'),ms=Date.parse(now());
  const row=await store.transaction(async tx=>{const user=await authorized(tx,event,caller,true),current=await owned(tx,id,user);if(current.state==='ready')return current;if(current.state==='failed'||Date.parse(current.expiresAt)<=ms)fail(409,'media_upload_expired','此上传已失效，请重新选择。');if(current.state==='verifying'&&Date.parse(current.leaseUntil)>ms)fail(409,'media_processing','素材正在校验，请稍后重试。');if(Object.keys(current.chunks).length!==Math.ceil(current.size/CHUNK_SIZE))fail(409,'media_upload_incomplete','文件尚未上传完整，请继续上传剩余分块。');if(current.attempts>=3)fail(429,'media_retry_limit','素材校验重试次数已用完，请重新选择。');const next={...current,state:'verifying',lease,leaseUntil:new Date(ms+90000).toISOString(),attempts:current.attempts+1};await tx.set('meta',mediaKey(id),next);return next;});
  if(row.state==='ready')return dto(row);
  let finalFile;
  try {
   const parts=await storage.readChunks(Array.from({length:Math.ceil(row.size/CHUNK_SIZE)},(_,i)=>({fileId:row.chunks[i].fileId,size:Math.min(CHUNK_SIZE,row.size-i*CHUNK_SIZE)})));if(parts.some((part,i)=>digest(part)!==row.chunks[i].sha256))fail(422,'media_hash_mismatch','云端分块校验不一致，请重新上传。');const bytes=Buffer.concat(parts);validateBytes(bytes,row.contentType,row.size);
   // Never return an upload signature for the final key. Each attempt gets a
   // different immutable object; retries cannot overwrite a published file.
   const finalPath='lsf-media/final/'+digest(row.ownerId).slice(0,24)+'/'+id+'/'+randomBytes(24).toString('hex')+({"image/jpeg":'.jpg',"image/png":'.png',"image/webp":'.webp',"video/mp4":'.mp4'}[row.contentType]);finalFile=await storage.write(finalPath,bytes);
   const saved=await store.transaction(async tx=>{const user=await authorized(tx,event,caller,true),current=await owned(tx,id,user);if(current.state!=='verifying'||current.lease!==lease)fail(409,'media_processing','上传状态已变化，请重新读取。');const value={...current,state:'ready',fileId:finalFile,sha256:digest(bytes),completedAt:now(),chunks:{},storageCleanup:{pending:Object.values(current.chunks).map(c=>c.fileId),deletedCount:0,statusCodes:[]}};delete value.lease;delete value.leaseUntil;await tx.set('meta',mediaKey(id),value);return value;});
   await cleanupRecorded(id);return dto(saved);
  } catch(error) {
   const saved=await store.get('meta',mediaKey(id));
   if(finalFile&&saved?.fileId!==finalFile)await storage.remove(finalFile).catch(()=>{});
   if(saved?.state==='verifying'&&saved.lease===lease)await store.transaction(async tx=>{const current=await tx.get('meta',mediaKey(id));if(current?.state!=='verifying'||current.lease!==lease)return;const next={...current,state:error instanceof MarketError&&[413,415,422].includes(error.status)?'failed':'pending'};delete next.lease;delete next.leaseUntil;await tx.set('meta',mediaKey(id),next);});
   throw error;
  }
 }
 async function cancel(ctx,id) {
  C.V.fields(ctx.body,[]);await store.transaction(async tx=>{const user=await authorized(tx,ctx.event,ctx.caller,true),current=await owned(tx,id,user);if(current.state==='ready'&&current.everBound!==false)fail(409,'media_already_bound','素材已用于商品或缺少安全删除记录，请保留历史订单图片。');if(current.everBound===true)fail(409,'media_already_bound','素材曾用于商品，请保留历史订单图片。');if(current.state==='verifying')fail(409,'media_processing','素材正在校验，请稍后重试。');
   // Final comes first. Old completed records may still list already-deleted
   // chunks; their failure must never prevent attempting the large final file.
   const pending=[...new Set([...(current.fileId?[current.fileId]:[]),...(current.storageCleanup?.pending||[]),...Object.values(current.chunks).map(c=>c.fileId)])];await tx.set('meta',mediaKey(id),{...current,state:'failed',cancelledAt:now(),chunks:{},storageCleanup:{pending,deletedCount:current.storageCleanup?.deletedCount||0,statusCodes:[]}});
  });return {mediaId:id,cancelled:true,...await cleanupRecorded(id)};
 }
 async function bind(docs,product,ownerId) {
  if(product.imageMediaId||product.videoMediaId)await ready(docs);
  for(const [field,kind] of [['imageMediaId','image'],['videoMediaId','video']])if(product[field]){const row=await docs.get('meta',mediaKey(product[field]));if(!row||row.state!=='ready'||row.kind!==kind||row.ownerId!==ownerId||row.productId!==product.id)fail(403,'media_binding_invalid','请使用此商品所属采购者已上传并校验完成的素材。');
   // Cancel and first binding must write the same media document under actual
   // snapshot isolation. Only explicitly new and never-bound objects are
   // deletable; missing historical state is deliberately treated as retained.
   if(row.everBound!==true)await docs.set('meta',mediaKey(row.id),{...row,everBound:true});
  }
 }
 async function productDTOs(rows) {
  const fallback=rows.map(row=>{const value=C.productDTO(row);if(value.imageMediaId||value.videoMediaId)value.mediaUnavailable=true;return value;});
  if(!rows.some(r=>r.product.imageMediaId||r.product.videoMediaId))return fallback;
  // A private-storage outage must not hide otherwise valid product prices or
  // inventory. It never yields raw file IDs or broadens private read access.
  try {
   await ready();const values=[],files=[];
   for(const row of rows){const value=C.productDTO(row);for(const [field,urlField,kind] of [['imageMediaId','imageUrl','image'],['videoMediaId','videoUrl','video']])if(value[field]){const media=await store.get('meta',mediaKey(value[field]));if(media?.state==='ready'&&media.ownerId===row.ownerId&&media.productId===row.id&&media.kind===kind){files.push(media.fileId);value[urlField]=media.fileId;}else value.mediaUnavailable=true;}values.push(value);}
   const urls=await storage.urls([...new Set(files)],URL_AGE);for(const value of values){for(const field of ['imageUrl','videoUrl'])if(value[field])value[field]=urls[value[field]];value.mediaExpiresAt=new Date(Date.parse(now())+URL_AGE*1000).toISOString();if(value.imageUrl)value.imageExpiresAt=value.mediaExpiresAt;if(value.videoUrl)value.videoExpiresAt=value.mediaExpiresAt;}return values;
  }catch{return fallback;}
 }
 async function handle(ctx) {
  const {path,method,event,caller}=ctx;
  const request=path==='/admin/media/uploads',match=/^\/(admin\/)?media\/([^/]+)(?:\/(complete|chunks|cancel))?$/.exec(path),orderMatch=/^\/(admin\/)?orders\/([^/]+)\/media\/([^/]+)$/.exec(path);
  if(!request&&!match&&!orderMatch)return null;await ready();
  if(request){C.requireMethod(method,'POST');return issue(ctx);}
  if(orderMatch){C.requireMethod(method,'GET');const [,admin,orderId,id]=orderMatch;if(!C.V.ORDER_ID.test(orderId)||!ID.test(id))fail(404,'not_found','素材不存在。');const user=await auth.identity(store,event,caller),order=C.ownOrder(await store.get('orders',orderId),user,!!admin),row=await store.get('meta',mediaKey(id));if(!row||row.state!=='ready'||row.kind!=='image'||row.ownerId!==order.sellerId||!order.data.items?.some(i=>i.productId===row.productId&&i.imageMediaId===id))fail(404,'not_found','订单中没有此图片。');return dto(row);}
  const [,admin,id,action]=match;if(!ID.test(id))fail(404,'not_found','素材不存在。');
  if(admin){if(action){C.requireMethod(method,'POST');return action==='chunks'?chunk(ctx,id):action==='cancel'?cancel(ctx,id):complete(ctx,id);}C.requireMethod(method,'GET');const user=await authorized(store,event,caller),row=await owned(store,id,user);if(row.state!=='ready')fail(409,'media_upload_incomplete','素材尚未上传完成。');return dto(row);}
  C.requireMethod(method,'GET');if(action)fail(404,'not_found','素材不存在。');const row=await store.get('meta',mediaKey(id)),product=row?await store.get('products',row.productId):null;if(!row||row.state!=='ready'||!product||product.ownerId!==row.ownerId||product.status!=='published'||product.product[row.kind==='image'?'imageMediaId':'videoMediaId']!==id||!await C.sellerVisible(store,product.ownerId,caller.appId))fail(404,'not_found','素材不存在或尚未发布。');return dto(row);
 }
 return {handle,bind,productDTOs};
}
module.exports={createMedia,validateBytes,ID,LIMITS,mediaKey,CHUNK_SIZE};
