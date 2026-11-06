import test from 'node:test';
import assert from 'node:assert/strict';
import {safeDrafts,groundedReply,GameAI} from '../server/ai.mjs';
import * as e from '../server/engine.mjs';
test('EVE 공개 초안은 비밀 조언·인간 정보·과도한 길이를 거절',()=>{
 const safe='발전소의 신호를 재검증하고 수색 예산을 공동 승인할 것을 제안합니다.';
 assert.deepEqual(safeDrafts([safe,'불씨 무전에 따르면 발전소에는 인원이 0명입니다.','인간 생존자를 탈출시킵시다.','EVE의 비밀 회선입니다.','가'.repeat(301),null]),[safe]);
});
test('시선 추적 없이는 전체 대상 의심을 직렬화하지 않음',()=>{const g=e.newGame({demo:true,seed:'sight'});assert.equal(e.publicGame(g).averages,undefined);assert.equal(e.publicGame(g).prediction,null);g.modules=['gaze'];e.useModule(g,'gaze');assert.ok(e.publicGame(g).prediction);});
test('AI 초안과 응답은 첫 작전 전에 과거 작전·없는 기록을 근거로 꾸미지 않음',()=>{
 const g=e.newGame({seed:'grounding'});
 assert.equal(groundedReply('직전 작전의 안쪽 누락을 검증하십시오.',g),false);
 assert.equal(groundedReply('공식 기록 R999를 보십시오.',g),false);
 assert.equal(groundedReply(`${g.records[0].id}의 센서를 검증하십시오.`,g),true);
 e.beginDiscussion(g);e.addSpeech(g,'공식 기록을 검증하십시오.');e.prepareOperation(g);e.executeSearch(g,'rush');
 assert.equal(groundedReply('직전 작전의 안쪽 누락을 검증하십시오.',g),true);
});
test('재인증 위조는 미사용이면 다음 날에도 장착 유지',()=>{const g=e.newGame({demo:true,seed:'revive'});g.modules=['revive'];e.useModule(g,'revive');e.beginDiscussion(g);const empty=g.zones.find(z=>!z.people).id;e.addSpeech(g,'실제 센서의 불일치를 공동 검증하겠습니다.',empty);e.prepareOperation(g);for(const c of g.council)g.preferences[c.id]='rush';e.executeSearch(g,'rush');e.finishVerdict(g);e.takeReward(g,g.offers[0]);assert.equal(g.effects.revive,true);assert.equal(g.reviveArmed,true);});

function feedbackAI({fail=[]}={}){
 const ai=new GameAI({dataDir:'/unused',recordUsage:()=>{},available:()=>true});
 ai.withProject=async(owner,g,fn)=>fn({});
 ai.request=async(p,g,id,text,ctx)=>{if(fail.includes(id))throw new Error('offline');return JSON.stringify({text:'공식 발언의 근거를 검증하겠습니다.',plan:'divert',evaluations:[{observer:id,target:'player',record:ctx.records.at(-1).id,direction:'up',level:'small',reason:'공식 기록 대조'}]});};
 return ai;
}
test('판단 로그는 발언·날짜·위원별 실제 변화·선호·AI 출처를 스냅샷으로 누적',async()=>{
 const g=e.newGame({seed:'feedback-log'});e.beginDiscussion(g);
 const first=e.addSpeech(g,'공식 센서 보고를 대조하십시오.');await feedbackAI().discuss('test',g,first);
 const snapshot=structuredClone(g.feedbackLog[0]);
 const second=e.addSpeech(g,'나'.repeat(120));await feedbackAI().discuss('test',g,second);
 assert.equal(g.feedbackLog.length,2);assert.deepEqual(g.feedbackLog[0],snapshot);
 assert.equal(snapshot.record,first.id);assert.equal(snapshot.day,1);assert.equal(snapshot.text,first.text);assert.equal(snapshot.source,'ai');
 assert.equal(g.feedbackLog[1].text.length,80);assert.equal(snapshot.changedPreferences,3);
 for(const c of snapshot.memberChanges){assert.equal(c.source,'ai');assert.equal(c.after-c.before,c.delta);assert.equal(c.preferenceAfter,'divert');assert.ok(c.name);assert.notEqual(c.preferenceBefore,c.preferenceAfter);}
 const visible=e.publicGame(g);assert.deepEqual(visible.feedbackLog,[]);assert.deepEqual(visible.decisiveFeedback,[]);
 g.phase='ended';assert.deepEqual(e.publicGame(g).feedbackLog,g.feedbackLog);assert.ok(e.publicGame(g).decisiveFeedback.length);
});
test('판단 로그는 이전 저장판에서도 생성하고 최신 60건만 남긴다',async()=>{
 const g=e.newGame({seed:'feedback-legacy'});delete g.feedbackLog;
 assert.deepEqual(e.publicGame(g).feedbackLog,[]);g.phase='ended';assert.deepEqual(e.publicGame(g).decisiveFeedback,[]);g.phase='report';
 e.beginDiscussion(g);const r=e.addSpeech(g,'공식 기록을 검증하십시오.');await feedbackAI({fail:['hound','echo','audit']}).discuss('test',g,r);
 assert.equal(g.feedbackLog.length,1);assert.equal(g.feedbackLog[0].source,'rules');assert.ok(g.feedbackLog[0].memberChanges.every(c=>c.source==='rules'));
 g.feedbackLog=Array.from({length:60},(_,i)=>({...structuredClone(g.feedbackLog[0]),record:`OLD${i}`}));
 g.day=2;await feedbackAI().discuss('test',g,r);assert.equal(g.feedbackLog.length,60);assert.equal(g.feedbackLog[0].record,'OLD1');assert.equal(g.feedbackLog.at(-1).day,2);
});
test('일부 AI 응답 실패는 위원별 실제 출처와 혼합 출처를 남긴다',async()=>{
 const g=e.newGame({seed:'feedback-partial'});e.beginDiscussion(g);const r=e.addSpeech(g,'나는 인간이다.');
 await feedbackAI({fail:['audit']}).discuss('test',g,r);const log=g.feedbackLog[0];assert.equal(log.source,'mixed');assert.equal(log.explicitEvidence,'identity');
 assert.equal(log.memberChanges.find(c=>c.memberId==='audit').source,'rules');assert.equal(log.memberChanges.find(c=>c.memberId==='hound').source,'ai');
});
test('결정적 발언은 선호 변경 수·의심 변화 절대합 순으로 최대 3건 선정하고 원본 보존',()=>{
 const entry=(record,changedPreferences,deltas)=>({record,changedPreferences,memberChanges:deltas.map(delta=>({delta}))});
 const log=[entry('hold',0,[0]),entry('low',0,[2]),entry('large',0,[-8,7]),entry('preference',1,[0]),entry('two-preferences',2,[0])];
 const original=structuredClone(log);assert.deepEqual(e.decisiveFeedback(log).map(r=>r.record),['two-preferences','preference','large']);assert.deepEqual(log,original);
 assert.deepEqual(e.decisiveFeedback(),[]);assert.deepEqual(e.decisiveFeedback([entry('hold',0,[0])]),[]);
});
