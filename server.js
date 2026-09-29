const express=require('express'),http=require('http'),{WebSocketServer}=require('ws'),crypto=require('crypto'),fs=require('fs'),path=require('path'),os=require('os'),QRCode=require('qrcode'),{execFile}=require('child_process');
const D=__dirname,PORT=process.env.PORT||3000,MUSIC=process.env.MUSIC_DIR||path.join(D,'music'),UP=path.join(MUSIC,'uploads'),CACHE=path.join(MUSIC,'ytcache');
if (fs.existsSync('/etc/secrets/cookies.txt')) {
  fs.copyFileSync('/etc/secrets/cookies.txt', '/tmp/cookies.txt');
}
const UPDB=path.join(MUSIC,'uploads.json'),LIBDB=path.join(MUSIC,'library.json'),YTDB=path.join(MUSIC,'ytcache.json');
const YTDLP=process.env.YTDLP||'yt-dlp';
const MAX_UPLOAD=250*1024*1024,MAX_DL=3,CACHE_DAYS=3,CACHE_MAX=300,MAX_QUEUE=200,MAX_MEMBERS=1000;
fs.mkdirSync(UP,{recursive:true});fs.mkdirSync(CACHE,{recursive:true});

process.on('uncaughtException',e=>console.error('UNCAUGHT:',e));
process.on('unhandledRejection',e=>console.error('UNHANDLED:',e));

const readJSON=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
const debounce=(fn,ms)=>{let t;return()=>{clearTimeout(t);t=setTimeout(fn,ms)}};
const write=(f,v)=>fs.writeFile(f,JSON.stringify(v,null,2),e=>{if(e)console.error('WRITE ERROR:',f,e.message)});

const baseSongs=readJSON(LIBDB,[]);
let uploaded=readJSON(UPDB,[]);
const ytc=new Map(readJSON(YTDB,[]).map(s=>[s.id,s]));
const saveUploads=debounce(()=>write(UPDB,uploaded),300);
const saveLibrary=debounce(()=>write(LIBDB,baseSongs),300);
const saveYT=debounce(()=>write(YTDB,[...ytc.values()]),300);

uploaded=uploaded.filter(s=>{
  if(!String(s.id).startsWith('yt_'))return true;
  const f=path.basename(String(s.audio||''));
  try{fs.renameSync(path.join(UP,f),path.join(CACHE,f))}catch{}
  ytc.set(s.id,{...s,audio:'/music/ytcache/'+f,used:Date.now()});
  return false;
});
for(const [id,s] of [...ytc]){
  if(!fs.existsSync(path.join(CACHE,path.basename(String(s.audio||''))))){ytc.delete(id)}
}
const catalog=new Map();
[...baseSongs,...uploaded,...ytc.values()].forEach(s=>catalog.set(s.id,s));
{
  const keep=new Set([...ytc.values()].map(s=>path.basename(s.audio)));
  fs.readdirSync(CACHE).forEach(f=>{if(!keep.has(f))fs.unlink(path.join(CACHE,f),()=>{})});
}
saveUploads();saveYT();

const pub=s=>{if(!s)return null;const{owner,used,...o}=s;return o};
const getUid=req=>{const u=String(req.get('x-uid')||'');return /^[a-f0-9]{16,64}$/.test(u)?u:null};
const tokEq=(a,b)=>{a=Buffer.from(String(a||''));b=Buffer.from(String(b||''));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const ytId=u=>{const m=String(u||'').slice(0,300).trim().match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/);return m?m[1]:null};

function persistDuration(song,duration){
  song.duration=duration;
  if(uploaded.includes(song))saveUploads();
  else if(baseSongs.includes(song))saveLibrary();
  else if(ytc.has(song.id))saveYT();
}

const app=express();
app.disable('x-powered-by');
app.use('/music',(req,res,next)=>/\.json$/i.test(req.path)?res.sendStatus(404):next());
app.use('/music',express.static(MUSIC,{maxAge:'7d',index:false}));
app.use('/vendor',express.static(path.join(D,'node_modules/qrcode/build'),{maxAge:'7d'}));
app.use(express.static(path.join(D,'public'),{maxAge:0}));
app.get('/join/:id',(_,res)=>res.sendFile(path.join(D,'public','index.html')));

app.get('/api/songs',(req,res)=>{
  const uid=getUid(req);
  res.set('Cache-Control','no-store');
  res.json([...baseSongs,...uploaded.filter(s=>uid&&s.owner===uid)].map(pub));
});

const server=http.createServer(app);
const wss=new WebSocketServer({server,path:'/ws',maxPayload:16384,perMessageDeflate:false});
const rooms=new Map();
const ALPHA='ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newId(){
  let s;
  do{s=Array.from(crypto.randomBytes(6),b=>ALPHA[b%ALPHA.length]).join('')}while(rooms.has(s));
  return s;
}
const newMediaId=p=>p+'_'+crypto.randomBytes(8).toString('hex');

const canUse=(r,id)=>{
  const s=catalog.get(id);
  if(!s)return false;
  if(s.owner)return s.owner===r.owner;
  if(String(id).startsWith('yt_'))return r.yt.has(id);
  return true;
};
const pos=r=>r.s.state!=='playing'?r.s.position:r.s.position+(Date.now()-r.s.ts)/1000;

const snap=(r,full)=>{
  const o={
    roomId:r.id,songId:r.s.songId,song:pub(catalog.get(r.s.songId)),state:r.s.state,
    position:pos(r),serverTime:Date.now(),queue:r.queue,repeat:r.repeat,
    devices:r.members.size,commanderOnline:!!r.cmd,qv:r.qv
  };
  if(full){
    o.qs=r.queue.map(id=>pub(catalog.get(id))).filter(Boolean);
    o.yl=[...r.yt.values()].map(pub);
  }
  return o;
};

const send=(ws,o)=>{if(ws.readyState===1)ws.send(JSON.stringify(o))};
const err=(ws,message)=>send(ws,{type:'ERROR',message});
const notice=(r,message)=>{
  const d=JSON.stringify({type:'NOTICE',message});
  r.members.forEach(w=>{if(w.readyState===1)w.send(d)});
};
function bcast(r){
  const full=r.sentQv!==r.qv;
  if(full)r.sentQv=r.qv;
  const d=JSON.stringify({type:'STATE_UPDATE',state:snap(r,full)});
  r.members.forEach(w=>{if(w.readyState===1&&w.bufferedAmount<262144)w.send(d)});
}
function soon(r){
  if(r.bt)return;
  r.bt=setTimeout(()=>{r.bt=null;if(rooms.has(r.id))bcast(r)},400);
}

function setSong(r,id,play){
  if(!catalog.has(id))return false;
  r.s={songId:id,state:play?'playing':'paused',position:0,ts:Date.now()};
  return true;
}
function addQ(r,id){
  if(r.queue.includes(id))return true;
  if(r.queue.length>=MAX_QUEUE)return false;
  r.queue.push(id);r.qv++;
  return true;
}

function step(r,d){
  const q=r.queue;
  if(!q.length)return;
  const n=q.indexOf(r.s.songId)+d;
  if(n<0)return setSong(r,q[0],true);
  if(n<q.length)return setSong(r,q[n],true);
  setSong(r,q[0],r.repeat==='all');
}

function leave(ws){
  const r=ws.room;
  ws.room=null;ws.role=null;
  if(!r)return;
  r.members.delete(ws);
  if(r.cmd===ws)r.cmd=null;
  if(rooms.has(r.id))soon(r);
}

function endRoom(r){
  r.members.forEach(w=>{send(w,{type:'ROOM_ENDED'});w.room=null;w.role=null});
  rooms.delete(r.id);
  r.members.clear();
  r.yt.clear();
  clearTimeout(r.bt);
}

let active=0;
const waitq=[],dl=new Map();
const slot=()=>new Promise(res=>{const go=()=>{active++;res()};active<MAX_DL?go():waitq.push(go)});
const free=()=>{active--;const n=waitq.shift();if(n)n()};

function fetchYT(vid){
  const id='yt_'+vid,c=ytc.get(id);
  if(c&&fs.existsSync(path.join(CACHE,path.basename(c.audio)))){c.used=Date.now();saveYT();return Promise.resolve(c)}
  if(dl.has(vid))return dl.get(vid);
  const p=(async()=>{
    await slot();
    try{
      const out=await new Promise((ok,bad)=>execFile(YTDLP,[
        '--no-playlist','--max-filesize', '200M','--js-runtimes', 'node','--cookies', '/tmp/cookies.txt','-f', '140/bestaudio[ext=m4a]/bestaudio',
        '-f','140/bestaudio[ext=m4a]/bestaudio','--print-json','-o',path.join(CACHE,id+'.%(ext)s'),
        'https://www.youtube.com/watch?v='+vid
      ],{maxBuffer:1<<26,timeout:8*60e3},(e,so)=>e?bad(e):ok(String(so))));
      const line=out.trim().split('\n').filter(l=>l.startsWith('{')).pop();
      const j=JSON.parse(line),ext=j.ext||'m4a';
      if(!fs.existsSync(path.join(CACHE,id+'.'+ext)))throw new Error('file missing');
      const song={
        id,type:'local',title:j.title||'YouTube Audio',artist:j.uploader||j.channel||'YouTube',album:'YouTube',
        artwork:`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,audio:`/music/ytcache/${id}.${ext}`,
        duration:Number(j.duration)||0,used:Date.now()
      };
      ytc.set(id,song);catalog.set(id,song);saveYT();
      return song;
    }finally{free()}
  })().finally(()=>dl.delete(vid));
  dl.set(vid,p);
  return p;
}

async function ytRoom(r,vid,play){
  const id='yt_'+vid;
  if(r.pend>=3)return notice(r,'Too many downloads at once. Please wait a moment.');
  if(!ytc.has(id))notice(r,'Downloading song, please wait...');
  r.pend++;
  try{
    const song=await fetchYT(vid);
    if(!rooms.has(r.id))return;
    r.yt.set(id,song);r.qv++;
    addQ(r,id);
    if(play)setSong(r,id,true);
    else if(!r.s.songId)setSong(r,id,false);
    notice(r,play?'Playing now.':'Added to queue.');
  }catch(e){
    console.error('YT-DLP ERROR:',e.message||e);
    if(rooms.has(r.id))notice(r,e.code==='ENOENT'?'yt-dlp is not installed on the server PC.':'Could not download this video. Check the link and try again.');
  }finally{r.pend--}
  if(rooms.has(r.id))bcast(r);
}

function cleanCache(){
  const t=Date.now(),inUse=new Set();
  rooms.forEach(r=>r.yt.forEach((_,id)=>inUse.add(id)));
  [...ytc.values()].sort((a,b)=>b.used-a.used).forEach((s,i)=>{
    if(inUse.has(s.id))return;
    if(t-s.used>CACHE_DAYS*864e5||i>=CACHE_MAX){
      fs.unlink(path.join(CACHE,path.basename(s.audio)),()=>{});
      ytc.delete(s.id);catalog.delete(s.id);
    }
  });
  saveYT();
}
cleanCache();
setInterval(cleanCache,3600e3);

const allowed=['.mp3','.m4a','.aac','.ogg','.oga','.wav','.webm','.mp4','.m4v','.ogv'];

app.post('/api/upload',(req,res)=>{
  const uid=getUid(req);
  if(!uid)return res.status(400).json({error:'Missing device id.'});
  let name;
  try{name=decodeURIComponent(req.get('x-file-name')||'music')}catch{name='music'}
  const ext=path.extname(name).toLowerCase();
  if(!allowed.includes(ext))return res.status(400).json({error:'Unsupported music format.'});
  if(Number(req.get('content-length')||0)>MAX_UPLOAD)return res.status(413).json({error:'File too large.'});
  const id=newMediaId('local'),safe=(id+ext).replace(/[^a-zA-Z0-9._-]/g,'_'),file=path.join(UP,safe);
  let n=0,failed=false;
  const out=fs.createWriteStream(file);
  const fail=(code,msg)=>{
    if(failed)return;
    failed=true;
    req.unpipe(out);out.destroy();fs.unlink(file,()=>{});
    if(!res.headersSent){res.set('Connection','close');res.status(code).json({error:msg})}
  };
  req.on('data',c=>{n+=c.length;if(n>MAX_UPLOAD)fail(413,'File too large.')});
  req.on('error',()=>fail(400,'Upload failed.'));
  out.on('error',()=>fail(500,'Upload failed.'));
  out.on('finish',()=>{
    if(failed)return;
    if(!n){fs.unlink(file,()=>{});return res.status(400).json({error:'No file received.'})}
    const song={
      id,type:'local',owner:uid,
      title:path.basename(name,ext).replace(/[_-]+/g,' ').trim()||'Uploaded Music',
      artist:'Local Upload',album:'SYNCROOM',artwork:'/music/artwork/song001.svg',
      audio:`/music/uploads/${safe}`,duration:Number(req.get('x-duration'))||0
    };
    uploaded.push(song);catalog.set(id,song);saveUploads();
    const room=rooms.get(String(req.get('x-room-id')||'').toUpperCase());
    if(room&&room.owner===uid&&tokEq(req.get('x-token'),room.token)){addQ(room,id);bcast(room)}
    res.json({ok:true,song:pub(song)});
  });
  req.pipe(out);
});

app.get('/api/qr/:id',async(req,res)=>{
  const id=String(req.params.id||'').toUpperCase();
  if(!rooms.has(id))return res.status(404).json({error:'Room not found'});
  const url=`${req.protocol}://${req.get('host')}/join/${id}`;
  try{
    const dataUrl=await QRCode.toDataURL(url,{width:260,margin:2,errorCorrectionLevel:'M'});
    res.json({ok:true,url,dataUrl});
  }catch(e){
    console.error('QR ERROR:',e);
    res.status(500).json({error:'QR generation failed.'});
  }
});

wss.on('connection',ws=>{
  ws.room=null;ws.role=null;ws.alive=true;ws.n=0;
  ws.on('pong',()=>{ws.alive=true});

  ws.on('message',raw=>{
    if(++ws.n>150)return;
    let m;
    try{m=JSON.parse(raw.toString())}catch{return err(ws,'Invalid message.')}
    if(!m||typeof m.type!=='string')return;

    if(m.type==='TIME_PING')return send(ws,{type:'TIME_PONG',t0:m.t0,ts:Date.now()});

    if(m.type==='ROOM_CREATE'){
      const uid=String(m.uid||'');
      if(!/^[a-f0-9]{16,64}$/.test(uid))return err(ws,'Missing device id.');
      leave(ws);
      let claimed=false;
      uploaded.forEach(s=>{if(!s.owner){s.owner=uid;claimed=true}});
      if(claimed)saveUploads();
      const r={
        id:newId(),token:crypto.randomBytes(24).toString('hex'),owner:uid,cmd:ws,members:new Set([ws]),
        queue:[],yt:new Map(),repeat:'off',tick:0,seen:Date.now(),qv:0,sentQv:0,pend:0,bt:null,
        s:{songId:null,state:'paused',position:0,ts:Date.now()}
      };
      rooms.set(r.id,r);
      ws.room=r;ws.role='commander';
      send(ws,{type:'ROOM_CREATED',roomId:r.id,token:r.token});
      return send(ws,{type:'SYNC_RESPONSE',state:snap(r,true)});
    }

    if(m.type==='ROOM_JOIN'){
      const r=rooms.get(String(m.roomId||'').trim().toUpperCase());
      if(!r)return err(ws,'Room not found. Check the code and try again.');
      if(r.members.size>=MAX_MEMBERS)return err(ws,'This room is full.');
      leave(ws);
      const isCmd=!!(m.token&&tokEq(m.token,r.token));
      if(isCmd)r.cmd=ws;
      ws.role=isCmd?'commander':'participant';
      ws.room=r;
      r.members.add(ws);
      send(ws,{type:'JOINED',roomId:r.id,role:ws.role});
      send(ws,{type:'SYNC_RESPONSE',state:snap(r,true)});
      return isCmd?bcast(r):soon(r);
    }

    const r=ws.room;
    if(!r)return err(ws,'You are not in a room.');

    if(m.type==='SYNC_REQUEST')return send(ws,{type:'SYNC_RESPONSE',state:snap(r,true)});
    if(m.type==='ROOM_LEAVE')return leave(ws);

    if(m.type==='ROOM_END'){
      if(ws.role!=='commander'||r.cmd!==ws)return err(ws,'Only the Commander can end the room.');
      return endRoom(r);
    }

    if(ws.role!=='commander'||r.cmd!==ws)return err(ws,'Only the Commander can control playback.');

    const s=r.s;

    if(m.type==='LOCAL_DURATION_UPDATE'){
      const id=String(m.id||''),d=Number(m.duration),song=catalog.get(id);
      if(song&&canUse(r,id)&&Number.isFinite(d)&&d>0&&Math.abs((song.duration||0)-d)>0.5){
        persistDuration(song,d);
        return bcast(r);
      }
      return;
    }

    if(m.type==='ENDED'){
      if(m.id===s.songId&&s.state==='playing'&&pos(r)>2){
        if(r.repeat==='one')setSong(r,s.songId,true);else step(r,1);
        bcast(r);
      }
      return;
    }

    if(m.type==='YOUTUBE_ADD'){
      const vid=ytId(m.url);
      if(!vid)return err(ws,'Invalid YouTube link.');
      ytRoom(r,vid,m.play!==false);
      return;
    }

    switch(m.type){
      case 'PLAY':{
        const want=typeof m.songId==='string'&&canUse(r,m.songId)?m.songId:s.songId;
        if(!want)return;
        if(!addQ(r,want))return err(ws,'Queue is full.');
        if(want!==s.songId)setSong(r,want,true);
        else if(s.state!=='playing')r.s={...s,state:'playing',ts:Date.now()};
        break;
      }
      case 'PAUSE':
        r.s={...s,state:'paused',position:pos(r),ts:Date.now()};
        break;
      case 'SEEK':{
        const p=Number(m.position);
        if(!Number.isFinite(p))return;
        const d=catalog.get(s.songId)?.duration||0;
        const max=d>0?Math.max(0,d-0.5):Math.max(0,p);
        r.s={...s,position:Math.max(0,Math.min(p,max)),ts:Date.now()};
        break;
      }
      case 'NEXT':step(r,1);break;
      case 'PREVIOUS':
        if(pos(r)>3)r.s={...s,position:0,ts:Date.now()};
        else step(r,-1);
        break;
      case 'SET_REPEAT':
        if(['off','all','one'].includes(m.mode))r.repeat=m.mode;
        break;
      case 'SHUFFLE':{
        const rest=r.queue.filter(id=>id!==s.songId);
        for(let i=rest.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[rest[i],rest[j]]=[rest[j],rest[i]]}
        r.queue=r.queue.includes(s.songId)?[s.songId,...rest]:rest;
        r.qv++;
        break;
      }
      case 'QUEUE_ADD':{
        if(typeof m.songId!=='string'||!canUse(r,m.songId))return;
        if(!addQ(r,m.songId))return err(ws,'Queue is full.');
        if(!s.songId)setSong(r,m.songId,false);
        break;
      }
      case 'QUEUE_CLEAR':
        r.queue=s.songId?[s.songId]:[];r.qv++;
        break;
      case 'QUEUE_UPDATE':
        if(Array.isArray(m.queue)&&m.queue.length<=MAX_QUEUE&&m.queue.every(id=>typeof id==='string'&&canUse(r,id))){
          r.queue=[...new Set(m.queue)];r.qv++;
        }
        break;
      default:return;
    }
    bcast(r);
  });

  ws.on('error',e=>console.error('WebSocket error:',e.message||e));
  ws.on('close',()=>leave(ws));
});

setInterval(()=>{
  const t=Date.now();
  rooms.forEach(r=>{
    if(r.cmd)r.seen=t;
    else if(t-r.seen>30*60e3)return endRoom(r);
    const song=r.s.songId&&catalog.get(r.s.songId);
    if(song&&song.duration>0&&r.s.state==='playing'&&pos(r)>=song.duration){
      if(r.repeat==='one')setSong(r,r.s.songId,true);else step(r,1);
      bcast(r);
    }else if(++r.tick%5===0)bcast(r);
  });
},1000);

setInterval(()=>{wss.clients.forEach(w=>{w.n=0})},10000);

setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(!ws.alive)return ws.terminate();
    ws.alive=false;ws.ping();
  });
},15000);

server.keepAliveTimeout=65000;
server.headersTimeout=66000;
server.requestTimeout=0;

server.listen(PORT,'0.0.0.0',()=>{
  console.log('SYNCROOM running. Open the Commander on one of:');
  console.log(`  http://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat()
    .filter(i=>i.family==='IPv4'&&!i.internal)
    .forEach(i=>console.log(`  http://${i.address}:${PORT}   <- use this one so phones can join`));
});