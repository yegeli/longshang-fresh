const LIMITS={image:5*1024*1024,video:20*1024*1024};
const TYPES={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',mp4:'video/mp4'};
const cancelled=error=>/cancel/i.test(error&&error.errMsg||error&&error.message||'');
const invoke=(api,name,options)=>new Promise((resolve,reject)=>api[name]({...options,success:resolve,fail:reject}));

async function choose(api,kind){
  try{
    if(api.chooseMedia){
      const result=await invoke(api,'chooseMedia',{count:1,mediaType:[kind],sourceType:['album','camera'],maxDuration:60,camera:'back',sizeType:['original']});
      return result.tempFiles&&result.tempFiles[0];
    }
    if(kind==='image'){
      const result=await invoke(api,'chooseImage',{count:1,sourceType:['album','camera'],sizeType:['original']});
      return result.tempFiles&&result.tempFiles[0]||{tempFilePath:result.tempFilePaths&&result.tempFilePaths[0]};
    }
    return await invoke(api,'chooseVideo',{sourceType:['album','camera'],maxDuration:60,compressed:false,camera:'back'});
  }catch(error){if(cancelled(error))return null;throw Error('未能打开相册或相机，请检查微信权限后重试。');}
}

async function validate(api,file,kind){
  const filePath=file.tempFilePath||file.path;
  if(!filePath)throw Error('没有读取到文件，请重新选择。');
  let size=Number(file.size),type=String(filePath).split('?')[0].split('.').pop().toLowerCase(),duration=Number(file.duration);
  if(!Number.isSafeInteger(size)||size<=0){
    if(!api.getFileSystemManager)throw Error('无法读取文件大小，请更新微信后重试。');
    const fs=api.getFileSystemManager();
    const stat=await new Promise((resolve,reject)=>fs.stat({path:filePath,success:resolve,fail:reject}));
    size=Number(stat.stats&&stat.stats.size);
  }
  if(!Number.isSafeInteger(size)||size<=0)throw Error('文件为空或已失效，请重新选择。');
  if(size>LIMITS[kind])throw Error(kind==='image'?'图片不能超过5 MiB，请压缩后重试。':'视频不能超过20 MiB，请压缩后重试。');
  if(kind==='image'){
    if(api.getImageInfo){
      const info=await invoke(api,'getImageInfo',{src:filePath});
      if(info.type)type=info.type.toLowerCase();
    }
    if(!['jpg','jpeg','png','webp'].includes(type))throw Error('请选择 JPEG、PNG 或 WebP 图片。');
  }else{
    if(type!=='mp4')throw Error('请选择 MP4 视频，其他格式请先转换。');
    if(api.getVideoInfo){const info=await invoke(api,'getVideoInfo',{src:filePath});if(Number.isFinite(Number(info.duration)))duration=Number(info.duration);}
    if(!Number.isFinite(duration)||duration<=0)throw Error('未能读取视频时长，请重新选择。');
    if(duration>120)throw Error('视频请剪辑至120秒以内。');
  }
  return {filePath,size,mimeType:TYPES[type],...(kind==='video'?{duration}:{})};
}
module.exports={choose,validate,cancelled};
