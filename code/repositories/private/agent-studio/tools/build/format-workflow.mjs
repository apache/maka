import {readFile,writeFile,readdir} from 'node:fs/promises';
import {format} from 'prettier';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
for(const file of ['workflow-pIO8SJmW.js','intelligentEngine-BhRFRjx8.js','src--QpPaBte.js','config-KnGHEPxL.js','utils-DS1Vnd25.js','Graph-B6k8QY9W.js']) {
 const text=await readFile(join(root,'captured/assets/js',file),'utf8');
 const formatted=await format(text,{parser:'babel'});
 await writeFile(join(root,'readable',file),formatted);
 console.log(file,formatted.split('\n').length+' lines');
}
