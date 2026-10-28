import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {Store,kstDay,hashToken} from './store.mjs';
import {GameAI} from './ai.mjs';
import {AIQueue} from './queue.mjs';
import * as engine from './engine.mjs';
import {COUNCIL,MODULES,MASKS,PHASE_LABELS,ZONES,TACTICS} from './content.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dataDir=resolve(process.env.DATA_DIR||join(root,'data'));
const store=new Store(dataDir);store.recoverActions();store.prune();
const ai=new GameAI({dataDir,store,recordUsage:(...args)=>store.recordUsage(...args),available:()=>store.dayCost()<Number(process.env.DAILY_AI_BUDGET_USD||5)});
const app=express();const locks=new Set();const aiQueue=new AIQueue();
const staticDir=resolve(process.env.STATIC_DIR||join(root,'dist'));
setInterval(()=>store.prune(),3600000).unref();
// Hackathon ended. Keep the demo implementation dormant for an explicit future event.
const demoEnabled=process.env.ENABLE_HACKATHON_DEMO==='1';
app.disable('x-powered-by');app.set('trust proxy','loopback');
const helmetOptions={contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'","data:"],fontSrc:["'self'"],connectSrc:["'self'"],frameAncestors:["'none'"],upgradeInsecureRequests:null}},crossOriginEmbedderPolicy:false};
app.use((req,res,next)=>helmet({...helmetOptions,hsts:req.secure?undefined:false})(req,res,next));
app.use(express.json({limit:'12kb',inflate:false}));app.use(cookieParser());
// Optional one-time cookie migration. Previous names belong in deployment config.
const cookieOptions=req=>({httpOnly:true,sameSite:'strict',secure:req.secure||req.get('x-forwarded-proto')==='https',maxAge:7*86400000,path:'/'});
app.use((req,res,next)=>{
 for(const [previous,current,role] of [[process.env.LEGACY_SESSION_COOKIE,'thelastvote_session','player'],[process.env.LEGACY_DEMO_COOKIE,'thelastvote_demo_session','demo']]){
  if(!previous||previous===current||!req.cookies[previous])continue;
  const token=req.cookies[previous],user=store.resolve(token);
  if(user?.role===role&&(role!=='demo'||demoEnabled)&&!store.resolve(req.cookies[current])){
   req.cookies[current]=token;res.cookie(current,token,cookieOptions(req));
  }
  res.clearCookie(previous,{path:'/'});
 }
 next();
});
app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','no-store');if(req.method!=='GET'){const origin=req.get('origin');const allowed=new Set(['https://thelastvote.ai-ve.uk',`http://127.0.0.1:${process.env.PORT||8682}`,`http://127.0.0.1.sslip.io:${process.env.PORT||8682}`,'http://localhost:5173','http://127.0.0.1:5173']);if(origin&&!allowed.has(origin))return res.status(403).json({error:'허용되지 않은 요청 출처입니다.'});if(req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'다른 사이트에서 보낸 요청은 허용되지 않습니다.'});}next();});
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
// Proxy headers are meaningful only when deployment explicitly trusts the tunnel.
const ip=req=>hashToken(process.env.TRUST_CLOUDFLARE==='1'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)?req.get('cf-connecting-ip')||req.socket.remoteAddress:req.socket.remoteAddress||'unknown');
const currentUser=req=>{if(demoEnabled){const demo=store.resolve(req.cookies.thelastvote_demo_session);if(demo?.role==='demo')return demo;}const user=store.resolve(req.cookies.thelastvote_session);return user?.role==='demo'&&!demoEnabled?null:user;};
app.use((req,res,next)=>{if(!demoEnabled&&req.cookies.thelastvote_demo_session)res.clearCookie('thelastvote_demo_session',{path:'/'});next();});
app.use(['/api/demo','/demo'],(req,res,next)=>{if(demoEnabled)return next();res.setHeader('Cache-Control','no-store');if(req.path==='/entry.js')return res.status(410).type('application/javascript').send('// Hackathon demo retired.');if(req.originalUrl.startsWith('/api/'))return res.status(410).json({error:'해커톤 시연이 종료됐습니다. 일반 계정으로 접속하세요.'});res.status(410).type('html').send('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Last Vote</title><body><h1>시연이 종료됐습니다</h1><p>일반 계정으로 게임을 이어갈 수 있습니다.</p><a href="/">게임으로 이동</a></body></html>');});
const auth=(req,res,next)=>{req.user=currentUser(req);if(!req.user)return res.status(401).json({error:'로그인이 필요합니다.'});next();};
const safeUser=u=>({username:u.username,role:u.role,profile:store.profile(store.userById(u.id))});
const authSchema=z.object({username:z.string().regex(/^[a-zA-Z0-9_]{3,24}$/),password:z.string().min(8).max(128)}).strict();
app.get('/api/health',(req,res)=>res.json({ok:true,ai:{mode:ai.status.mode},queue:aiQueue.snapshot(),version:'1.0.2'}));
app.get('/api/catalog',(req,res)=>res.json({council:COUNCIL,modules:MODULES,masks:MASKS,phases:PHASE_LABELS,zones:ZONES,tactics:TACTICS,demoEnabled}));
app.get('/api/me',(req,res)=>{const user=currentUser(req);res.json({user:user?safeUser(user):null});});
app.post('/api/register',asyncRoute(async(req,res)=>{if(!store.throttle('register:'+ip(req),5,3600000))throw new engine.GameError('가입 요청이 많습니다. 잠시 후 다시 시도하세요.',429);const body=authSchema.parse(req.body);if(body.password.length<10)throw new engine.GameError('비밀번호는 10자 이상 입력하세요.');if(['demo','admin','judge'].includes(body.username.toLowerCase()))throw new engine.GameError('예약된 아이디입니다.');let user;try{user=await store.createUser(body.username.toLowerCase(),body.password);}catch(e){if(String(e.code).includes('SQLITE'))throw new engine.GameError('이미 사용 중인 아이디입니다.',409);throw e;}setSession(req,res,user);res.status(201).json({user:safeUser(user)});}));
function writeSession(req,res,user,name){const token=store.session(user);res.cookie(name,token,cookieOptions(req));return token;}
function setSession(req,res,user){writeSession(req,res,user,'thelastvote_session');if(req.cookies.thelastvote_demo_session){store.logout(req.cookies.thelastvote_demo_session);res.clearCookie('thelastvote_demo_session',{path:'/'});}}
app.post('/api/demo/login',asyncRoute(async(req,res)=>{
 const current=currentUser(req);if(current?.role==='demo')return res.json({user:safeUser(current)});
 if(!store.throttle('demo-entry:'+ip(req),600,600000))throw new engine.GameError('시연 접속이 많습니다. 잠시 후 다시 시도하세요.',429);
 const demo=await store.demoUser();writeSession(req,res,demo,'thelastvote_demo_session');res.json({user:safeUser(demo)});
}));
app.post('/api/login',asyncRoute(async(req,res)=>{if(!store.throttle('login-burst:'+ip(req),120,600000)||store.blocked('login-failed:'+ip(req),15))throw new engine.GameError('로그인 시도가 많습니다. 10분 뒤 다시 시도하세요.',429);const {username,password}=authSchema.parse(req.body);const user=await store.login(username.toLowerCase(),password);if(!user){store.throttle('login-failed:'+ip(req),15,600000);throw new engine.GameError('아이디 또는 비밀번호를 확인하세요.',401);}if(user.role==='demo'&&!demoEnabled)throw new engine.GameError('해커톤 시연이 종료됐습니다. 일반 계정으로 접속하세요.',410);setSession(req,res,user);res.json({user:safeUser(user)});}));
app.post('/api/demo',asyncRoute(async(req,res)=>{
 z.object({}).strict().parse(req.body);
 let session=currentUser(req);
 if(session?.role!=='demo'){
  if(!store.throttle('demo-entry:'+ip(req),600,600000))throw new engine.GameError('시연 접속이 많습니다. 잠시 후 다시 시도하세요.',429);
  const user=await store.demoUser();session=store.resolve(writeSession(req,res,user,'thelastvote_demo_session'));
 }
 if(locks.has(session.owner))throw new engine.GameError('이전 선택을 처리하고 있습니다.',409);
 let g=store.game(session.owner);
 if(!g||g.phase==='ended'){
  if(!store.throttle('start:'+session.owner,20,86400000))throw new engine.GameError('오늘 생성 가능한 판 수를 모두 사용했습니다.',429);
  const profile=store.profile(store.userById(session.id));g=engine.newGame({demo:true,scenario:0,mask:'scribe',tier:1,seed:'demo-0',memory:profile.memory});
 }else{engine.migrateGameDuration(g);engine.migrateTutorialMission(g);if(['discussion','operation'].includes(g.phase)&&!g.missionZone)engine.ensureMissionZone(g);}
 store.save(session.owner,g);res.json({user:safeUser(session),game:engine.publicGame(g),ai:ai.statusFor(g)});
}));
app.post('/api/logout',auth,(req,res)=>{const name=demoEnabled&&store.resolve(req.cookies.thelastvote_demo_session)?.role==='demo'?'thelastvote_demo_session':'thelastvote_session';store.logout(req.cookies[name]);res.clearCookie(name,{path:'/'});res.json({ok:true});});
app.get('/api/game',auth,(req,res)=>{const g=store.game(req.user.owner);if(g){const durationChanged=engine.migrateGameDuration(g);const siteChanged=engine.migrateTutorialMission(g);const missionChanged=['discussion','operation'].includes(g.phase)&&!g.missionZone&&engine.ensureMissionZone(g);if(durationChanged||siteChanged||missionChanged)store.save(req.user.owner,g);if(g.phase==='ended')store.complete(req.user,g);}res.json({game:g?engine.publicGame(g):null,user:safeUser(req.user),ai:ai.statusFor(g)});});
app.get('/api/leaderboard',auth,(req,res)=>res.json({rows:store.leaderboard(),period:'최근 7일 · 일일 도전 구출 인원 합계'}));
app.get('/api/records/export',auth,(req,res)=>{const g=store.game(req.user.owner);if(!g)return res.status(404).json({error:'진행 기록이 없습니다.'});res.setHeader('Content-Disposition','attachment; filename="the-last-vote-run.json"');res.json({game:engine.publicGame(g),exportedAt:new Date().toISOString()});});
app.post('/api/game/start',auth,asyncRoute(async(req,res)=>{
 if(locks.has(req.user.owner))throw new engine.GameError('이전 선택을 처리하고 있습니다.',409);
 const b=z.object({mask:z.enum(['scribe','mechanic','translator','gambler']).default('scribe'),scenario:z.number().int().min(0).max(1).default(0),daily:z.boolean().default(false)}).strict().parse(req.body);
 const prev=store.game(req.user.owner);if(prev&&prev.phase!=='ended')throw new engine.GameError('진행 중인 판을 이어 하거나 철수하세요.',409);
 if(!store.throttle('start:'+(req.user.role==='demo'?req.user.owner:req.user.id),20,86400000))throw new engine.GameError('오늘 생성 가능한 판 수를 모두 사용했습니다.',429);
 const profile=store.profile(store.userById(req.user.id));const demo=req.user.role==='demo';if(!demo&&MASKS.find(m=>m.id===b.mask).unlock>profile.runs)throw new engine.GameError('아직 해금하지 않은 가면입니다.',403);
 if(b.daily&&store.dailyPlayed(req.user.id))throw new engine.GameError('오늘의 도전 기록은 이미 제출됐습니다. 내일 다시 도전하세요.',409);
 if(b.daily&&(b.mask!=='scribe'||demo))throw new engine.GameError('일일 도전은 일반 계정의 서기 가면으로 참여합니다.');
 const challengeDay=b.daily?kstDay():null;const g=engine.newGame({demo,challengeDay,mask:demo?'scribe':b.mask,scenario:demo?0:b.scenario,tier:b.daily?1:profile.tier,daily:b.daily,seed:demo?'demo-0':b.daily?`daily-${challengeDay}`:randomUUID(),memory:profile.memory});store.save(req.user.owner,g);res.json({game:engine.publicGame(g),ai:ai.statusFor(g)});
}));
const actionSchema=z.object({runId:z.string().uuid(),requestId:z.string().uuid(),action:z.enum(['begin','opening','event','talk','prepare','search','verdict','reward','module','reroll','draft','archive','abandon']),version:z.number().int().nonnegative(),text:z.string().trim().min(3).max(600).optional(),target:z.string().max(30).optional(),module:z.string().max(30).optional(),plan:z.string().max(30).optional(),vote:z.boolean().optional(),intent:z.string().max(100).optional()}).strict();
app.post('/api/game/action',auth,asyncRoute(async(req,res)=>{
 const b=actionSchema.parse(req.body);const owner=req.user.owner;
 if(locks.has(owner))throw new engine.GameError('이전 선택을 처리하고 있습니다.',409);
 const fingerprint=hashToken(JSON.stringify(b));
 const previous=store.action(owner,b.requestId),current=store.game(owner);
 if(!current||current.id!==b.runId)throw new engine.GameError('이전 잠입의 요청입니다. 현재 기록을 다시 불러오세요.',409);
 if(previous){
  if(previous.fingerprint!==fingerprint)throw new engine.GameError('이미 사용된 요청 번호입니다. 현재 기록을 확인하세요.',409);
  if(previous.status==='done')return res.json({...previous.response,game:engine.publicGame(current),ai:ai.statusFor(current),user:safeUser(req.user)});
  throw new engine.GameError('중단되거나 처리 중인 요청입니다. 현재 기록을 확인한 뒤 다시 선택하세요.',409);
 }
 if(!store.throttle('actions:'+owner,35,60000))throw new engine.GameError('입력이 너무 빠릅니다. 잠시 후 다시 시도하세요.',429);
 const g=store.game(owner);if(!g)throw new engine.GameError('먼저 잠입을 시작하세요.',404);const durationChanged=engine.migrateGameDuration(g);const siteChanged=engine.migrateTutorialMission(g);if(durationChanged||siteChanged)store.save(owner,g);if(g.phase==='ended'){store.complete(req.user,g);return res.json({game:engine.publicGame(g),ai:ai.statusFor(g),user:safeUser(req.user)});}if(['discussion','operation'].includes(g.phase)&&!g.missionZone)engine.ensureMissionZone(g);if(g.version!==b.version)throw new engine.GameError('다른 창에서 진행됐습니다. 현재 기록을 다시 불러옵니다.',409);
 locks.add(owner);let drafts,started=false;
 try{
  const execute=async()=>{
  // Mark before any provider work, so a crash never silently replays that request.
  store.beginAction(owner,b.requestId,g.id,fingerprint);started=true;
  switch(b.action){
   case 'begin':engine.beginDiscussion(g);break;
   case 'opening':engine.requirePhase(g,'discussion');await ai.opening(owner,g);break;
   case 'event':engine.resolveEvent(g,b.target);break;
   case 'talk':{if(!b.text)throw new engine.GameError('발언을 입력하세요.');const rec=engine.addSpeech(g,b.text);await ai.discuss(owner,g,rec);break;}
   case 'prepare':engine.prepareOperation(g);break;
   case 'search':engine.requirePhase(g,'operation');if(!TACTICS.some(t=>t.id===b.plan))throw new engine.GameError('작전 방식을 선택하세요.');await ai.operation(owner,g,b.plan);break;
   case 'verdict':engine.requirePhase(g,'verdict');if(b.text){const rec=engine.defendRecord(g,b.text);await ai.assess(owner,g,rec);}await ai.verdict(owner,g,b.vote);break;
   case 'reward':engine.takeReward(g,b.module);break;
   case 'module':engine.useModule(g,b.module,b.target);break;
   case 'reroll':engine.reroll(g);break;
   case 'draft':engine.requirePhase(g,'discussion','verdict');if(g.eveCalls>=4)throw new engine.GameError('오늘의 EVE 초안을 모두 사용했습니다. 직접 입력으로 이어가세요.');drafts=await ai.drafts(owner,g,b.intent||'작전 목표 강조');break;
   case 'archive':engine.openArchive(g);break;
   case 'abandon':engine.abandon(g);break;
  }
  g.version++;store.complete(req.user,g);
  const response={game:engine.publicGame(g),drafts,ai:ai.statusFor(g),user:safeUser(req.user)};
  store.commitAction(owner,b.requestId,g,response);res.json(response);
  };
  if(['opening','talk','search','verdict','draft'].includes(b.action))await aiQueue.run(()=>ai.withAction(b.requestId,execute));else await execute();
 }catch(error){
  // Invalid rule actions have made no durable game mutation and can be corrected.
  if(started&&error instanceof engine.GameError)store.failAction(owner,b.requestId);
  throw error;
 }finally{locks.delete(owner);}
}));
// Commit a same-origin page before requesting a session: Strict cookies are absent on
// the first navigation from a presentation or QR link, but present in this POST.
app.get('/demo',(req,res)=>{res.setHeader('Cache-Control','no-store, no-transform');res.type('html').send('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Last Vote · 시연 입장</title><script src="/demo/entry.js" defer></script></head><body style="background:#141513;color:#e6e2d8;font-family:system-ui,sans-serif;max-width:40rem;margin:20vh auto;padding:2rem"><h1>The Last Vote</h1><p id="status" role="status">3일 시연을 준비하고 있습니다.</p><noscript>시연에 입장하려면 브라우저에서 JavaScript를 허용해주세요.</noscript><a href="/" style="color:#dfad65">게임 홈으로</a></body></html>');});
app.get('/demo/entry.js',(req,res)=>{res.setHeader('Cache-Control','no-store');res.type('application/javascript').send("(async()=>{try{const response=await fetch('/api/demo/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});const data=await response.json();if(!response.ok)throw new Error(data.error||'시연에 접속하지 못했습니다.');location.replace('/');}catch(error){document.getElementById('status').textContent=error.message+' 새로고침해 다시 시도해주세요.';}})();");});
app.use(express.static(staticDir,{index:false,maxAge:'1h',setHeaders:(res,path)=>{if(path.includes('/assets/'))res.setHeader('Cache-Control','public, max-age=31536000, immutable');}}));
app.get('/{*path}',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'경로를 찾을 수 없습니다.'});res.setHeader('Cache-Control','no-cache, no-transform');res.sendFile(join(staticDir,'index.html'));});
app.use((err,req,res,next)=>{if(err instanceof z.ZodError)return res.status(400).json({error:'입력 형식을 확인하세요. 최신 화면에서 다시 시도하세요.'});if(err instanceof engine.GameError){if(err.status===503||err.status===429)res.setHeader('Retry-After','5');return res.status(err.status).json({error:err.message});}if(err.type==='entity.too.large')return res.status(413).json({error:'입력 크기가 제한을 넘었습니다.'});if(err.type==='entity.parse.failed')return res.status(400).json({error:'JSON 요청 형식을 확인하세요.'});if(err.type==='encoding.unsupported')return res.status(415).json({error:'압축된 요청은 지원하지 않습니다.'});console.error('request_error',{type:err?.name,code:err?.code||'unknown'});res.status(500).json({error:'요청을 마치지 못했습니다. 잠시 후 다시 시도하세요.'});});
const server=app.listen(Number(process.env.PORT||8682),process.env.HOST||'127.0.0.1',()=>console.log('The Last Vote listening'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
