import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,kstDay} from '../server/store.mjs';
import {GameAI,councilContext,councilRecords,alignedDrafts} from '../server/ai.mjs';
import * as e from '../server/engine.mjs';
const make=()=>e.newGame({demo:true,seed:'review'});
const speech=g=>{e.beginDiscussion(g);return e.addSpeech(g,'발전소의 신호를 공동 검증할 것을 제안합니다.','plant');};
const ai=()=>new GameAI({dataDir:'/unused',recordUsage:()=>{},available:()=>true});
test('위조는 공식 발의자를 바꾸며 프롬프트·조회 DTO에는 내부 표시가 없음',()=>{
 const g=make(),record=speech(g);g.modules=['forge'];e.useModule(g,'forge','hound');record.privateSecret='hidden';record.forged=true;
 const official=councilRecords(g).find(r=>r.id===record.id);assert.equal(official.author,'hound');assert.equal(official.forged,undefined);assert.equal(official.privateSecret,undefined);assert.equal(JSON.stringify(councilContext(g)).includes('hidden'),false);assert.ok(!councilRecords(g).some(r=>r.type==='module'));
 g.day=2;g.modules=['forge'];assert.throws(()=>e.useModule(g,'forge','audit'),/오늘 내/);assert.deepEqual(g.modules,['forge']);
});
test('가짜 센서는 현재 보고서와 AI 관측값에 일치하고 지난 보고서를 보존',()=>{
 const g=make(),old=structuredClone(g.records[0]);old.id='old';old.day=0;g.records.unshift(old);g.modules=['sensor'];e.useModule(g,'sensor',g.missionZone);const ctx=councilContext(g);assert.equal(ctx.zones.find(z=>z.id===g.missionZone).signal,98);assert.equal(ctx.records.find(r=>r.id===g.reportId).signals.find(z=>z.id===g.missionZone).signal,98);assert.notEqual(old.signals.find(z=>z.id===g.missionZone).signal,98);
});
test('공동 표결에 존재하지 않는 발의자를 지정하지 않음',()=>{
 const g=make();e.beginDiscussion(g);e.addSpeech(g,'전체 센서를 점검한 뒤 투표하겠습니다.');e.prepareOperation(g);for(const c of g.council)g.preferences[c.id]='rush';const row=e.executeSearch(g,'rush');assert.equal(row.author,'player');assert.equal(g.suspicion.audit.hound,23);assert.equal(g.suspicion.audit.player,38);assert.equal(g.operation.suspicionBefore,24);assert.equal(g.operation.suspicionAfter,38);
});
test('기록 열람 권한은 서버 직렬화에서 적용되고 종료 후 전체 공개',()=>{
 const g=make();g.day=2;e.evidence(g,'report','새 보고');assert.ok(e.publicGame(g).records.every(r=>r.day===2));e.openArchive(g);assert.ok(e.publicGame(g).records.some(r=>r.day===1));assert.throws(()=>e.openArchive(g));const other=make();other.mask='mechanic';other.day=2;other.archiveUsed=true;assert.equal(e.publicGame(other).records.length,0);assert.throws(()=>e.openArchive(other));e.endGame(other,'abandoned');assert.ok(e.publicGame(other).records.some(r=>r.day===1));
});
test('세 위원은 서로 기다리지 않고 병렬 응답하며 에코는 이전 의견을 읽음',async()=>{
 const g=make(),record=speech(g),service=ai(),started=[];service.withProject=async(o,g,fn)=>fn({});
 let release;const barrier=new Promise(resolve=>release=resolve);
 service.request=async(p,g,id,text,ctx)=>{started.push(id);if(id==='echo'){assert.ok(Array.isArray(ctx.priorRound));assert.equal(ctx.currentRound,undefined);}if(started.length===g.council.length)release();await Promise.race([barrier,new Promise((_,reject)=>setTimeout(()=>reject(new Error('serial council')),200))]);return JSON.stringify({text:'발전소 검증에 동의합니다.',plan:'rush',evaluations:[]});};
 await service.discuss('owner',g,record);assert.equal(started.length,3);assert.equal(g.usage.fallbacks,0);assert.equal(g.preferences.echo,'rush');assert.equal(g.lastFeedback.suspicionAfter,24);
});
test('누락된 도구 실행은 중복 대체 집계 없이 한 번만 서버 집행',async()=>{
 const g=make(),service=ai();service.withProject=async()=>{throw new Error('provider_down');};speech(g);e.prepareOperation(g);await service.operation('owner',g,'rush');assert.equal(g.usage.fallbacks,1);assert.equal(g.toolReceipts.length,1);await service.verdict('owner',g,false);assert.equal(g.usage.fallbacks,2);assert.equal(g.toolReceipts.length,2);
});
test('일일 도전은 시작일에 귀속되고 대체 진행은 순위 제외 및 재도전 허용',async()=>{
 const base=process.env.TEST_PRIVATE_DIR||'/home/arcosium/vault/thelastvote/tests';mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'scores-'));const store=new Store(dir);
 try{let user=await store.createUser('score_test','isolated-test-only');user={...user,owner:user.id};const yesterday=kstDay(Date.now()-86400000);const g=e.newGame({daily:true,challengeDay:yesterday});e.endGame(g,'escape');store.complete(user,g);assert.equal(store.db.prepare('SELECT day FROM scores WHERE run=?').get(g.id).day,yesterday);assert.equal(store.dailyPlayed(user.id),false);
 const fallback=e.newGame({daily:true,challengeDay:kstDay()});fallback.usage.fallbacks=1;e.endGame(fallback,'escape');store.complete(user,fallback);assert.equal(store.dailyPlayed(user.id),false);assert.equal(store.leaderboard()[0].score,g.rescued);
 const actual=e.newGame({daily:true,challengeDay:kstDay()});e.endGame(actual,'escape');store.complete(user,actual);assert.equal(store.dailyPlayed(user.id),true);assert.equal(store.leaderboard()[0].score,g.rescued+actual.rescued);store.complete(user,actual);assert.equal(store.profile(store.userById(user.id)).runs,3);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('이전 scores 스키마 마이그레이션은 데이터 보존 및 재실행 가능',()=>{
 const base=process.env.TEST_PRIVATE_DIR||'/home/arcosium/vault/thelastvote/tests';mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'migration-'));const db=new DatabaseSync(join(dir,'game.sqlite'));db.exec("CREATE TABLE scores(run TEXT PRIMARY KEY,user_id TEXT,rescued INTEGER,day TEXT,daily INTEGER);INSERT INTO scores VALUES('old','user',5,'2026-10-01',1)");db.close();
 try{for(let i=0;i<2;i++){const s=new Store(dir);assert.equal(s.db.prepare('SELECT eligible FROM scores WHERE run=?').get('old').eligible,1);s.db.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});

test('EVE는 작전 목표와 단계가 어긋나거나 비밀을 드러내는 초안을 제외',()=>{
 const base={goal:'covert_purge_argument'};
 const safe='구역별 확인을 통해 소거 누락을 줄이십시오.';
 assert.deepEqual(alignedDrafts({...base,drafts:[safe]},'discussion'),[safe]);
 for(const text of ['다른 구역을 수색합시다.','새로운 장소로 이동하십시오.','구역을 선택하십시오.','생존자를 구출하십시오.'])assert.deepEqual(alignedDrafts({...base,drafts:[text]},'discussion'),[]);
 assert.deepEqual(alignedDrafts({goal:'search_selected_zone',drafts:[safe]},'discussion'),[]);
 assert.deepEqual(alignedDrafts({...base,drafts:[safe]},'verdict'),[]);
 assert.deepEqual(alignedDrafts({goal:'defend_record',drafts:['발전소 우선 수색을 제안합니다.','R004의 발의 기록과 지지표를 대조하십시오.']},'verdict'),['R004의 발의 기록과 지지표를 대조하십시오.']);
});
test('EVE 야간 변론에는 이미 끝난 작전과 심의 대상이 전달되고 실패 초안도 변론 전용',async()=>{
 const g=make(),service=ai();speech(g);e.prepareOperation(g);e.executeSearch(g,'rush');service.withProject=async(o,g,fn)=>fn({});service.request=async(p,g,id,text,ctx)=>{assert.equal(ctx.goal,'defend_record');assert.equal(ctx.completedSearch.record,g.operation.record);assert.deepEqual(ctx.nominee,g.nominee);return JSON.stringify({goal:'search_selected_zone',zone:'plant',drafts:['발전소 우선 수색을 제안합니다.']});};
 const reply=await service.drafts('owner',g,'변론','plant');assert.equal(reply.source,'fallback');assert.equal(g.usage.fallbacks,1);assert.ok(reply.drafts.every(d=>!d.includes('우선 수색')&&d.includes(g.operation.record)));
});
test('공개 센서 비교는 서버에서 차이를 계산하고 동률 최대를 모두 표시',()=>{
 const g=make();g.zones.forEach((z,i)=>{z.signal=[33,46,40,41,40][i];z.audio=[40,49,46,49,42][i];});let facts=e.sensorFacts(g);assert.deepEqual(facts.rows.map(r=>r.deviation),[7,3,6,8,2]);assert.deepEqual(facts.largestDeviation,['plant']);assert.deepEqual(facts.lowestSignal,['station']);g.zones[0].audio=41;facts=e.sensorFacts(g);assert.deepEqual(facts.largestDeviation,['station','plant']);
});
test('여러 기록을 위조할 때 즉시 확인 내역은 이번에 바꾼 제안을 가리킴',()=>{
 const g=make(),first=speech(g);const second=e.addSpeech(g,'배수망은 음향 편차의 원인을 별도 확인해야 합니다.','drain');g.modules=['forge','forge'];e.useModule(g,'forge','hound');assert.equal(g.lastModuleUse.proposal,second.id);e.useModule(g,'forge','audit');assert.equal(g.lastModuleUse.proposal,first.id);assert.equal(g.lastModuleUse.target,'audit');assert.equal(first.author,'audit');assert.equal(second.author,'hound');
});
