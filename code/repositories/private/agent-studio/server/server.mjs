import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {dirname,resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../app');
const mime={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.json':'application/json;charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff':'font/woff','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    const isPage=url.pathname==='/'||url.pathname==='/agent/workflow'||url.pathname.startsWith('/agent/studio/');
    const filename=isPage?'index.html':decodeURIComponent(url.pathname).slice(1);
    const path=resolve(root,filename);
    if(!path.startsWith(root+sep)) {res.writeHead(403);res.end('Forbidden');return;}
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end('Method not allowed');return;}
    await stat(path);
    const body=await readFile(path);
    res.writeHead(200,{'Content-Type':mime[extname(path)]??'application/octet-stream','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; form-action 'self'",'Referrer-Policy':'no-referrer'});
    res.end(req.method==='HEAD'?undefined:body);
  } catch(error) {
    res.writeHead(error.code==='ENOENT'?404:500,{'Content-Type':'text/plain;charset=utf-8'});
    res.end(error.code==='ENOENT'?'Not found':String(error));
  }
});
server.listen(Number(process.env.PORT)||4173,'127.0.0.1',()=>console.log('REA 本地还原：http://127.0.0.1:'+(process.env.PORT||4173)+'/agent/studio/app/app-manage'));
