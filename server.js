const express=require('express'),http=require('http'),{WebSocketServer}=require('ws'),crypto=require('crypto'),fs=require('fs'),path=require('path'),os=require('os'),QRCode=require('qrcode');
const D=__dirname,PORT=process.env.PORT||3000,MUSIC=process.env.MUSIC_DIR||path.join(D,'music'),UP=path.join(MUSIC,'uploads');
const UPDB=path.join(MUSIC,'uploads.json'),LIBDB=path.join(MUSIC,'library.json');
const MAX_UPLOAD=250*1024*1024,MAX_QUEUE=200,ROOM_LIFETIME=9*60*60*1000,MAX_MEMBERS=1000,MAX_ROOMS=50;
fs.mkdirSync(UP,{recursive:true});
process.on('uncaughtException',e=>console.error('UNCAUGHT:',e));
process.on('unhandledRejection',e=>console.error('UNHANDLED:',e));
const readJSON=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
const debounce=(fn,ms)=>{let t;return()=>{clearTimeout(t);t=setTimeout(fn,ms)}};
const write=(f,v)=>fs.writeFile(f,JSON.stringify(v,null,2),e=>{if(e)console.error('WRITE ERROR:',f,e.message)});
const baseSongs=readJSON(LIBDB,[]);
let uploaded=readJSON(UPDB,[]);
const catalog=new Map([...baseSongs,...uploaded].map(s=>[s.id,s]));
const ytMeta=new Map();
const saveUploads=debounce(()=>write(UPDB,uploaded),300);
const saveLibrary=debounce(()=>write(LIBDB,baseSongs),300);
const pub=s=>{if(!s)return null;const{owner,...o}=s;return o};
const getUid=req=>{const u=String(req.get('x-uid')||'');return /^[a-f0-9]{16,64}$/.test(u)?u:null};
const tokEq=(a,b)=>{a=Buffer.from(String(a||''));b=Buffer.from(String(b||''));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const ytId=u=>{const x=String(u||'').trim();if(/^[A-Za-z0-9_-]{11}$/.test(x))return x;const m=x.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/);return m?m[1]:null};
const ytPlaylistId=u=>{try{return new URL(String(u||'')).searchParams.get('list')}catch{return null}};
async function youtubeVideoMeta(vid){
  if(ytMeta.has(vid))return ytMeta.get(vid);
  try{const r=await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v='+vid)}&format=json`,{headers:{'User-Agent':'Mozilla/5.0'}});if(r.ok){const j=await r.json();const m={title:j.title||'YouTube',artist:j.author_name||'YouTube',artwork:`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`};ytMeta.set(vid,m);return m}}catch(e){}
  return {title:'YouTube Audio',artist:'YouTube',artwork:`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`};
}
async function youtubePlaylistMeta(url){
  const playlistId=ytPlaylistId(url);if(!playlistId)throw new Error('Invalid YouTube playlist link.');
  const r=await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'}});
  if(!r.ok)throw new Error('Could not read YouTube playlist.');
  const html=await r.text(),ids=[];let m;const re=/\"videoId\":\"([A-Za-z0-9_-]{11})\"/g;
  while((m=re.exec(html))&&ids.length<100){if(!ids.includes(m[1]))ids.push(m[1])}
  if(!ids.length)throw new Error('No playable videos found in that YouTube playlist.');
  const tracks=[];
  // Resolve metadata in small concurrent batches so playlist import stays fast even for large lists.
  for(let i=0;i<ids.length;i+=8){
    const batch=await Promise.all(ids.slice(i,i+8).map(async vid=>[vid,await youtubeVideoMeta(vid)]));
    for(const [vid,meta] of batch){
      const id='yt_'+vid,song={id,type:'youtube',source:'youtube',videoId:vid,title:meta.title,artist:meta.artist,album:'YouTube',artwork:meta.artwork,audio:null,duration:0};
      catalog.set(id,song);tracks.push(song);
    }
  }
  return {playlistId,playlistName:'YouTube Playlist',tracks};
}
async function resolveYouTube(input){
  if(ytPlaylistId(input))return {type:'playlist',...await youtubePlaylistMeta(input)};
  const vid=ytId(input);if(!vid)throw new Error('Invalid YouTube link.');
  const meta=await youtubeVideoMeta(vid),song={id:'yt_'+vid,type:'youtube',source:'youtube',videoId:vid,title:meta.title,artist:meta.artist,album:'YouTube',artwork:meta.artwork,audio:null,duration:0};catalog.set(song.id,song);return {type:'track',playlistName:meta.title,tracks:[song]};
}

function persistDuration(song,duration){song.duration=duration;if(uploaded.includes(song))saveUploads();else if(baseSongs.includes(song))saveLibrary()}

const app=express();
app.disable('x-powered-by');
app.use((req,res,next)=>{if(req.path==='/'||/\.html$/i.test(req.path)||req.path.startsWith('/join/'))res.set('Cache-Control','no-store');next()});
app.use('/music',(req,res,next)=>/\.json$/i.test(req.path)?res.sendStatus(404):next());
app.use('/music',express.static(MUSIC,{maxAge:'7d',index:false}));
app.use('/vendor',express.static(path.join(D,'node_modules/qrcode/build'),{maxAge:'7d'}));
app.use(express.static(path.join(D,'public'),{maxAge:0}));
app.get('/join/:id',(_,res)=>res.sendFile(path.join(D,'public','index.html')));

const VISIT_BASE=105; // vibe count starts from here; new unique visitors are added on top
const STATS_F=path.join(__dirname,'stats.json');let ST={visits:0,rooms:0,joins:0,seen:[]};const SEEN=new Set();
try{ST={...ST,...JSON.parse(fs.readFileSync(STATS_F,'utf8'))}}catch{}
ST.seen=Array.isArray(ST.seen)?ST.seen:[];ST.seen.forEach(x=>SEEN.add(x));
let stDirty=false;setInterval(()=>{if(stDirty){stDirty=false;fs.writeFile(STATS_F,JSON.stringify(ST),()=>{})}},30000);
const bump=k=>{ST[k]++;stDirty=true};
app.get('/api/stats',(req,res)=>{
  const vid=String(req.query.vid||'').slice(0,64);
  let ms=0;
  if(req.query.visit&&/^[a-f0-9]{8,64}$/i.test(vid)&&!SEEN.has(vid)){SEEN.add(vid);ST.seen.push(vid);if(ST.seen.length>100000)ST.seen.shift();bump('visits');const n=VISIT_BASE+ST.visits;if(n>=100&&n%50===0)ms=n}
  let live=0;rooms.forEach(r=>{if(r.s&&r.s.state==='playing')live+=r.members.size});
  res.set('Cache-Control','no-store');res.json({visits:VISIT_BASE+ST.visits,rooms:ST.rooms,joins:ST.joins,live,milestone:ms||undefined})});
app.get('/api/public-rooms',(req,res)=>{const a=[];rooms.forEach(r=>{if(r.pub&&r.members.size)a.push({id:r.id,name:r.pub,n:r.members.size,playing:!!(r.s&&r.s.state==='playing')})});a.sort((x,y)=>y.n-x.n);res.set('Cache-Control','no-store');res.json(a.slice(0,50))});
app.get('/api/songs',(req,res)=>{
  const uid=getUid(req);
  res.set('Cache-Control','no-store');
  res.json([...baseSongs,...uploaded.filter(s=>uid&&s.owner===uid)].map(pub));
});


// ---- YouTube audio proxy (fallback for embed-blocked videos; needs yt-dlp installed) ----
const {execFile}=require('child_process'),{Readable}=require('stream');
const ytUrlCache=new Map();let ytGood=null;
function ytDlpUrl(vid){
  const c=ytUrlCache.get(vid);if(c&&c.exp>Date.now())return Promise.resolve(c.url);
  const args=['-f','bestaudio[ext=m4a]/bestaudio','-g','--no-playlist','--no-warnings','--socket-timeout','10','https://www.youtube.com/watch?v='+vid];
  const tries=[['yt-dlp',args],['python',['-m','yt_dlp',...args]],['python3',['-m','yt_dlp',...args]],['py',['-m','yt_dlp',...args]]].map((t,k)=>[...t,k]);
  const ord=ytGood==null?tries:[tries[ytGood],...tries.filter(t=>t[2]!==ytGood)];
  return new Promise((resolve,reject)=>{
    let i=0;const next=()=>{
      if(i>=ord.length)return reject(new Error('yt-dlp not found or failed. Install it: pip install -U yt-dlp'));
      const [cmd,a,k]=ord[i++];
      execFile(cmd,a,{timeout:25000,windowsHide:true,maxBuffer:1<<20},(e,out)=>{
        const url=String(out||'').split('\n')[0].trim();
        if(e||!/^https?:/.test(url))return next();
        ytGood=k;ytUrlCache.set(vid,{url,exp:Date.now()+90*60*1000});resolve(url);
      });
    };next();
  });
}

const ytPend=new Map();
function ytDlpUrlOnce(vid){
  const c=ytUrlCache.get(vid);if(c&&c.exp>Date.now())return Promise.resolve(c.url);
  if(ytPend.has(vid))return ytPend.get(vid);
  const p=ytDlpUrl(vid).finally(()=>ytPend.delete(vid));ytPend.set(vid,p);return p;
}
// pre-resolve audio URLs (Spotify songs) so playback does not wait for yt-dlp when a song starts
const warmQ=[];let warmBusy=0;
function warmPump(){while(warmBusy<3&&warmQ.length){const v=warmQ.shift();warmBusy++;ytDlpUrlOnce(v).catch(()=>{}).finally(()=>{warmBusy--;warmPump()})}}
function prewarm(vid,front){
  if(!vid)return;const c=ytUrlCache.get(vid);
  if((c&&c.exp>Date.now())||ytPend.has(vid))return;
  const i=warmQ.indexOf(vid);if(i>=0)warmQ.splice(i,1);
  if(front)warmQ.unshift(vid);else warmQ.push(vid);warmPump();
}
function warmAhead(r,id){
  const q=r.queue,i=q.indexOf(id),ids=[id,...(i<0?[]:q.slice(i+1,i+3))];
  ids.forEach((x,k)=>{const s=catalog.get(x);if(s&&s.source==='spotify'&&s.videoId)prewarm(s.videoId,k===0)});
}

app.get('/yt-debug/:vid',async(req,res)=>{
  const vid=req.params.vid;ytUrlCache.delete(vid);const t=Date.now();
  try{const url=await ytDlpUrl(vid);const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0',Range:'bytes=0-1023'}});
    res.json({ok:r.ok||r.status===206,videoId:vid,ytDlp:'OK',googlevideoStatus:r.status,contentType:r.headers.get('content-type'),acceptRanges:r.headers.get('accept-ranges'),ms:Date.now()-t});try{r.body.cancel()}catch{}}
  catch(e){res.status(500).json({ok:false,videoId:vid,error:e.message})}
});
app.get('/yt-audio/:vid',async(req,res)=>{
  const vid=req.params.vid;if(!/^[A-Za-z0-9_-]{11}$/.test(vid))return res.sendStatus(400);
  try{
    let url=await ytDlpUrlOnce(vid),h={'User-Agent':'Mozilla/5.0'};if(req.headers.range)h.Range=req.headers.range;
    let r=await fetch(url,{headers:h});
    if(!r.ok&&r.status!==206){ytUrlCache.delete(vid);url=await ytDlpUrl(vid);r=await fetch(url,{headers:h})}
    res.status(r.status);
    for(const k of ['content-type','content-length','content-range','accept-ranges'])if(r.headers.get(k))res.setHeader(k,r.headers.get(k));
    if(!r.headers.get('accept-ranges'))res.setHeader('Accept-Ranges','bytes');
    const rs=Readable.fromWeb(r.body);rs.on('error',()=>{try{res.end()}catch{}});rs.pipe(res);
    res.on('close',()=>{try{rs.destroy()}catch{}});
    console.log('YT AUDIO',vid,r.status,r.headers.get('content-type'),req.headers.range||'');
  }catch(e){console.error('YT AUDIO ERROR:',e.message);if(!res.headersSent)res.status(503).send(e.message)}
});
app.post('/api/youtube/resolve',express.json({limit:'1mb'}),async(req,res)=>{try{res.json(await resolveYouTube(req.body?.url||''))}catch(e){res.status(400).json({error:e.message||'Could not resolve YouTube link.'})}});
const ytSearchCache=new Map();
async function searchYouTubeForSong(title,artist){const query=`${title} ${artist}`.trim();if(ytSearchCache.has(query))return ytSearchCache.get(query);try{const r=await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query+' audio')}`,{headers:{'User-Agent':'Mozilla/5.0'}});const html=await r.text();const m=html.match(/\"videoId\":\"([A-Za-z0-9_-]{11})\"/);if(m){ytSearchCache.set(query,m[1]);return m[1]}}catch(e){}return null}

// ---- Spotify import (fast: parallel YouTube lookups, progressive) ----
async function spotifyMeta(url){
  const pm=url.match(/playlist\/([A-Za-z0-9]+)/),am=url.match(/album\/([A-Za-z0-9]+)/),tm=url.match(/track\/([A-Za-z0-9]+)/);
  const embedUrl=pm?`https://open.spotify.com/embed/playlist/${pm[1]}`:am?`https://open.spotify.com/embed/album/${am[1]}`:tm?`https://open.spotify.com/embed/track/${tm[1]}`:null;
  if(!embedUrl)throw new Error('Invalid Spotify link.');
  const sr=await fetch(embedUrl,{headers:{'User-Agent':'Mozilla/5.0'}}),html=await sr.text(),nd=html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if(!nd)throw new Error('Spotify metadata unavailable.');
  const entity=JSON.parse(nd[1])?.props?.pageProps?.state?.data?.entity;if(!entity)throw new Error('Spotify item could not be read.');
  const cover=entity.coverArt?.sources?.[0]?.url||'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=400',name=entity.title||entity.name||'Spotify';
  const raw=Array.isArray(entity.trackList)?entity.trackList.slice(0,100):[entity];
  return {name,items:raw.map(it=>({title:it.title||entity.title||'Spotify Track',artist:it.subtitle||entity.subtitle||'Spotify Artist',duration:it.duration?Math.round(it.duration/1000):0})),cover};
}
async function spotifyResolveItem(it,name,cover){
  const vid=await searchYouTubeForSong(it.title,it.artist);if(!vid)return null;
  const song={id:'yt_'+vid,type:'youtube',source:'spotify',videoId:vid,title:it.title,artist:it.artist,album:name,artwork:cover,audio:null,duration:it.duration||0};
  catalog.set(song.id,song);return song;
}
async function spotifyResolveAll(url,onBatch){
  const meta=await spotifyMeta(url),out=[];
  // first playable track alone (so playback can start immediately), then the rest 10 at a time in parallel
  let i=0;
  for(;i<meta.items.length;i++){const t=await spotifyResolveItem(meta.items[i],meta.name,meta.cover);if(t){out.push(t);if(onBatch)await onBatch([t],true);i++;break}}
  for(;i<meta.items.length;i+=10){
    const got=(await Promise.all(meta.items.slice(i,i+10).map(it=>spotifyResolveItem(it,meta.name,meta.cover).catch(()=>null)))).filter(Boolean);
    out.push(...got);if(got.length&&onBatch)await onBatch(got,false);
  }
  if(!out.length)throw new Error('No playable tracks could be resolved from Spotify.');
  return {type:out.length>1?'playlist':'track',playlistName:meta.name,tracks:out};
}
app.post('/api/spotify/resolve',express.json({limit:'1mb'}),async(req,res)=>{try{res.json(await spotifyResolveAll(String(req.body?.url||'')))}catch(e){res.status(400).json({error:e.message||'Could not resolve Spotify URL.'})}});


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
    devices:r.members.size,commanderOnline:!!r.cmd,qv:r.qv,amb:!!r.amb
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
  clearTimeout(r.lt);
  const gate=!!play&&!!catalog.get(id).videoId;
  r.s={songId:id,state:play?(gate?'loading':'playing'):'paused',position:0,ts:Date.now()};
  if(gate)r.lt=setTimeout(()=>{if(rooms.has(r.id)&&r.s.songId===id&&r.s.state==='loading'){r.s={...r.s,state:'playing',position:0,ts:Date.now()};bcast(r)}},12000);
  warmAhead(r,id);
  return true;
}
function step(r,d){const q=r.queue;if(!q.length)return;const i=q.indexOf(r.s.songId);let n=i+d;if(n>=q.length){if(r.repeat==='all')n=0;else{r.s={...r.s,state:'paused',position:0,ts:Date.now()};return}}if(n<0)n=r.repeat==='all'?q.length-1:0;setSong(r,q[n],true)}
function addQ(r,id){if(r.queue.includes(id))return true;if(r.queue.length>=MAX_QUEUE)return false;r.queue.push(id);r.qv++;return true}
function addSongsToRoom(r,tracks,play,quiet){for(const raw of tracks){const song={...raw,type:'youtube',source:raw.source==='spotify'?'spotify':'youtube',audio:null};catalog.set(song.id,song);r.yt.set(song.id,song);addQ(r,song.id)}if(play&&tracks[0])setSong(r,tracks[0].id,true);else if(!r.s.songId&&tracks[0])setSong(r,tracks[0].id,false);r.qv++;if(quiet&&!play)soon(r);else bcast(r);if(!quiet)notice(r,play?`Starting ${tracks.length>1?'playlist':'playback'}...`:`Added ${tracks.length} track${tracks.length===1?'':'s'} to queue.`)}
async function ytRoom(r,url,play){r.pend++;try{const result=await resolveYouTube(url);if(rooms.has(r.id))addSongsToRoom(r,result.tracks,play)}catch(e){console.error('YOUTUBE RESOLVE ERROR:',e.message||e);if(rooms.has(r.id))notice(r,e.message||'Could not resolve this YouTube link.')}finally{r.pend--}}

const isMgr=(ws,r)=>(ws.role==='commander'&&r.cmd===ws)||(ws.role==='admin'&&!!r.admins&&r.admins.has(ws));
function leave(ws){
  const r=ws.room;
  ws.room=null;ws.role=null;
  if(!r)return;
  r.members.delete(ws);
  if(r.cmd===ws)r.cmd=null;
  if(r.admins)r.admins.delete(ws);
  if(rooms.has(r.id))soon(r);
}

function endRoom(r){
  r.members.forEach(w=>{send(w,{type:'ROOM_ENDED'});w.room=null;w.role=null});
  rooms.delete(r.id);
  r.members.clear();
  r.yt.clear();
  clearTimeout(r.bt);clearTimeout(r.lt);
}

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

const qrCache=new Map();
app.get('/api/qr/:id',async(req,res)=>{
  const id=String(req.params.id||'').toUpperCase();
  if(!rooms.has(id))return res.status(404).json({error:'Room not found'});
  const url=`${req.protocol}://${req.get('host')}/join/${id}`;
  try{
    if(qrCache.has(url))return res.json({ok:true,url,dataUrl:qrCache.get(url)});
    const dataUrl=await QRCode.toDataURL(url,{width:260,margin:2,errorCorrectionLevel:'M'});
    if(qrCache.size>100)qrCache.clear();qrCache.set(url,dataUrl);
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

    if(m.type==='ROOM_CREATE'){bump('rooms');
      const uid=String(m.uid||'');
      if(!/^[a-f0-9]{16,64}$/.test(uid))return err(ws,'Missing device id.');
      leave(ws);
      if(rooms.size>=MAX_ROOMS)return err(ws,'Server is busy: 50 rooms are already active. Try again in a few minutes.');
      let claimed=false;
      uploaded.forEach(s=>{if(!s.owner){s.owner=uid;claimed=true}});
      if(claimed)saveUploads();
      const r={
        id:newId(),
        owner:uid,
        token:crypto.randomBytes(24).toString('hex'),
        expiresAt:Date.now()+ROOM_LIFETIME,
        cmd:ws,
        queue:[],yt:new Map(),members:new Set([ws]),repeat:'off',tick:0,seen:Date.now(),qv:0,sentQv:0,pend:0,bt:null,
        s:{songId:null,state:'paused',position:0,ts:Date.now()}
      };
      rooms.set(r.id,r);
      ws.room=r;ws.role='commander';
      send(ws,{type:'ROOM_CREATED',roomId:r.id,token:r.token});
      return send(ws,{type:'SYNC_RESPONSE',state:snap(r,true)});
    }

    if(m.type==='ROOM_JOIN'){bump('joins');
      const r=rooms.get(String(m.roomId||'').trim().toUpperCase());
      if(!r)return err(ws,'Room not found. Check the code and try again.');
      if(r.members.size>=MAX_MEMBERS)return err(ws,'This room is full (1000 devices max).');
      leave(ws);
      const isCmd=!!(m.token&&tokEq(m.token,r.token));
      if(isCmd)r.cmd=ws;
      ws.role=isCmd?'commander':'participant';
      ws.room=r;ws.jn=0;
      r.members.add(ws);
      send(ws,{type:'JOINED',roomId:r.id,role:ws.role});
      send(ws,{type:'SYNC_RESPONSE',state:snap(r,true)});
      if(r.pub)send(ws,{type:'PUBLIC_INFO',on:true,name:r.pub,chat:r.chat||[]});
      return isCmd?bcast(r):soon(r);
    }

    const r=ws.room;
    if(!r)return err(ws,'You are not in a room.');

    if(m.type==='SYNC_REQUEST')return send(ws,{type:'SYNC_RESPONSE',state:snap(r,true)});
    if(m.type==='ROOM_LEAVE')return leave(ws);

    // ---- device list + manual sync (commander tools; separate from playback/sync) ----
    if(m.type==='DRIFT'){
      if(ws.role==='commander')return;
      ws.dr={d:Math.max(-60000,Math.min(60000,Math.round(Number(m.d)||0))),s:m.s?1:0,n:String(m.n||'Device').replace(/[<>\u0000-\u001f]/g,'').slice(0,24),t:Date.now()};
      if(!ws.did)ws.did=r.dn=(r.dn||0)+1;
      return;
    }
    if(m.type==='DEV_REQ'){
      if(!isMgr(ws,r))return err(ws,'Only the Commander or an Admin can see devices.');
      const now=Date.now(),a=[];
      r.members.forEach(w=>{if(w===ws)return;if(!w.did)w.did=r.dn=(r.dn||0)+1;const x=w.dr,c=r.cmd===w;a.push({id:w.did,n:w.nm||(c?'Commander':(x?x.n:'Device')),u:w.nm?1:0,d:c?0:(x?x.d:null),s:x?x.s:0,c:c?1:0,a:(r.admins&&r.admins.has(w))?1:0,age:x?now-x.t:null})});
      a.sort((p,q)=>(q.c-p.c)||((q.d===null?1e9:Math.abs(q.d))-(p.d===null?1e9:Math.abs(p.d))));
      return send(ws,{type:'DEVICES',total:r.members.size-1,list:a.slice(0,200)});
    }
    if(m.type==='FORCE_SYNC'){
      if(!isMgr(ws,r))return err(ws,'Only the Commander or an Admin can sync devices.');
      const all=m.id==='all',id=Number(m.id);
      r.members.forEach(w=>{if(w!==ws&&(all||w.did===id))send(w,{type:'FORCE_SYNC'})});
      return;
    }

    if(m.type==='JOIN_HELLO'){
      if(ws.jn||ws.role!=='participant')return;ws.jn=1;
      const n=String(m.n||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,20);if(n)ws.nm=n;
      const dev=String(m.dev||'Device').replace(/[<>\u0000-\u001f]/g,'').slice(0,24);
      if(!ws.did)ws.did=r.dn=(r.dn||0)+1;
      const d=JSON.stringify({type:'JOIN_NOTE',name:ws.nm||'',dev});
      [r.cmd,...(r.admins||[])].forEach(w=>{if(w&&w!==ws&&w.readyState===1)w.send(d)});
      return;
    }
    if(m.type==='NAME'){ws.nm=String(m.n||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,20);return}
    // ---- admins + remove device ----
    if(m.type==='ADMIN_SET'){
      if(ws.role!=='commander'||r.cmd!==ws)return err(ws,'Only the Commander can manage admins.');
      const id=Number(m.id);let t=null;r.members.forEach(w=>{if(w!==ws&&w.did===id&&w.readyState===1)t=w});
      if(!t)return err(ws,'That device is no longer in the room.');
      r.admins=r.admins||new Set();
      if(m.on){t.role='admin';r.admins.add(t)}else{t.role='participant';r.admins.delete(t)}
      return send(t,{type:'ROLE_CHANGE',role:m.on?'admin':'participant'});
    }
    if(m.type==='KICK'){
      if(!isMgr(ws,r))return err(ws,'Only the Commander or an Admin can remove devices.');
      const id=Number(m.id);let t=null;r.members.forEach(w=>{if(w!==ws&&w.did===id)t=w});
      if(!t)return err(ws,'That device is no longer in the room.');
      if(t===r.cmd)return err(ws,'The Commander cannot be removed.');
      if(ws.role==='admin'&&t.role==='admin')return err(ws,'Only the Commander can remove an Admin.');
      send(t,{type:'KICKED'});leave(t);return;
    }
    // ---- transfer Commander role to another device ----
    if(m.type==='TRANSFER'){
      if(ws.role!=='commander'||r.cmd!==ws)return err(ws,'Only the Commander can transfer.');
      const id=Number(m.id);let t=null;
      r.members.forEach(w=>{if(w!==ws&&w.did===id&&w.readyState===1)t=w});
      if(!t)return err(ws,'That device is no longer in the room.');
      r.token=crypto.randomBytes(24).toString('hex');
      ws.role='participant';t.role='commander';r.cmd=t;if(r.admins)r.admins.delete(t);
      send(t,{type:'ROLE_CHANGE',role:'commander',token:r.token});
      send(ws,{type:'ROLE_CHANGE',role:'participant'});
      return bcast(r);
    }

    // ---- public room + chat (separate from playback/sync) ----
    if(m.type==='PUBLIC_SET'){
      if(!isMgr(ws,r))return err(ws,'Only the Commander or an Admin can change this.');
      const on=!!m.on,name=String(m.name||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,30);
      if(on&&!name)return err(ws,'Give your room a name first.');
      r.pub=on?name:null;r.chat=[];
      const d=JSON.stringify({type:'PUBLIC_INFO',on,name:on?name:'',chat:[]});
      r.members.forEach(w=>{if(w.readyState===1)w.send(d)});
      return;
    }
    if(m.type==='CHAT'){
      if(!r.pub)return;
      const t=Date.now();if(t-(ws.lc||0)<400)return;ws.lc=t;
      const text=String(m.text||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,200);if(!text)return;
      const nick=ws.nm||String(m.nick||'Guest').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,16)||'Guest';
      const msg={nick,cmd:r.cmd===ws,adm:ws.role==='admin',text,t};
      (r.chat=r.chat||[]).push(msg);if(r.chat.length>50)r.chat.shift();
      const d=JSON.stringify({type:'CHAT_MSG',msg});
      r.members.forEach(w=>{if(w.readyState===1)w.send(d)});
      return;
    }

    if(m.type==='ROOM_END'){
      if(ws.role!=='commander'||r.cmd!==ws)return err(ws,'Only the Commander can end the room.');
      return endRoom(r);
    }

    // everyone may ADD songs to the queue; only the Commander may play
    if(m.type==='YOUTUBE_ADD'||m.type==='SPOTIFY_ADD'){
      const u=String(m.url||'').trim().slice(0,300),pl=isMgr(ws,r)&&m.play!==false;
      if(!u)return err(ws,m.type==='YOUTUBE_ADD'?'Paste a YouTube link.':'Paste a Spotify link.');
      if(r.pend>=4)return err(ws,'Busy importing. Try again in a moment.');
      if(m.type==='YOUTUBE_ADD'){ytRoom(r,u,pl);return}
      (async()=>{r.pend++;let n=0;try{
        const res=await spotifyResolveAll(u,async(tr,first)=>{if(!rooms.has(r.id))return;n+=tr.length;addSongsToRoom(r,tr,first&&pl,true);if(first)notice(r,pl?'Spotify: playing first song, loading the rest...':'Spotify: adding songs...')});
        if(rooms.has(r.id))notice(r,`Spotify: added ${n} song${n===1?'':'s'} from "${res.playlistName}".`);
      }catch(e){if(rooms.has(r.id))notice(r,e.message||'Could not import Spotify link.')}finally{r.pend--}})();return;
    }
    if(!isMgr(ws,r))return err(ws,'Only the Commander or an Admin can control playback.');

    const s=r.s;

    if(m.type==='LOCAL_DURATION_UPDATE'){
      const id=String(m.id||''),d=Number(m.duration),song=catalog.get(id);
      if(song&&canUse(r,id)&&Number.isFinite(d)&&d>0&&Math.abs((song.duration||0)-d)>0.5){
        persistDuration(song,d);
        return bcast(r);
      }
      return;
    }

    if(m.type==='POS'){
      const p=Number(m.pos);
      if(s.state==='playing'&&m.id===s.songId&&Number.isFinite(p)&&p>=0&&Math.abs(p-pos(r))<1.5){
        const t=Number(m.t),n=Date.now();
        if(Math.abs(p-pos(r))>0.01)r.s={...s,position:p,ts:(Number.isFinite(t)&&Math.abs(t-n)<1500)?t:n};
        const d=JSON.stringify({type:'POS',songId:s.songId,position:pos(r),serverTime:n});
        r.members.forEach(w=>{if(w!==ws&&w.readyState===1&&w.bufferedAmount<65536)w.send(d)});
      }
      return;
    }
    if(m.type==='AUDIO_READY'){
      if(s.state==='loading'&&m.id===s.songId){clearTimeout(r.lt);r.s={...s,state:'playing',position:0,ts:Date.now()};bcast(r)}
      return;
    }

    if(m.type==='ENDED'){
      if(m.id===s.songId&&s.state==='playing'&&pos(r)>2){
        if(r.repeat==='one')setSong(r,s.songId,true);else step(r,1);
        bcast(r);
      }
      return;
    }

    if(m.type==='PL_ADD'){
      const list=(Array.isArray(m.tracks)?m.tracks:[]).slice(0,200).filter(t=>t&&/^[A-Za-z0-9_-]{11}$/.test(t.videoId)).map(t=>({id:'yt_'+t.videoId,type:'youtube',source:t.source==='spotify'?'spotify':'youtube',videoId:t.videoId,title:String(t.title||'YouTube').slice(0,200),artist:String(t.artist||'YouTube').slice(0,200),album:t.source==='spotify'?'Spotify':'YouTube',artwork:String(t.artwork||`https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg`).slice(0,500),audio:null,duration:0}));
      if(!list.length)return;for(const x of list)catalog.set(x.id,x);addSongsToRoom(r,list,m.play!==false);return;
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
      case 'AMBIENT':r.amb=!!m.on;break;
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
    if(r.expiresAt&&t>=r.expiresAt)return endRoom(r);
    if(!r.members.size){if(!r.emptyAt)r.emptyAt=t;else if(t-r.emptyAt>15*60*1000)return endRoom(r);return}else r.emptyAt=0;
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

const SELF=process.env.RENDER_EXTERNAL_URL||'https://clg-fest-jugard.onrender.com';
setInterval(()=>{fetch(SELF+'/ping-keepalive').catch(()=>{})},10*60*1000);
app.get('/ping-keepalive',(_,res)=>res.send('ok'));
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