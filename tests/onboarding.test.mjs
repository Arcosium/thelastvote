import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {randomUUID,randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import * as e from '../server/engine.mjs';
import {GameAI} from '../server/ai.mjs';

test('첫날 개막은 AI를 호출하지 않고 즉시 세 위원의 대사를 제공',async()=>{
 const g=e.newGame({}),service=new GameAI({});service.withProject=()=>{throw new Error('must not call AI');};e.beginDiscussion(g);
 const before=g.messages.length;await service.opening('test',g);assert.equal(g.messages.length,before+3);assert.equal(g.openingDone,true);assert.equal(g.usage.fallbacks,0);assert.equal(g.usage.requests,0);
 await service.opening('test',g);assert.equal(g.messages.length,before+3);
});
test('대체 비율은 절반 초과만 제외하고 하루별 첫 발언 이벤트를 한 번만 저장',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tlv-store-')),s=new Store(dir);
 try{
  const u=await s.createUser('ratio_player',randomBytes(20).toString('hex'));u.owner=u.id;
  for(const [fallbacks,turns,expected] of [[1,4,true],[2,4,true],[3,4,false],[0,0,true]]){
   const g=e.newGame({daily:true});g.usage.turns=turns;g.usage.fallbacks=fallbacks;assert.equal(e.publicGame(g).fallbackStats.eligible,expected);e.endGame(g,'escape');s.complete(u,g);assert.equal(s.db.prepare('SELECT eligible FROM scores WHERE run=?').get(g.id).eligible,Number(expected));
  }
  const g=e.newGame({});s.recordEvent(u.id,g,'first_speech');s.recordEvent(u.id,g,'first_speech');g.day=2;s.recordEvent(u.id,g,'first_speech');assert.equal(s.db.prepare('SELECT COUNT(*) n FROM game_events').get().n,2);
 }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('실제 HTTP: 첫 판·안내 소유권·즉시 개막·이벤트·비밀번호 재확인 삭제',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tlv-http-')),socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,DATA_DIR:dir,PORT:String(port),AI_OFFLINE:'1'},stdio:'pipe'});let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',()=>{});
 const request=async(path,body,cookie='',method)=>{const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',cookie},body:body?JSON.stringify(body):undefined});return {status:r.status,body:r.headers.get('content-type')?.includes('json')?await r.json():await r.text(),cookie:r.headers.getSetCookie()[0]?.split(';')[0]};};
 try{
  for(let i=0;i<100&&!output.includes('listening');i++)await new Promise(r=>setTimeout(r,40));assert.match(output,/listening/);
  const password=randomBytes(20).toString('hex'),u=await request('/api/register',{username:'onboarding_test',password}),cookie=u.cookie;
  const start=await request('/api/game/start',{},cookie);assert.equal(start.status,200);let g=start.body.game;assert.equal(start.body.user.profile.tutorial.runId,g.id);
  const other=await request('/api/register',{username:'another_test',password});assert.equal((await request('/api/tutorial',{runId:g.id,action:'seen',step:'briefing'},other.cookie)).status,409);
  assert.equal((await request('/api/tutorial',{runId:g.id,action:'seen',step:'invalid'},cookie)).status,400);
  for(let i=0;i<2;i++)assert.equal((await request('/api/tutorial',{runId:g.id,action:'seen',step:'briefing'},cookie)).status,200);
  assert.deepEqual((await request('/api/me',null,cookie)).body.user.profile.tutorial.seen,['briefing']);assert.equal((await request('/api/game',null,cookie)).body.game.version,g.version);
  const act=async(action,extra={},requestId=randomUUID())=>request('/api/game/action',{runId:g.id,requestId,version:g.version,action,...extra},cookie);
  const before=performance.now(),begin=await act('begin');assert.equal(begin.status,200);assert.ok(performance.now()-before<1000);g=begin.body.game;assert.equal(g.openingDone,true);assert.equal(g.usage.requests,0);
  const id=randomUUID(),speech=await act('talk',{text:'정문으로 진입하는 빠른 작전을 제안합니다.'},id);assert.equal(speech.status,200);const repeated=await act('talk',{text:'정문으로 진입하는 빠른 작전을 제안합니다.'},id);assert.equal(repeated.status,200);g=speech.body.game;
  assert.equal((await request('/api/tutorial',{runId:g.id,action:'skip'},cookie)).status,200);assert.equal((await request('/api/me',null,cookie)).body.user.profile.tutorial.status,'skipped');
  const abandoned=await act('abandon');assert.equal(abandoned.status,200);g=abandoned.body.game;
  const s=new Store(dir),user=s.db.prepare("SELECT id FROM users WHERE username='onboarding_test'").get();assert.equal(s.db.prepare("SELECT COUNT(*) n FROM game_events WHERE event='first_speech'").get().n,1);
  assert.ok(!output.includes('정문으로 진입하는'));const secondSession='thelastvote_session='+s.session(s.userById(user.id));assert.equal(s.db.prepare('SELECT COUNT(*) n FROM scores WHERE user_id=?').get(user.id).n,1);s.recordUsage(user.id,g.id,{operationId:'delete-usage',costUsd:.01,costStatus:'reported',tokens:{total:5}});s.beginAIInput({id:'delete-input',owner:user.id,run:g.id,agent:'hound',instance:'test',day:1,phase:'discussion'});s.reserveAI(user.id,g.id,.01);s.db.close();
  const storage=join(dir,'croche',user.id);mkdirSync(storage,{recursive:true});writeFileSync(join(storage,'test.json'),'{}');
  assert.equal((await request('/api/account/delete',{password:password+'-invalid'},cookie)).status,403);assert.ok(existsSync(storage));
  assert.equal((await request('/api/account/delete',{password},cookie)).status,200);assert.equal(existsSync(storage),false);
  assert.equal((await request('/api/game',null,secondSession)).status,401);assert.equal((await request('/api/login',{username:'onboarding_test',password})).status,401);
  const check=new Store(dir);for(const table of ['runs','actions','game_events','usage','usage_details','ai_inputs','ai_reservations','scores'])assert.equal(check.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);assert.equal(check.db.prepare('SELECT COUNT(*) n FROM users').get().n,1);assert.equal(check.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(user.id).n,0);check.db.close();
  const policy=await request('/privacy');assert.equal(policy.status,200);assert.match(policy.body,/원스토어 상품 페이지에 표시된 개발자 연락처/);assert.doesNotMatch(policy.body,/登録予定|등록 예정/);
 }finally{if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}rmSync(dir,{recursive:true,force:true});}
});


test('계정 삭제 후 개인정보 없이 날짜별 실제 비용과 미확정 예약액의 전체 예산을 유지',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tlv-delete-budget-')),s=new Store(dir);
 try{
  const u=await s.createUser('delete_budget','test-password-only');
  s.recordUsage(u.id,'private-run',{operationId:'private-op',costUsd:4.9,costStatus:'reported'});
  const reservation=s.reserveAI(u.id,'private-run',.08,{dayLimit:5,runLimit:10,userLimit:10});assert.ok(reservation);
  assert.equal(s.reserveAI('other','other-run',.03,{dayLimit:5}),null);
  s.deleteUser(u);assert.equal(s.dayCost(),4.9);
  const kept=s.db.prepare('SELECT * FROM deleted_usage').all();assert.equal(kept.length,1);assert.equal(kept[0].cost,4.9);assert.equal(kept[0].held,.08);assert.deepEqual(Object.keys(kept[0]).sort(),['cost','day','held']);
  assert.equal(s.reserveAI('other','other-run',.03,{dayLimit:5}),null);assert.ok(s.reserveAI('other','other-run',.01,{dayLimit:5}));
  for(const table of ['usage','ai_reservations'])assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE owner=?`).get(u.id).n,0);
 }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('과거 점수는 한 번만 이관하고 순위표 요청에서는 끝난 판을 재분석하지 않는다',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tlv-ratio-migration-'));let s=new Store(dir);
 try{
  const u=await s.createUser('old_ratio','test-password-only');u.owner=u.id;
  const g=e.newGame({daily:true});g.usage.turns=4;g.usage.fallbacks=1;e.endGame(g,'escape');s.complete(u,g);
  s.db.prepare('UPDATE scores SET eligible=0').run();s.db.prepare("DELETE FROM app_migrations WHERE name='fallback-ratio-v1'").run();s.db.close();s=new Store(dir);
  assert.equal(s.db.prepare('SELECT eligible FROM scores').get().eligible,1);
  s.refreshEligibility=()=>{throw new Error('must not scan at request time');};s.leaderboard();s.dailyPlayed(u.id);
  s.db.prepare('UPDATE scores SET eligible=0').run();s.db.close();s=new Store(dir);assert.equal(s.db.prepare('SELECT eligible FROM scores').get().eligible,0);
 }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});
