import {readFile,writeFile} from 'node:fs/promises';
import {format} from 'prettier';
const root=new URL('.',import.meta.url);
await writeFile(new URL('readable/index.B_LPe2F7.js',root),await format(await readFile(new URL('captured/assets/js/index.B_LPe2F7.js',root),'utf8'),{parser:'babel'}));
