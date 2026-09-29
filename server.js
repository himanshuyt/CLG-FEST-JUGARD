const express=require('express'),http=require('http'),{WebSocketServer}=require('ws'),crypto=require('crypto'),fs=require('fs'),path=require('path'),os=require('os'),QRCode=require('qrcode'),{execFile}=require('child_process');
const D=__dirname,PORT=process.env.PORT||3000,MUSIC=path.join(D,'music'),UP=path.join(MUSIC,'uploads'),UPDB=path.join(MUSIC,'uploads.json'),LIBDB=path.join(MUSIC,'library.json');
const YTDLP=process.env.YTDLP||'yt-dlp';
fs.mkdirSync(UP,{recursive:true});

const baseSongs=JSON.parse(fs.readFileSync(LIBDB,'utf8'));
let uploaded=[];
try{uploaded=JSON.parse(fs.readFileSync(UPDB,'utf8'))}catch{}
let songs=[...baseSongs,...uploaded];
const refresh=()=>{songs=[...baseSongs,...uploaded]};
const saveUploads=()=>fs.writeFileSync(UPDB,JSON.stringify(uploaded,null,2));
const saveLibrary=()=>fs.writeFileSync(LIBDB,JSON.stringify(baseSongs,null,2));
const findSong=id=>songs.find(s=>s.id===id);
const dl=new Map();
const ytId=u=>{const m=String(u||'').trim().match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/);return m?m[1]:null};

function persistDuration(song,duration){
  song.duration=duration;
  if(uploaded.some(s=>s.id===song.id))saveUploads();
  else if(baseSongs.some(s=>s.id===song.id))saveLibrary();
}

const app=express();
app.use('/music',express.static(MUSIC,{maxAge:'7d'}));
app.use('/vendor',express.static(path.join(D,'node_modules/qrcode/build'),{maxAge:'7d'}));
app.use(express.static(path.join(D,'public'),{maxAge:0}));
app.get('/api/songs',(_,res)=>res.json(songs));
app.get('/join/:id',(_,res)=>res.sendFile(path.join(D,'public','index.html')));

const server=http.createServer(app);
const wss=new WebSocketServer({server,path:'/ws',maxPayload:8192,perMessageDeflate:false});
const rooms=new Map();
const ALPHA='ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newId(){
  let s;
  do{s=Array.from(crypto.randomBytes(6),b=>ALPHA[b%ALPHA.length]).join('')}while(rooms.has(s));
  return s;
}
const newMediaId=p=>p+'_'+crypto.randomBytes(8).toString('hex');

const getRoomSong=(r,id)=>findSong(id);
const pos=r=>r.s.state!=='playing'?r.s.position:r.s.position+(Date.now()-r.s.ts)/1000;

const snap=r=>({
  roomId:r.id,songId:r.s.songId,song:getRoomSong(r,r.s.songId),state:r.s.state,
  position:pos(r),serverTime:Date.now(),queue:r.queue,repeat:r.repeat,
  devices:r.members.size,commanderOnline:!!r.cmd,
  ytSongs:r.queue.map(findSong).filter(s=>s&&String(s.id).startsWith('yt_'))
});

const send=(ws,o)=>{if(ws.readyState===1)ws.send(JSON.stringify(o))};
const err=(ws,message)=>send(ws,{type:'ERROR',message});
const notice=(r,message,refreshSongs)=>r.members.forEach(w=>send(w,{type:'NOTICE',message,refreshSongs:!!refreshSongs}));
const bcast=r=>{
  const d=JSON.stringify({type:'STATE_UPDATE',state:snap(r)});
  r.members.forEach(w=>{if(w.readyState===1)w.send(d)});
};

function setSong(r,id,play){
  if(!getRoomSong(r,id))return false;
  r.s={songId:id,state:play?'playing':'paused',position:0,ts:Date.now()};
  return true;
}

function ytAudio(vid){
  const id='yt_'+vid;
  const have=uploaded.find(s=>s.id===id);
  if(have)return Promise.resolve(have);
  if(dl.has(vid))return dl.get(vid);
  const p=new Promise((ok,bad)=>{
    execFile(YTDLP,['--no-playlist','--no-warnings','--no-progress','-f','bestaudio[ext=m4a]/bestaudio','--print-json','-o',path.join(UP,id+'.%(ext)s'),'https://www.youtube.com/watch?v='+vid],{maxBuffer:1<<26,timeout:10*60e3},(e,out)=>{
      if(e)return bad(e);
      try{
        const line=String(out).trim().split('\n').filter(l=>l.startsWith('{')).pop();
        const j=JSON.parse(line);
        const song={
          id,type:'local',title:j.title||'YouTube Audio',artist:j.uploader||j.channel||'YouTube',album:'YouTube',
          artwork:`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,audio:`/music/uploads/${id}.${j.ext||'m4a'}`,duration:Number(j.duration)||0
        };
        uploaded.push(song);refresh();saveUploads();
        ok(song);
      }catch(x){bad(x)}
    });
  }).finally(()=>dl.delete(vid));
  dl.set(vid,p);
  return p;
}

async function ytPlay(r,vid){
  const id='yt_'+vid;
  const cached=!!uploaded.find(s=>s.id===id);
  if(!cached)notice(r,'Downloading song from YouTube, please wait...');
  try{
    await ytAudio(vid);
    if(!rooms.has(r.id))return;
    if(!r.queue.includes(id))r.queue.push(id);
    setSong(r,id,true);
    notice(r,'Playing now.',true);
  }catch(e){
    console.error('YT-DLP ERROR:',e.message||e);
    if(!rooms.has(r.id))return;
    notice(r,e.code==='ENOENT'
      ?'yt-dlp is not installed on the server PC.'
      :'Could not download this video. Check the link and try again.');
  }
  if(rooms.has(r.id))bcast(r);
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
  if(rooms.has(r.id))bcast(r);
}

function endRoom(r){
  r.members.forEach(w=>{send(w,{type:'ROOM_ENDED'});w.room=null;w.role=null});
  rooms.delete(r.id);
  r.members.clear();
}

const allowed=['.mp3','.m4a','.aac','.ogg','.oga','.wav','.webm','.mp4','.m4v','.ogv'];

app.post('/api/upload',express.raw({type:'*/*',limit:'250mb'}),(req,res)=>{
  try{
    const name=decodeURIComponent(req.get('x-file-name')||'music');
    const ext=path.extname(name).toLowerCase();
    if(!allowed.includes(ext))return res.status(400).json({error:'Unsupported music format.'});
    if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'No file received.'});
    const id=newMediaId('local');
    const safe=(id+ext).replace(/[^a-zA-Z0-9._-]/g,'_');
    fs.writeFileSync(path.join(UP,safe),req.body);
    const song={
      id,type:'local',
      title:path.basename(name,ext).replace(/[_-]+/g,' ').trim()||'Uploaded Music',
      artist:'Local Upload',album:'SYNCROOM',artwork:'/music/artwork/song001.svg',
      audio:`/music/uploads/${safe}`,duration:Number(req.get('x-duration'))||0
    };
    uploaded.push(song);
    refresh();saveUploads();
    const room=rooms.get(String(req.get('x-room-id')||'').toUpperCase());
    if(room&&!room.queue.includes(song.id)){room.queue.push(song.id);bcast(room)}
    res.json({ok:true,song});
  }catch(e){
    console.error('UPLOAD ERROR:',e);
    res.status(500).json({error:'Upload failed.'});
  }
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
  ws.room=null;ws.role=null;ws.alive=true;
  ws.on('pong',()=>{ws.alive=true});

  ws.on('message',raw=>{
    let m;
    try{m=JSON.parse(raw.toString())}catch{return err(ws,'Invalid message.')}

    if(m.type==='TIME_PING')return send(ws,{type:'TIME_PONG',t0:m.t0,ts:Date.now()});

    if(m.type==='ROOM_CREATE'){
      leave(ws);
      const r={
        id:newId(),token:crypto.randomBytes(24).toString('hex'),cmd:ws,members:new Set([ws]),
        queue:songs.filter(s=>!String(s.id).startsWith('yt_')).map(s=>s.id),repeat:'off',tick:0,seen:Date.now()
      };
      setSong(r,r.queue[0],false);
      rooms.set(r.id,r);
      ws.room=r;ws.role='commander';
      send(ws,{type:'ROOM_CREATED',roomId:r.id,token:r.token});
      return bcast(r);
    }

    if(m.type==='ROOM_JOIN'){
      const r=rooms.get(String(m.roomId||'').trim().toUpperCase());
      if(!r)return err(ws,'Room not found. Check the code and try again.');
      leave(ws);
      let isCmd=false;
      if(m.token&&r.token){
        try{
          const a=Buffer.from(String(m.token)),b=Buffer.from(r.token);
          isCmd=a.length===b.length&&crypto.timingSafeEqual(a,b);
        }catch{}
      }
      if(isCmd)r.cmd=ws;
      ws.role=isCmd?'commander':'participant';
      ws.room=r;
      r.members.add(ws);
      send(ws,{type:'JOINED',roomId:r.id,role:ws.role});
      return bcast(r);
    }

    const r=ws.room;
    if(!r)return err(ws,'You are not in a room.');

    if(m.type==='SYNC_REQUEST')return send(ws,{type:'SYNC_RESPONSE',state:snap(r)});
    if(m.type==='ROOM_LEAVE')return leave(ws);

    if(m.type==='ROOM_END'){
      if(ws.role!=='commander'||r.cmd!==ws)return err(ws,'Only the Commander can end the room.');
      return endRoom(r);
    }

    if(ws.role!=='commander'||r.cmd!==ws)return err(ws,'Only the Commander can control playback.');

    const s=r.s;

    if(m.type==='LOCAL_DURATION_UPDATE'){
      const song=findSong(String(m.id||''));
      const d=Number(m.duration);
      if(song&&Number.isFinite(d)&&d>0&&Math.abs((song.duration||0)-d)>0.5){
        persistDuration(song,d);
        return bcast(r);
      }
      return;
    }

    if(m.type==='YOUTUBE_ADD'){
      const vid=ytId(m.url);
      if(!vid)return err(ws,'Invalid YouTube link.');
      ytPlay(r,vid);
      return;
    }

    switch(m.type){
      case 'PLAY':{
        const id=getRoomSong(r,m.songId)?m.songId:s.songId;
        if(!id)return;
        if(!r.queue.includes(id))r.queue.push(id);
        if(id!==s.songId)setSong(r,id,true);
        else if(s.state!=='playing')r.s={...s,state:'playing',ts:Date.now()};
        break;
      }
      case 'PAUSE':
        r.s={...s,state:'paused',position:pos(r),ts:Date.now()};
        break;
      case 'SEEK':{
        const p=Number(m.position);
        if(!Number.isFinite(p))return;
        const d=getRoomSong(r,s.songId)?.duration||0;
        const max=d>0?Math.max(0,d-0.5):Math.max(0,p);
        r.s={...s,position:Math.max(0,Math.min(p,max)),ts:Date.now()};
        break;
      }
      case 'NEXT':step(r,1);break;
      case 'PREVIOUS':step(r,-1);break;
      case 'SET_REPEAT':
        if(['off','all','one'].includes(m.mode))r.repeat=m.mode;
        break;
      case 'SHUFFLE':{
        const cur=r.queue.indexOf(s.songId);
        const rest=r.queue.filter((_,i)=>i!==cur).sort(()=>Math.random()-0.5);
        r.queue=cur<0?rest:[r.queue[cur],...rest];
        break;
      }
      case 'QUEUE_UPDATE':
        if(Array.isArray(m.queue)&&m.queue.length&&m.queue.length<=100&&m.queue.every(id=>getRoomSong(r,id)))
          r.queue=[...new Set(m.queue)];
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
    const song=getRoomSong(r,r.s.songId);
    if(song&&song.duration>0&&r.s.state==='playing'&&pos(r)>=song.duration){
      if(r.repeat==='one')setSong(r,r.s.songId,true);else step(r,1);
      bcast(r);
    }else if(++r.tick%5===0)bcast(r);
  });
},1000);

setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(!ws.alive)return ws.terminate();
    ws.alive=false;ws.ping();
  });
},15000);

server.keepAliveTimeout=65000;
server.headersTimeout=66000;

server.listen(PORT,'0.0.0.0',()=>{
  console.log('SYNCROOM running. Open the Commander on one of:');
  console.log(`  http://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat()
    .filter(i=>i.family==='IPv4'&&!i.internal)
    .forEach(i=>console.log(`  http://${i.address}:${PORT}   <- use this one so phones can join`));
});
