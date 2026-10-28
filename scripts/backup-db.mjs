import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,existsSync,chmodSync,renameSync,rmSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

export async function backupDatabase(source,target){
 source=resolve(source);target=resolve(target);
 if(!existsSync(source)||existsSync(target)||source===target)throw new Error('Source must exist and destination must be new');
 mkdirSync(dirname(target),{recursive:true,mode:0o700});
 const temporary=target+'.partial-'+randomUUID(),db=new DatabaseSync(source,{readOnly:true});
 try{
  await backup(db,temporary);chmodSync(temporary,0o600);
  const verify=new DatabaseSync(temporary,{readOnly:true});
  try{if(verify.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Backup integrity check failed');}finally{verify.close();}
  renameSync(temporary,target);return target;
 }finally{db.close();if(existsSync(temporary))rmSync(temporary);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
 const source=join(resolve(process.env.DATA_DIR||join(root,'data')),'game.sqlite');
 if(!process.argv[2])throw new Error('Usage: node scripts/backup-db.mjs /vault/path/new-snapshot.sqlite');
 console.log(JSON.stringify({snapshot:await backupDatabase(source,process.argv[2])}));
}
