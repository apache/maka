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
  declaredSlots: readonly string[] = [],
): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${uiExtensionFramePolicy(network)}">`;
  const bridge = bridgeToken
    ? `<script>${bridgeBootstrap(bridgeToken, declaredSlots)}</script>`
    : '';
  const head = /^\s*(?:<!doctype[^>]*>\s*)?<html(?:\s[^>]*)?>\s*<head(?:\s[^>]*)?>/iu;
  if (head.test(document)) return document.replace(head, (match) => `${match}${policy}${bridge}`);
  return `<!doctype html><html><head>${policy}${bridge}</head><body>${document}</body></html>`;
}

function bridgeBootstrap(token: string, declaredSlots: readonly string[]): string {
  return `(function(){const token=${JSON.stringify(token)},declaredSlots=${JSON.stringify(declaredSlots)},pending=new Map(),queued=[];let sequence=0,ready=false,layoutFrame=0;const announce=function(){if(!ready)parent.postMessage({channel:'maka-ui-bridge-ready/v1',token:token},'*');},retry=setInterval(announce,50);function publishSlots(){layoutFrame=0;const slots=[];for(const name of declaredSlots){const element=document.querySelector('[data-maka-slot="'+CSS.escape(name)+'"]');if(!element)continue;const rect=element.getBoundingClientRect();slots.push({name:name,x:rect.x,y:rect.y,width:rect.width,height:rect.height});}parent.postMessage({channel:'maka-ui-slot-layout/v1',token:token,slots:slots},'*');}function scheduleSlots(){if(!layoutFrame)layoutFrame=requestAnimationFrame(publishSlots);}window.addEventListener('resize',scheduleSlots);window.addEventListener('scroll',scheduleSlots,true);new MutationObserver(scheduleSlots).observe(document.documentElement,{attributes:true,childList:true,subtree:true});if(typeof ResizeObserver==='function')new ResizeObserver(scheduleSlots).observe(document.documentElement);window.addEventListener('keydown',function(event){if((event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key==='Backspace'){event.preventDefault();event.stopImmediatePropagation();const id=String(++sequence),envelope={channel:'maka-ui-bridge/v1',token:token,id:id,kind:'safe_mode'};ready?parent.postMessage(envelope,'*'):queued.push(envelope);}},true);window.addEventListener('message',function(event){const data=event.data;if(event.source!==parent||!data||data.token!==token)return;if(data.channel==='maka-ui-host-ready/v1'){if(ready)return;ready=true;clearInterval(retry);while(queued.length)parent.postMessage(queued.shift(),'*');scheduleSlots();return;}if(data.channel!=='maka-ui-host/v1')return;const task=pending.get(data.id);if(!task)return;pending.delete(data.id);data.ok?task.resolve(data.result):task.reject(new Error(data.error||'Host request failed'));});function call(message){return new Promise(function(resolve,reject){const id=String(++sequence),envelope=Object.assign({channel:'maka-ui-bridge/v1',token,id},message);pending.set(id,{resolve,reject});ready?parent.postMessage(envelope,'*'):queued.push(envelope);});}const sessions=Object.freeze({list:function(){return call({kind:'session_list'});},send:function(input){input=input||{};return call({kind:'session_send',sessionId:input.sessionId,text:input.text});},stop:function(sessionId){return call({kind:'session_stop',sessionId:sessionId});}});Object.defineProperty(window,'makaUI',{value:Object.freeze({getConfig:function(){return call({kind:'config'}).then(function(result){return result.configuration;});},getState:function(key){return call({kind:'get',key:key});},setState:function(key,value){return call({kind:'set',key:key,value:value});},deleteState:function(key){return call({kind:'delete',key:key});},invoke:function(method,args){return call({kind:'invoke',method:method,args:args===undefined?null:args});},sessions:sessions}),writable:false,configurable:false});setTimeout(announce,0);})();`;
}
