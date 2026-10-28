import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';

const chromium = [process.env.CHROME, 'chromium', 'chromium-browser', 'google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((name) => {
  try { execFileSync(name, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
});
// A browser's first launch on a fresh CI runner (font caches, the snap's setup) takes longer than a test's
// budget: launch it once here so that cost lands on no test.
if (chromium) {
  try {
    execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--dump-dom',
      'about:blank'], { stdio: 'ignore', timeout: 120000 });
  } catch {}
}

for (const crossOrigin of [false, true]) {
  test(`viewport dialogs cover the host of a ${crossOrigin ? 'sandboxed' : 'same-origin'} iframe and restore it`,
    { skip: !chromium }, async () => {
      const generated = fileURLToPath(new URL('../../../../.nsh/', import.meta.url));
      await mkdir(generated, { recursive: true });
      const dir = await mkdtemp(join(generated, 'viewport-browser-'));
      try {
        const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
        const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
        const child = `<!doctype html><style>html,body{margin:0}#app{width:320px;height:240px}</style>
          <div id="app"></div><script type="module">
          import { Player } from '${module}';
          const check = (ok, message) => { if (!ok) throw Error(message); };
          const pause = () => new Promise(r => setTimeout(r, 60));
          const ask = (phase) => new Promise(resolve => {
            const listener = e => { if (e.data.phase === phase) { removeEventListener('message', listener); resolve(e.data); } };
            addEventListener('message', listener); parent.postMessage({ phase }, '*');
          });
          try {
            const p = new Player(document.querySelector('#app'), { dialogs:'viewport', history:false });
            p.size = [320,240]; p.syncHistorySoon = () => {};
            const events = [], sizes = [];
            p.event = (id, name, payload) => events.push([id, name, payload]);
            p.wasm = { nsh_key: () => -1, nsh_stop: () => {}, nsh_root_size: (...args) => { sizes.push(args); return -1; } };
            p.call = f => f(p.wasm); p.installInput();
            const make = id => {
              const el = document.createElement('div');
              Object.assign(el, { _id:id, _kind:'modal', _modal:{ animation:'none', closeOnEscape:true }, _events:new Set() });
              el.className='nsh-modal'; p.views.set(id,el); p.present(el); return el;
            };
            const dialog = make(2);
            await pause();
            const host = await ask('open');
            check(dialog.clientWidth === host.width && dialog.clientHeight === host.height, 'modal stayed in iframe');
            check(p.root.clientWidth === 320 && p.root.clientHeight === 240, 'app resized with the modal');
            check(sizes.at(-1)[1] === host.width && sizes.at(-1)[2] === host.height, 'core got the iframe size');
            const button = document.createElement('div');
            Object.assign(button, { _id:3, _kind:'view', _events:new Set(['onPress']), _props:{}, _tracked:0 });
            button.className='nsh-v'; button.style.cssText='left:600px;top:300px;width:80px;height:40px';
            dialog.append(button); p.views.set(3,button);
            button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'touch',clientX:620,clientY:310}));
            button.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,pointerType:'touch',clientX:620,clientY:310}));
            const mouse = p.mousePoint(button, {clientX:620,clientY:310});
            check(mouse[0]===20 && mouse[1]===10,'mouse inherited the embedded app scale');
            const press = events.find(e=>e[1]==='onPress')?.[2];
            check(press?.pagePosition.x===620 && press?.position.x===20, 'pointer origin moved with iframe');
            const wheel = new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:120});
            dialog.dispatchEvent(wheel); check(wheel.defaultPrevented,'backdrop let the wheel through');
            check(getComputedStyle(dialog).touchAction==='none','backdrop lets touches pan the page');
            const nested = make(4); await pause(); p.dismiss(nested); await pause();
            await ask('nested-closed');
            dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
            await pause(); check(dialog._leaving,'Escape did not close the dialog');
            await ask('closed');
            make(5); await pause(); p.stop(); await pause();
            await ask('stopped');
            make(6); await pause();
            await ask('remove');
          } catch(e) { parent.postMessage({phase:'failed',error:e.stack},'*'); }
          </script>`;
        const html = `<!doctype html><style>body{height:2000px;margin:0}#trap{transform:translate(30px,40px) scale(.75);transform-origin:0 0;overflow:hidden;width:340px;height:260px}iframe{width:320px;height:240px;border:0}</style>
          <button id="outside">outside</button><div id="trap"><iframe ${crossOrigin ? 'sandbox="allow-scripts"' : ''}></iframe></div>
          <script type="module">
          import { hostPlayerFrame } from '${module}';
          const frame=document.querySelector('iframe'), outside=document.querySelector('#outside');
          ${crossOrigin ? 'hostPlayerFrame(frame);' : ''}
          let loads=0; frame.addEventListener('load',()=>loads++);
          const check=(ok,message)=>{if(!ok)throw Error(message)};
          addEventListener('message',e=>{
            if(e.source!==frame.contentWindow||!e.data.phase)return;
            try {
              const phase=e.data.phase;
              if(phase==='failed')throw Error(e.data.error);
              if(phase==='remove') {
                check(loads===1,'iframe reloaded');
                frame.remove();
                setTimeout(()=>{
                  document.body.dataset.result = !outside.inert && !document.documentElement.style.overflow
                    ? 'passed' : 'failed: removing the iframe left the page locked';
                },60);
                return;
              }
              if(phase==='open'||phase==='nested-closed'){
                check(frame.matches(':popover-open'),'iframe not in parent top layer');
                check(getComputedStyle(frame).backgroundColor==='rgba(0, 0, 0, 0)','iframe background hides the host page');
                check(document.elementFromPoint(700,400)===frame,'mask does not cover the parent');
                check(document.documentElement.style.overflow==='hidden','parent still scrolls');
                check(outside.inert,'keyboard can reach the parent');
              } else {
                check(!frame.matches(':popover-open'),'iframe was not restored');
                check(frame.clientWidth===320&&frame.clientHeight===240,'iframe size not restored');
                check(!outside.inert&&!document.documentElement.style.overflow,'page state not restored');
              }
              e.source.postMessage({phase,width:innerWidth,height:innerHeight},'*');
            }catch(error){document.body.dataset.result='failed: '+error.message;}
          });
          frame.srcdoc=${JSON.stringify(child).replaceAll('</script', '<\\/script')};
          </script>`;
        await writeFile(join(dir,'index.html'),html);
        const run=()=>execFileSync(chromium,['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
          // Keep virtual time shared with the sandboxed frame. Its opaque origin remains enforced.
          '--disable-site-isolation-trials','--allow-file-access-from-files','--window-size=1280,800','--virtual-time-budget=5000',
          '--user-data-dir='+join(dir,'profile'),'--dump-dom',pathToFileURL(join(dir,'index.html')).href],
          {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000,maxBuffer:8*1024*1024});
        let result;
        try { result=run(); } catch (error) {
          throw Error(`${chromium} failed: ${error.message}\n${error.stderr ?? ''}`, { cause: error });
        }
        assert.equal(result.match(/data-result="([^"]*)"/)?.[1], 'passed');
      } finally { await rm(dir,{recursive:true,force:true}); }
    });
}
