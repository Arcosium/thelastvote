import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {newGame} from '../server/engine.mjs';
import {backupDatabase} from '../scripts/backup-db.mjs';

test('열려 있는 WAL DB를 일관되게 백업하고 별도 복원본에서 로그인·이어하기 가능',async()=>{
 const base=process.env.TEST_PRIVATE_DIR||'/home/arcosium/vault/thelastvote/tests';mkdirSync(base,{recursive:true});
 const dir=mkdtempSync(join(base,'backup-')),store=new Store(join(dir,'source'));
 try{
  const password=randomUUID(),u=await store.createUser('backup_player',password),g=newGame({seed:'backup'});store.save(u.id,g);
  const target=join(dir,'restored/game.sqlite');await backupDatabase(join(dir,'source/game.sqlite'),target);
  // Later source writes must not change the snapshot.
  g.version++;store.save(u.id,g);
  const restored=new Store(join(dir,'restored'));
  try{assert.equal((await restored.login('backup_player',password)).id,u.id);assert.equal(restored.game(u.id).id,g.id);assert.equal(restored.game(u.id).version,0);assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{restored.db.close();}
  await assert.rejects(backupDatabase(join(dir,'source/game.sqlite'),target),/destination/);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
