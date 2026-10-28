import test from 'node:test';
import assert from 'node:assert/strict';
import {safeDrafts,groundedReply} from '../server/ai.mjs';
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
