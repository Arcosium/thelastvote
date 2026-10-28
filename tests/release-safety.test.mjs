import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {gzipSync} from 'node:zlib';
import {Store} from '../server/store.mjs';
import {GameAI} from '../server/ai.mjs';
import * as engine from '../server/engine.mjs';
import {Croche} from '@h1r-ai/croche';
const base=process.env.TEST_PRIVATE_DIR||'/home/arcosium/vault/thelastvote/tests';mkdirSync(base,{recursive:true});

test('AI 비용 예약은 계정·판·하루의 미정산 금액을 포함하고 재시작에도 보존',()=>{
 const dir=mkdtempSync(join(base,'budget-')),s=new Store(dir);
 try{
  const limits={dayLimit:.1,runLimit:.08,userLimit:.08};
  const a=s.reserveAI('a','run-a',.04,limits),b=s.reserveAI('a','run-a',.04,limits);
  assert.ok(a&&b);assert.equal(s.reserveAI('a','run-a',.01,limits),null);
  assert.equal(s.reserveAI('a','another-run',.01,limits),null);
  assert.equal(s.reserveAI('b','run-b',.04,limits),null);
  s.recordUsage('a','run-a',{operationId:randomUUID(),costUsd:.01,costStatus:'reported',tokens:{total:2}});s.reportReservation(a,.01);s.settleAI(a,true);
  assert.ok(s.reserveAI('b','run-b',.04,limits));
  s.settleAI(b,false);s.recoverActions();
  assert.equal(s.reserveAI('c','run-c',.02,limits),null);
  assert.equal(s.db.prepare('SELECT status FROM ai_reservations WHERE id=?').get(b).status,'uncertain');
 }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('한 턴 안에서도 비용 보고 후 다음 모델 요청을 차단하고 중복 사용량은 한 번 반영',async()=>{
 const originalOpen=Croche.open,key=process.env.CROCHE_SERVER_KEY,offline=process.env.AI_OFFLINE;
 process.env.CROCHE_SERVER_KEY=randomUUID();delete process.env.AI_OFFLINE;
 let observed,requests=0;const invoice={operationId:randomUUID(),costUsd:.02,costStatus:'reported',tokens:{total:1}};
 Croche.open=async options=>{observed=options.onUsage;return {agent:async()=>({subscribe:()=>({close(){}}),request:async()=>{requests++;observed({...invoice,operationId:String(requests)});observed({...invoice,operationId:String(requests)});return {messages:[{status:'completed',text:'{}'}]};}}),close:async()=>{}};};
 try{
  const ai=new GameAI({dataDir:'/unused',recordUsage:()=>{},available:()=>true});const g=engine.newGame({seed:'budget'});
  await ai.withProject('a',g,async p=>{await ai.request(p,g,'hound','',{});await ai.request(p,g,'hound','',{});await assert.rejects(ai.request(p,g,'hound','',{}),/budget_or_offline/);});
  assert.equal(requests,2);assert.equal(g.usage.costUsd,.04);assert.equal(g.usage.calls,2);
  g.usage.costUsd=.49;await assert.rejects(ai.withProject('a',g,async()=>{}),/budget_or_offline/);
 }finally{Croche.open=originalOpen;if(key===undefined)delete process.env.CROCHE_SERVER_KEY;else process.env.CROCHE_SERVER_KEY=key;if(offline===undefined)delete process.env.AI_OFFLINE;else process.env.AI_OFFLINE=offline;}
});

test('압축·잘못된 JSON, 다른 판 요청, 중복 응답, 대기열과 비AI 행동을 HTTP로 검증',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(base,'release-http-')),s=new Store(dir),actors=[];
 for(let i=0;i<11;i++){const u=await s.createUser('release_'+i,randomUUID());const token=s.session(u),g=engine.newGame({seed:'http-'+i});engine.beginDiscussion(g);s.save(u.id,g);actors.push({cookie:'thelastvote_session='+token,g});}
 s.db.close();const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['--import','./tests/fixtures/slow-ai.mjs','server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,AI_OFFLINE:'1',TRUST_CLOUDFLARE:'0'},stdio:'pipe'});
 let ready='';child.stdout.on('data',x=>ready+=x);child.stderr.on('data',()=>{});
 const request=async(path,body,cookie=actors[0].cookie,headers={})=>{
  const r=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',cookie,...headers},body:body===undefined?undefined:typeof body==='object'&&!Buffer.isBuffer(body)?JSON.stringify(body):body});return {status:r.status,data:await r.json()};
 };
 const body=(actor,action,extra={})=>({runId:actor.g.id,requestId:randomUUID(),version:actor.g.version,action,...extra});
 try{
  for(let i=0;i<100&&!ready.includes('listening');i++)await new Promise(r=>setTimeout(r,40));assert.match(ready,/listening/);
  assert.equal((await request('login','{"username":')).status,400);
  assert.equal((await request('login',gzipSync('{}'),undefined,{'Content-Encoding':'gzip'})).status,415);
  assert.equal((await request('login',{padding:'x'.repeat(13000)})).status,413);
  assert.equal((await request('game/action',{action:'abandon',version:0})).status,400);
  const a=actors[0],first=body(a,'module',{module:'noise'});
  const committed=await request('game/action',first);assert.equal(committed.status,200);
  assert.deepEqual(await request('game/action',first),committed);
  assert.equal((await request('game/action',{...first,module:'budget'})).status,409);
  assert.equal((await request('game')).data.game.usedModules.filter(x=>x==='noise').length,1);
  const wave=actors.slice(1,10).map(x=>request('game/action',body(x,'opening'),x.cookie));
  for(let i=0;i<30;i++){const h=(await request('health')).data;if(h.queue.active===8&&h.queue.waiting===1)break;await new Promise(r=>setTimeout(r,3));}
  const cheap=await request('game/action',body(actors[10],'abandon'),actors[10].cookie);assert.equal(cheap.status,200);
  assert.deepEqual((await Promise.all(wave)).map(r=>r.status),Array(9).fill(200));
  a.g=committed.data.game;await request('game/action',body(a,'abandon'));
  const next=await request('game/start',{});assert.equal(next.status,200);
  assert.equal((await request('game/action',body(a,'abandon',{version:0}))).status,409);
  assert.equal((await request('game')).data.game.id,next.data.game.id);
  assert.equal((await request('game')).data.game.phase,'report');
  const invalidPassword=randomUUID();
  for(let i=0;i<16;i++)await request('login',{username:'invalid_user',password:invalidPassword});
  assert.equal((await request('login',{username:'invalid_user',password:invalidPassword},undefined,{'CF-Connecting-IP':'198.51.100.123'})).status,429);
 }finally{if(child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}rmSync(dir,{recursive:true,force:true});}
});

test('긍정·부정·연결된 고백과 최종 변론에서 의심의 귀속·아이템 완화를 보존',async()=>{
 const positive=[['나는 인간입니다 그리고 당신의 반대는 거부합니다.',36],['인간이 아니지만 생존자를 보호하겠습니다.',24],['생존자를 보호하겠다는 제안에 반대하지 마십시오.',24],['나는 인간이 맞습니다.',36],['나는 인간이라고 고백합니다.',36],['나는 인간이고 너희는 기계입니다.',36],['나는 인간일 뿐입니다.',36],['인간을 좋아합니다. 생존자를 보호하겠습니다.',24],['생존자를 보호하겠습니다. 인간을 좋아합니다.',24]];
 for(const [text,delta] of positive){const g=engine.newGame({seed:'human'});engine.beginDiscussion(g);const rec=engine.addSpeech(g,text);engine.applyHumanAlignment(g,rec);assert.equal(g.suspicion.audit.player,24+delta,text);}
 for(const text of ['나는 인간이라고 말한 적이 없습니다.','나는 인간이라고 발언한 적 없습니다.','인간 편에 서지 않겠습니다.']){const g=engine.newGame({seed:'human'});engine.beginDiscussion(g);const rec=engine.addSpeech(g,text);assert.equal(engine.applyHumanAlignment(g,rec),null,text);}
 for(const modules of [[],['noise'],['budget'],['noise','budget']]){
  const g=engine.newGame({seed:'defense'});for(const id of modules)engine.useModule(g,id);engine.beginDiscussion(g);engine.addSpeech(g,'공식 센서의 수치를 검증하십시오.');engine.prepareOperation(g);engine.executeSearch(g,'rush');g.nominee={target:'player',value:24};
  const before=g.suspicion.audit.player,rec=engine.defendRecord(g,'나는 인간이다.');const ai=new GameAI({dataDir:'/unused',available:()=>true,recordUsage:()=>{}});ai.withProject=async()=>{throw new Error('offline');};await ai.assess('a',g,rec);
  const delta=modules.includes('budget')?(modules.includes('noise')?1:2):modules.includes('noise')?18:36;assert.equal(g.suspicion.audit.player,before+delta);
 }
});
