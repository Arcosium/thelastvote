import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {randomBytes,randomUUID} from 'node:crypto';

test('HTTP 인증, 시연 격리, 권한 상승 방지, 동시 요청과 시연 완주',{timeout:40000},async()=>{
 const base=process.env.TEST_PRIVATE_DIR||'/home/arcosium/vault/thelastvote/tests';mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'api-'));const store=new Store(dir);const password=randomBytes(16).toString('hex');await store.createUser('demo',password,'demo');store.db.close();
 const port=18682;const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),DATA_DIR:dir,AI_OFFLINE:'1',ENABLE_HACKATHON_DEMO:'1'},stdio:'pipe'});let ready='';child.stdout.on('data',s=>ready+=s);child.stderr.on('data',()=>{});
 const req=async(path,body,cookie='',headers={})=>{const r=await fetch(`http://127.0.0.1:${port}/api/${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',cookie,...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 try{for(let i=0;i<100&&!ready.includes('listening');i++)await new Promise(r=>setTimeout(r,50));assert.match(ready,/listening/);
 assert.equal((await req('game')).status,401);assert.equal((await req('register',{username:'demo',password})).status,400);
 const a=await req('login',{username:'demo',password}),b=await req('login',{username:'demo',password});assert.equal(a.status,200);assert.notEqual(a.cookie,b.cookie);
 assert.equal((await req('game/start',{days:7},a.cookie)).status,400);assert.equal((await req('game/start',{mask:'mechanic'},a.cookie)).body.game.mask,'scribe');
 assert.equal((await req('game',null,b.cookie)).body.game,null);assert.equal((await req('game/start',{},b.cookie)).body.game.days,3);
 let g=(await req('game',null,a.cookie)).body.game;assert.equal((await req('game/action',{action:'begin',version:g.version},a.cookie,{Origin:'https://evil.example'})).status,403);
 const act=async(action,extra={})=>{const r=await req('game/action',{action,runId:g.id,requestId:randomUUID(),version:g.version,...extra},a.cookie);assert.equal(r.status,200,JSON.stringify(r.body));g=r.body.game;return r;};
 for(let day=1;day<=3;day++){
  await act('begin');const chosen='rush';await act('talk',{text:`센서 오차를 공동 검증하기 위해 ${day}일차 ${chosen} 수색을 제안합니다.`});
  assert.equal((await req('game/action',{action:'prepare',runId:g.id,requestId:randomUUID(),version:g.version-1},a.cookie)).status,409);
  await act('prepare');await act('search',{plan:chosen});assert.equal(g.phase,'verdict');await act('verdict',{vote:false,text:'합의된 신호를 검증했습니다. 공식 투표 기록을 확인하십시오.'});
  if(g.phase==='ended')break;assert.equal(g.phase,'reward');await act('reward',{module:g.offers.includes('forge')?'forge':g.offers[0]});
 }
 assert.equal(g.phase,'ended');assert.equal(g.days,3);assert.equal(g.usage.costUsd,0);assert.ok(g.usage.fallbacks>0);assert.equal((await req('game',null,b.cookie)).body.game.phase,'report');
 const signup=await req('register',{username:'ordinary_player',password});assert.equal(signup.status,201);assert.equal((await req('game/start',{},signup.cookie)).body.game.days,3);assert.equal((await req('game/start',{mask:'gambler'},signup.cookie)).status,409);

 // A shared demo account must not exhaust one global start quota at an event.
 for(let i=0;i<22;i++){const fresh=await req('login',{username:'demo',password});assert.equal(fresh.status,200);assert.equal((await req('game/start',{},fresh.cookie)).status,200);}
 // Export is subject to the same archive projection as the game endpoint.
 const fixture=new Store(dir),bu=fixture.resolve(b.cookie.split('=')[1]),bg=fixture.game(bu.owner);bg.day=2;bg.records.push({id:'TEST2',day:2,type:'report',text:'fixture'});fixture.save(bu.owner,bg);fixture.db.close();
 assert.ok((await req('records/export',null,b.cookie)).body.game.records.every(r=>r.day===2));
 const invalidPassword=randomBytes(16).toString('hex');
 for(let i=0;i<15;i++)assert.equal((await req('login',{username:'demo',password:invalidPassword})).status,401);
 assert.equal((await req('login',{username:'demo',password:invalidPassword})).status,429);
 await req('logout',{},a.cookie);assert.equal((await req('game',null,a.cookie)).status,401);
 }finally{child.kill('SIGTERM');await new Promise(r=>child.on('exit',r));rmSync(dir,{recursive:true,force:true});}
});
