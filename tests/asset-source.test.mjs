import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,symlinkSync,lstatSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
test('빌드 전에 출력 폴더를 가리킨 원본 자산을 실파일로 보존',()=>{
 const dir=mkdtempSync(join(tmpdir(),'tlv-assets-'));try{
  for(const path of ['scripts','public/assets','dist/assets'])mkdirSync(join(dir,path),{recursive:true});
  const bytes=Buffer.from('verified source image'),file='example.png';
  writeFileSync(join(dir,'dist/favicon.svg'),'<svg/>');symlinkSync('../dist/favicon.svg',join(dir,'public/favicon.svg'));
  writeFileSync(join(dir,'dist/assets/retained.mp4'),bytes);symlinkSync('../../dist/assets/retained.mp4',join(dir,'public/assets/retained.mp4'));
  writeFileSync(join(dir,'dist/assets',file),bytes);symlinkSync('../../dist/assets/'+file,join(dir,'public/assets',file));
  writeFileSync(join(dir,'assets.manifest.json'),JSON.stringify([{file,url:'http://must-not-fetch.invalid',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]));
  copyFileSync('scripts/fetch-assets.mjs',join(dir,'scripts/fetch-assets.mjs'));execFileSync(process.execPath,[join(dir,'scripts/fetch-assets.mjs')]);
  assert.equal(lstatSync(join(dir,'public/assets',file)).isSymbolicLink(),false);rmSync(join(dir,'dist'),{recursive:true});assert.deepEqual(readFileSync(join(dir,'public/assets',file)),bytes);assert.equal(readFileSync(join(dir,'public/favicon.svg'),'utf8'),'<svg/>');assert.deepEqual(readFileSync(join(dir,'public/assets/retained.mp4')),bytes);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
