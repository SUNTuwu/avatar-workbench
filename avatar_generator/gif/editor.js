import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.esm.js';

const $ = id => document.getElementById(id);
const view = $('view'), ctx = view.getContext('2d');
const value = id => $(id).valueAsNumber;
let frames = [], image, position = 0, generation = 0, timer, busy = false, cancelled = false, anchor;
const report = msg => $('status').textContent = msg;

function setBusy(on) {
  busy = on;
  $('folder').disabled = on;
  $('edit').disabled = $('play').disabled = $('scrub').disabled = on || !frames.length;
}
function stop() { clearTimeout(timer); timer = null; $('play').textContent = '播放'; }
function crop() {
  const rect = ['x','y','w','h'].map(value);
  const [x,y,w,h] = rect;
  if (!rect.every(Number.isInteger) || x<0 || y<0 || w<1 || h<1 || x+w>view.width || y+h>view.height)
    throw Error('裁剪框须在画布内，宽和高至少为 1 像素。');
  return rect;
}
function setCrop(x,y,w,h) {
  for (const [id,v] of Object.entries({x,y,w,h})) $(id).value = v;
  draw();
}
Grade.load(structuredClone(screenshotGrade));
$('matchColor').onchange = () => { clearDownload(); draw(); };
function drawFrame(context, bitmap, x, y, graded) {
  context.save();
  if (graded) context.filter = Grade.css();
  context.drawImage(bitmap, x, y);
  context.restore();
}
function draw() {
  ctx.clearRect(0,0,view.width,view.height);
  if (!image) return;
  drawFrame(ctx,image,0,0,$('matchColor').checked);
  let rect;
  try { rect = crop(); } catch { return; }
  const [x,y,w,h] = rect;
  ctx.beginPath(); ctx.rect(0,0,view.width,view.height);ctx.rect(x,y,w,h);
  ctx.fillStyle = '#10151bad';ctx.fill('evenodd');
  ctx.strokeStyle = '#83ead0';ctx.lineWidth = 2;ctx.strokeRect(x,y,w,h);
}
function selection() {
  const a=value('first'), b=value('last'), fps=value('fps');
  if (![a,b,fps].every(Number.isInteger) || fps<1 || fps>50) throw Error('请输入整数帧号及 1–50 的帧率。');
  const from=frames.findIndex(f=>f.n===a), to=frames.findIndex(f=>f.n===b);
  if (from<0 || to<from) throw Error('请选择文件夹内已有的起止帧，结束帧须大于或等于起始帧。');
  return {from,to,fps};
}
function summary() {
  try {
    const {from,to,fps}=selection(), count=to-from+1;
    $('duration').textContent=count+' 帧 · '+(count/fps).toFixed(2)+' 秒';
  } catch(e) { $('duration').textContent=e.message; }
}
async function show(i) {
  const token=++generation, entry=frames[i];
  const next=await createImageBitmap(entry.file);
  if (generation!==token) { next.close(); return; }
  image?.close();image=next;position=i;
  $('scrub').value=i;$('frame').textContent='帧 '+entry.n;draw();
}
function failure(e) {stop();report(e.message);}
$('folder').onchange=async e=>{
  stop();setBusy(true);++generation;image?.close();image=null;draw();
  frames=[];clearDownload();
  try {
    const input=Array.from(e.target.files);
    const group=input.filter(f=>f.webkitRelativePath.split('/').length===2 && /\d+\.png$/i.test(f.name));
    frames=group.map(file=>({file,n:Number(file.name.match(/(\d+)\.png$/i)[1])})).sort((a,b)=>a.n-b.n);
    if (!frames.length) throw Error('这个文件夹里没有名称以帧号结尾的 PNG。');
    if (frames.some((f,i)=>!Number.isSafeInteger(f.n) || f.n===frames[i-1]?.n)) throw Error('帧号重复或过大，请选择单个序列文件夹。');
    const first=await createImageBitmap(frames[0].file);
    view.width=first.width;view.height=first.height;image=first;position=0;
    $('first').value=frames[0].n;$('last').value=frames.at(-1).n;
    $('scrub').max=frames.length-1;$('scrub').value=0;$('frame').textContent='帧 '+frames[0].n;
    $('source').textContent=group[0].webkitRelativePath.split('/')[0]+' · '+frames.length+' 帧';
    setCrop(0,0,view.width,view.height);summary();
    report(frames.at(-1).n-frames[0].n+1===frames.length?'序列已载入。':'序列有缺号，按现有图片顺序连接。');
  } catch(err){frames=[];report(err.message);}
  finally {setBusy(false);e.target.value='';}
};
$('scrub').oninput=()=>{stop();show(value('scrub')).catch(failure);};
$('play').onclick=async()=>{
  if(timer!==null && timer!==undefined){stop();return;}
  try {
    const {from,to,fps}=selection();let i=position>=from && position<to?position:from;
    $('play').textContent='暂停';
    const tick=async()=>{
      try {
        const start=performance.now();
        await show(i);
        if(timer===null)return;
        i=i===to?from:i+1;
        timer=setTimeout(tick,Math.max(0,1000/fps-(performance.now()-start)));
      }catch(e){failure(e);}
    };
    timer=setTimeout(tick,0);
  }catch(e){failure(e);}
};
for(const id of ['first','last','fps']) $(id).oninput=()=>{stop();summary();};
for(const id of ['x','y','w','h']) $(id).oninput=draw;
$('reset').onclick=()=>setCrop(0,0,view.width,view.height);
function point(e) {
  const r=view.getBoundingClientRect();
  return [Math.max(0,Math.min(view.width-1,Math.floor((e.clientX-r.left)*view.width/r.width))),
    Math.max(0,Math.min(view.height-1,Math.floor((e.clientY-r.top)*view.height/r.height)))];
}
view.onpointerdown=e=>{
  if(busy || !frames.length)return;
  stop();anchor=point(e);view.setPointerCapture(e.pointerId);
};
view.onpointermove=e=>{
  if(!anchor)return;
  const [x,y]=point(e);
  setCrop(Math.min(anchor[0],x),Math.min(anchor[1],y),Math.abs(anchor[0]-x)+1,Math.abs(anchor[1]-y)+1);
};
view.onlostpointercapture=()=>{anchor=null;};
function clearDownload(){
  const link=$('download');
  if(link.hasAttribute('href')) URL.revokeObjectURL(link.href);
  link.removeAttribute('href');link.hidden=true;
}
$('cancel').onclick=()=>{cancelled=true;};
async function processFrames(encode){
  stop();
  try {
    const {from,to,fps}=selection(), [x,y,w,h]=encode?crop():[0,0,view.width,view.height];
    setBusy(true);cancelled=false;$('cancel').hidden=false;
    const c=document.createElement('canvas');c.width=w;c.height=h;
    const g=c.getContext('2d',{willReadFrequently:true});
    let left=w,top=h,right=-1,bottom=-1;
    const gif=encode?GIFEncoder():null;
    for(let i=from;i<=to;i++){
      report((encode?'正在编码':'正在扫描透明边')+' · '+(i-from+1)+' / '+(to-from+1));
      const bmp=await createImageBitmap(frames[i].file);
      try {
        if(cancelled)throw Error('已取消。');
        if(bmp.width!==view.width || bmp.height!==view.height)throw Error('帧 '+frames[i].n+' 的画布尺寸不一致。');
        g.clearRect(0,0,w,h);drawFrame(g,bmp,-x,-y,encode && $('matchColor').checked);
      } finally {bmp.close();}
      const rgba=g.getImageData(0,0,w,h).data;
      if(encode){
        const palette=quantize(rgba,255,{format:'rgb565'});
        const indices=applyPalette(rgba,palette,'rgb565');
        palette.unshift([0,0,0]);
        for(let p=0;p<indices.length;p++)indices[p]=rgba[4*p+3]<128?0:indices[p]+1;
        const j=i-from,delay=10*(Math.round((j+1)*100/fps)-Math.round(j*100/fps));
        gif.writeFrame(indices,w,h,{palette,delay,transparent:true,transparentIndex:0,dispose:2,repeat:0});
      } else {
        for(let row=0;row<h;row++){
          let a=0,b=w-1;
          while(a<w && !rgba[4*(row*w+a)+3])a++;
          if(a===w)continue;
          while(b>a && !rgba[4*(row*w+b)+3])b--;
          left=Math.min(left,a);right=Math.max(right,b);top=Math.min(top,row);bottom=Math.max(bottom,row);
        }
      }
    }
    if(encode){
      gif.finish();clearDownload();
      const link=$('download');link.href=URL.createObjectURL(new Blob([gif.bytesView()],{type:'image/gif'}));
      link.download=frames[0].file.webkitRelativePath.split('/')[0]+'_'+frames[from].n+'-'+frames[to].n+'.gif';link.hidden=false;
      report('已生成 '+w+' × '+h+' 的透明循环 GIF。');
    } else {
      if(right<0)throw Error('所选帧全部透明。');
      setCrop(left,top,right-left+1,bottom-top+1);report('已按整段动作范围裁剪。');
    }
  }catch(e){report(e.message);}
  finally{setBusy(false);$('cancel').hidden=true;}
}
$('auto').onclick=()=>processFrames(false);
$('encode').onclick=()=>processFrames(true);
