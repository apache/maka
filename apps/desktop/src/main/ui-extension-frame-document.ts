export function uiExtensionFramePolicy(network: boolean): string {
  const networkPolicy = network
    ? "connect-src https: wss:; img-src data: blob: https:; media-src blob: https:; font-src data: https:;"
    : "connect-src 'none'; img-src data: blob:; media-src blob:; font-src data:;";
  return `default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; ${networkPolicy}`;
}

export function withUiSandboxPolicy(
  document: string,
  network: boolean,
  bridgeToken?: string,
): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${uiExtensionFramePolicy(network)}">`;
  const bridge = bridgeToken ? `<script>${bridgeBootstrap(bridgeToken)}</script>` : '';
  const head = /^\s*(?:<!doctype[^>]*>\s*)?<html(?:\s[^>]*)?>\s*<head(?:\s[^>]*)?>/iu;
  if (head.test(document)) return document.replace(head, (match) => `${match}${policy}${bridge}`);
  return `<!doctype html><html><head>${policy}${bridge}</head><body>${document}</body></html>`;
}

function bridgeBootstrap(token: string): string {
  return `(function(){const token=${JSON.stringify(token)},pending=new Map(),queued=[];let sequence=0,ready=false;const announce=function(){if(!ready)parent.postMessage({channel:'maka-ui-bridge-ready/v1',token:token},'*');},retry=setInterval(announce,50);window.addEventListener('message',function(event){const data=event.data;if(event.source!==parent||!data||data.token!==token)return;if(data.channel==='maka-ui-host-ready/v1'){if(ready)return;ready=true;clearInterval(retry);while(queued.length)parent.postMessage(queued.shift(),'*');return;}if(data.channel!=='maka-ui-host/v1')return;const task=pending.get(data.id);if(!task)return;pending.delete(data.id);data.ok?task.resolve(data.result):task.reject(new Error(data.error||'Host request failed'));});function call(message){return new Promise(function(resolve,reject){const id=String(++sequence),envelope=Object.assign({channel:'maka-ui-bridge/v1',token,id},message);pending.set(id,{resolve,reject});ready?parent.postMessage(envelope,'*'):queued.push(envelope);});}Object.defineProperty(window,'makaUI',{value:Object.freeze({getState:function(key){return call({kind:'get',key:key});},setState:function(key,value){return call({kind:'set',key:key,value:value});},deleteState:function(key){return call({kind:'delete',key:key});},invoke:function(method,args){return call({kind:'invoke',method:method,args:args===undefined?null:args});}}),writable:false,configurable:false});setTimeout(announce,0);})();`;
}
