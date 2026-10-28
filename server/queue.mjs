import {GameError} from './engine.mjs';

// Bound both the amount of provider work and how long a client can wait.
export class AIQueue {
 constructor({concurrency=8,maxWaiting=24,waitMs=15000}={}){this.concurrency=concurrency;this.maxWaiting=maxWaiting;this.waitMs=waitMs;this.active=0;this.waiting=[];}
 snapshot(){return {active:this.active,waiting:this.waiting.length,capacity:this.concurrency};}
 async run(fn){
  await new Promise((resolve,reject)=>{
   const ticket={resolve:()=>{clearTimeout(ticket.timer);this.active++;resolve();},reject};
   if(this.active<this.concurrency)return ticket.resolve();
   if(this.waiting.length>=this.maxWaiting)return reject(new GameError('위원회 회선이 혼잡합니다. 잠시 후 다시 시도하세요.',503));
   ticket.timer=setTimeout(()=>{this.waiting=this.waiting.filter(t=>t!==ticket);reject(new GameError('대기 시간이 길어졌습니다. 현재 기록을 확인하고 다시 시도하세요.',503));},this.waitMs);
   this.waiting.push(ticket);
  });
  try{return await fn();}finally{this.active--;this.waiting.shift()?.resolve();}
 }
}
