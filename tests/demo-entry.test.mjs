import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../server/store.mjs';

async function unusedPort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('공개 시연 링크: 자동 로그인, 브라우저별 격리, 재방문 보존과 일반 계정 복귀',{timeout:40000},async()=>{
 const base=process.env.TEST_PRIVATE_DIR||join(homedir(),'vault/thelastvote/tests');mkdirSync(base,{recursive:true,mode:0o700});
 const dir=mkdtempSync(join(base,'demo-entry-')),port=await unusedPort(),origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,AI_OFFLINE:'1',ENABLE_HACKATHON_DEMO:'1'},stdio:'pipe'});
 let ready='';child.stdout.on('data',chunk=>ready+=chunk);child.stderr.on('data',()=>{});
 const request=async(path,{body,cookie='',headers={}}={})=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',cookie,Origin:origin,...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();return {status:response.status,headers:response.headers,body:response.headers.get('content-type')?.includes('json')?JSON.parse(text):text,cookie:response.headers.getSetCookie().find(v=>!v.includes('Expires=Thu, 01 Jan 1970'))?.split(';')[0]};};
 try{
  for(let i=0;i<100&&!ready.includes('listening');i++)await new Promise(resolve=>setTimeout(resolve,50));assert.match(ready,/The Last Vote listening/);
  const landing=await request('/demo',{headers:{Origin:'https://slides.example','Sec-Fetch-Site':'cross-site'}});
  assert.equal(landing.status,200);assert.match(landing.body,/src="\/demo\/entry\.js"/);assert.equal(landing.headers.get('cache-control'),'no-store, no-transform');assert.equal(landing.headers.get('set-cookie'),null);
  assert.ok(!landing.headers.get('content-security-policy').includes('upgrade-insecure-requests'));
  const script=await request('/demo/entry.js');assert.match(script.body,/fetch\('\/api\/demo\/login'/);assert.match(script.body,/method:'POST'/);assert.equal(script.headers.get('cache-control'),'no-store');
  const initial=new Store(dir);assert.equal(initial.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);initial.db.close();
  assert.equal((await request('/api/demo/login',{body:{},headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await request('/api/demo/login',{body:{},headers:{Origin:'https://thelastvote.ai-ve.uk','Sec-Fetch-Site':'cross-site'}})).status,403);

  const a=await request('/api/demo/login',{body:{role:'admin',days:7},headers:{Origin:'https://thelastvote.ai-ve.uk','X-Forwarded-Proto':'https'}});
  const b=await request('/api/demo/login',{body:{},headers:{Origin:'https://thelastvote.ai-ve.uk'}});
  assert.equal(a.status,200);assert.equal(a.body.user.role,'demo');assert.equal(a.body.user.username,'demo');assert.equal(b.status,200);assert.notEqual(a.cookie,b.cookie);
  assert.match(a.cookie,/^thelastvote_demo_session=/);assert.match(a.headers.get('set-cookie'),/HttpOnly/);assert.match(a.headers.get('set-cookie'),/SameSite=Strict/);assert.match(a.headers.get('set-cookie'),/Secure/);
  let g=(await request('/api/game/start',{body:{mask:'gambler'},cookie:a.cookie})).body.game;
  assert.equal(g.demo,true);assert.equal(g.days,3);assert.equal(g.mask,'scribe');assert.equal((await request('/api/game',{cookie:b.cookie})).body.game,null);
  const demoLayout={zones:g.zones,council:g.council,radioZone:g.radioZone,story:g.story};
  const alternate=(await request('/api/game/start',{body:{scenario:1,mask:'mechanic'},cookie:b.cookie})).body.game;
  assert.equal(alternate.scenario,0);assert.equal(alternate.mask,'scribe');assert.deepEqual({zones:alternate.zones,council:alternate.council,radioZone:alternate.radioZone,story:alternate.story},demoLayout);
  const resumed=await request('/api/demo/login',{body:{},cookie:a.cookie});assert.equal(resumed.status,200);assert.equal(resumed.headers.get('set-cookie'),null);assert.equal((await request('/api/game',{cookie:a.cookie})).body.game.id,g.id);
  const inspector=new Store(dir);assert.notEqual(inspector.resolve(a.cookie.split('=')[1]).owner,inspector.resolve(b.cookie.split('=')[1]).owner);assert.equal(inspector.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username='demo'").get().n,1);inspector.db.close();

  const act=async(action,extra={})=>{const response=await request('/api/game/action',{body:{action,runId:g.id,requestId:randomUUID(),version:g.version,...extra},cookie:a.cookie});assert.equal(response.status,200,JSON.stringify(response.body));g=response.body.game;return response;};
  for(let day=1;day<=3;day++){
   await act('begin');const zone='rush';
   if(day===1){const drafts=await act('draft',{intent:'작전 효율 검증'});assert.ok(drafts.body.drafts.drafts.every(text=>text.length>0));}
   await act('talk',{text:`${day}일차 신호의 불일치를 공동 검증할 것을 제안합니다.`});
   await act('prepare');await act('search',{plan:zone});await act('verdict',{vote:false,text:'공동 검증에 동의한 공식 발의와 지지표를 확인하십시오.'});
   if(g.phase==='ended')break;await act('reward',{module:g.offers.includes('forge')?'forge':g.offers[0]});
  }
  assert.equal(g.phase,'ended');assert.equal(g.days,3);assert.equal(g.usage.costUsd,0);
  const repeated=(await request('/api/game/start',{body:{scenario:1},cookie:a.cookie})).body.game;
  assert.deepEqual({zones:repeated.zones,council:repeated.council,radioZone:repeated.radioZone,story:repeated.story},demoLayout);
  const exported=await request('/api/records/export',{cookie:a.cookie});assert.match(exported.headers.get('content-disposition'),/the-last-vote-run\.json/);
  // More than the failed-password limit can enter from one event network.
  for(let i=0;i<25;i++){const visitor=await request('/api/demo/login',{body:{}});assert.equal(visitor.status,200);assert.equal((await request('/api/game/start',{body:{},cookie:visitor.cookie})).status,200);}

  const player=await request('/api/register',{body:{username:'preview_player',password:randomBytes(20).toString('hex')}});assert.equal(player.status,201);
  const ordinary=(await request('/api/game/start',{body:{},cookie:player.cookie})).body.game;assert.equal(ordinary.days,3);
  const preview=await request('/api/demo/login',{body:{},cookie:player.cookie});assert.equal(preview.status,200);assert.ok(!preview.headers.getSetCookie().some(value=>value.startsWith('thelastvote_session=')));
  const combined=player.cookie+'; '+preview.cookie;
  assert.equal((await request('/api/me',{cookie:combined})).body.user.role,'demo');assert.equal((await request('/api/game/start',{body:{daily:true},cookie:combined})).status,400);
  assert.equal((await request('/api/game/start',{body:{},cookie:combined})).body.game.days,3);
  const logout=await request('/api/logout',{body:{},cookie:combined});assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/^thelastvote_demo_session=;/);
  assert.equal((await request('/api/me',{cookie:combined})).body.user.role,'player');assert.equal((await request('/api/game',{cookie:player.cookie})).body.game.id,ordinary.id);
 }finally{
  if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
  rmSync(dir,{recursive:true,force:true});
 }
});

test('demo 이름을 가진 일반 계정의 권한을 자동 변경하지 않음',async()=>{
 const base=process.env.TEST_PRIVATE_DIR||join(homedir(),'vault/thelastvote/tests');mkdirSync(base,{recursive:true,mode:0o700});const dir=mkdtempSync(join(base,'demo-role-')),store=new Store(dir);
 try{const user=await store.createUser('demo',randomBytes(20).toString('hex'),'player');await assert.rejects(store.demoUser(),/demo_account_role_mismatch/);assert.equal(store.userById(user.id).role,'player');}
 finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
