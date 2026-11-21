import {spawn,spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const url='http://127.0.0.1:4173/agent/studio/agent/app-manage';
let server;
try{
  try{
    const response=await fetch(url);
    if(!response.ok)throw new Error('HTTP '+response.status);
  }catch{
    server=spawn(process.execPath,[join(root,'server/server.mjs')],{cwd:root,stdio:'inherit'});
    for(let attempt=0;attempt<20;attempt++){
      await new Promise(resolve=>setTimeout(resolve,100));
      try{
        const response=await fetch(url);
        if(response.ok)break;
      }catch{}
      if(attempt===19)throw new Error('本地服务未在 2 秒内启动');
    }
  }
  for(const file of [
    'verify.mjs',
    'verify-storage.mjs',
    'verify-all-versions.mjs',
    'verify-agent-edit.mjs',
    'verify-super-copy.mjs',
    'verify-business.mjs',
    'verify-business-details.mjs',
    'verify-documents.mjs',
    'verify-knowledge-lifecycle.mjs',
    'verify-support.mjs',
    'verify-task.mjs',
    'verify-task-copy.mjs',
    'verify-route-state.mjs',
    'verify-navigation.mjs',
  ]){
    const result=spawnSync(process.execPath,[join(root,'tools/verify',file)],{cwd:root,stdio:'inherit'});
    if(result.status!==0)throw new Error(file+' 验证失败，退出码 '+(result.status??'unknown'));
  }
  for(const [script,label] of [['check-imports.py','静态 import'],['check-patches.py','发布代码改动']]){
    const result=spawnSync('python',[join(root,'tools/analyze',script)],{cwd:root,stdio:'inherit'});
    if(result.status!==0)throw new Error(label+'检查失败，退出码 '+(result.status??'unknown'));
  }
  console.log('全部离线接口、持久化、采集版本、导航刷新、静态导入与发布代码改动检查通过。');
}finally{
  server?.kill();
}
