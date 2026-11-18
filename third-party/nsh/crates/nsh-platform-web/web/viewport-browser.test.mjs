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
            // The host shows the app at .75: the dialog keeps that scale and covers the window.
            const box = dialog.getBoundingClientRect();
            check(Math.abs(box.width - host.width) < 1 && Math.abs(box.height - host.height) < 1, 'modal stayed in iframe');
            check(Math.abs(dialog.clientWidth * .75 - host.width) < 1, 'modal lost the app scale');
            check(p.root.clientWidth === 320 && p.root.clientHeight === 240, 'app resized with the modal');
            check(sizes.at(-1)[1] === dialog.clientWidth && sizes.at(-1)[2] === dialog.clientHeight, 'core got the iframe size');
            const button = document.createElement('div');
            Object.assign(button, { _id:3, _kind:'view', _events:new Set(['onPress']), _props:{}, _tracked:0 });
            button.className='nsh-v'; button.style.cssText='left:600px;top:300px;width:80px;height:40px';
            dialog.append(button); p.views.set(3,button);
            const at = {bubbles:true,pointerId:1,pointerType:'touch',clientX:620*.75,clientY:310*.75};
            button.dispatchEvent(new PointerEvent('pointerdown',at));
            button.dispatchEvent(new PointerEvent('pointerup',at));
            const near = (a, b) => Math.abs(a - b) < .01;
            const mouse = p.mousePoint(button, at);
            check(near(mouse[0],20) && near(mouse[1],10),'mouse missed the dialog scale');
            const press = events.find(e=>e[1]==='onPress')?.[2];
            check(near(press?.pagePosition.x,620) && near(press?.position.x,20), 'pointer missed the dialog scale');
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
        // A dark host around a light player: the lifted frame takes its document's scheme, or it is painted opaque.
        const html = `<!doctype html><style>html{color-scheme:dark}body{height:2000px;margin:0}#trap{transform:translate(30px,40px) scale(.75);transform-origin:0 0;overflow:hidden;width:340px;height:260px}iframe{width:320px;height:240px;border:0}</style>
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
                check(getComputedStyle(frame).colorScheme==='light','iframe scheme differs from its document');
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

for (const viewport of [false, true]) {
  test(`a ${viewport ? 'viewport' : 'container'} dialog goes and comes back with the view that holds it`,
    { skip: !chromium }, async () => {
      const generated = fileURLToPath(new URL('../../../../.nsh/', import.meta.url));
      await mkdir(generated, { recursive: true });
      const dir = await mkdtemp(join(generated, 'modal-host-browser-'));
      try {
        const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
        const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
        // The browser's graph removes a component's views at once and deletes them only once they are collected:
        // a dialog (a child of the root) must not wait for its `Delete`.
        const html = `<!doctype html><style>html,body{margin:0}#app{width:320px;height:240px}</style>
          <div id="app"></div><script type="module">
          import { Player } from '${module}';
          const check = (ok, message) => { if (!ok) throw Error(message); };
          const pause = () => new Promise(r => setTimeout(r, 60));
          try {
            const p = new Player(document.querySelector('#app'), { dialogs:${viewport ? "'viewport'" : 'undefined'}, history:false });
            p.size = [320,240]; p.syncHistorySoon = () => {};
            const events = [];
            p.event = (id, name) => events.push([id, name]);
            p.wasm = { nsh_root_size: () => -1 };
            p.call = f => f(p.wasm);
            Object.assign(p.root, { _id:1, _kind:'root', _events:new Set(), _animation:{} }); p.views.set(1, p.root);
            // A view (2) holds a component's view (4) with a dialog (10), whose content (12) holds another (20).
            p.apply([['c',2,'view'],['c',4,'view'],['c',10,'modal'],['c',12,'view'],['c',20,'modal'],['c',22,'view'],
              ['i',20,22,null],['i',12,20,null],['i',10,12,null],['mc',10,'none',true],['mc',20,'none',true],
              ['i',4,10,null],['i',2,4,null],['i',1,2,null]]);
            await pause();
            const [outer, inner] = [p.views.get(10), p.views.get(20)];
            const shown = el => el.parentNode === p.root && !el._leaving;
            check(shown(outer) && shown(inner), 'dialogs not presented');
            p.apply([['r',4]]); await pause();
            check(!outer.isConnected && !inner.isConnected, 'dialogs stayed after their view left');
            check(!events.some(([, name]) => name === 'onDismiss'), 'a dialog that went with its view reported a dismissal');
            check(!p.root.querySelector('[aria-modal]') && ![...p.root.children].some(c => c.inert), 'the page stayed inert');
            p.apply([['i',2,4,null]]); await pause();
            check(shown(outer) && shown(inner), 'dialogs did not come back with their view');
            p.apply([['r',4],['d',4],['d',10],['d',12],['d',20],['d',22]]); await pause();
            check(!outer.isConnected && !inner.isConnected, 'deleted dialogs stayed');
            document.body.dataset.result = 'passed';
          } catch(e) { document.body.dataset.result = 'failed: ' + e.message; }
          </script>`;
        await writeFile(join(dir, 'index.html'), html);
        const result = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
          '--allow-file-access-from-files', '--window-size=640,480', '--virtual-time-budget=3000',
          '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(result.match(/data-result="([^"]*)"/)?.[1], 'passed');
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
}

for (const viewport of [false, true]) {
  test(`an anchored overlay ${viewport ? 'goes over the window' : 'stays in the container'} with overlays: ${viewport ? '"viewport"' : 'its default'}`,
    { skip: !chromium }, async () => {
      const generated = fileURLToPath(new URL('../../../../.nsh/', import.meta.url));
      await mkdir(generated, { recursive: true });
      const dir = await mkdtemp(join(generated, 'overlay-browser-'));
      try {
        const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
        const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
        // A short post's composer: a 320 × 120 player in a clipping, stacked
        // box of a page that scrolls, its topic popover (200 × 150) below a
        // button near its bottom, so most of it lies below the container.
        const html = `<!doctype html><style>html,body{margin:0}body{height:3000px}
          #clip{position:relative;z-index:0;overflow:hidden;margin:100px 0 0 50px;width:320px;height:120px}
          #app{width:320px;height:120px}#below{height:400px}</style>
          <div id="clip"><div id="app"></div></div><div id="below"></div><script type="module">
          import { Player } from '${module}';
          const check = (ok, message) => { if (!ok) throw Error(message); };
          const pause = () => new Promise(r => setTimeout(r, 60));
          const near = (a, b) => Math.abs(a - b) < .5;
          try {
            const p = new Player(document.querySelector('#app'), { overlays:${viewport ? "'viewport'" : 'undefined'}, history:false });
            p.size = [320,120]; p.syncHistorySoon = () => {};
            const areas = [], presses = [];
            p.wasm = {
              nsh_overlay_area: (...area) => { areas.push(area); return -1; },
              nsh_press_outside: (x, y) => { presses.push([x, y]); return -1; },
            };
            p.call = f => f(p.wasm);
            Object.assign(p.root, { _id:1, _kind:'root', _events:new Set(), _animation:{} }); p.views.set(1, p.root);
            if (${viewport}) p.installFloats();
            const props = (anchored) => ({ pointerEvents:'auto', hitSlop:[0,0,0,0], role:'none', ...(anchored ? { anchored } : {}) });
            // The app's view (2) holds the button (4); a fixed view (8), then the
            // popover (10) anchored to the button, and a view the app showed after it (14).
            p.apply([['c',2,'view'],['c',4,'view'],['c',8,'view'],['c',10,'view'],['c',12,'view'],['c',14,'view'],
              ['i',2,4,null],['i',1,2,null],['i',10,12,null],['i',1,8,null],['i',1,10,null],['i',1,14,null],
              ['f',2,0,0,320,120],['f',4,20,80,80,30],['f',8,0,0,320,20],['f',10,20,114,200,150],['f',12,0,0,200,150],
              ['f',14,0,0,10,10],['vp',8,props(false)],['vp',10,props(true)],['vp',14,props(false)]]);
            await pause();
            const [fixed, popover, after] = [p.views.get(8), p.views.get(10), p.views.get(14)];
            const open = el => el.matches(':popover-open');
            const root = p.root.getBoundingClientRect();
            const hit = () => document.elementFromPoint(root.left + 100, root.top + 200);
            if (!${viewport}) {
              check(!open(popover) && !areas.length, 'the overlay left the container by default');
              check(!popover.contains(hit()), 'the container did not clip its overlay');
              document.body.dataset.result = 'passed';
            } else {
              check(open(popover) && open(after) && !open(fixed), 'not lifted from the first anchored overlay on');
              let box = popover.getBoundingClientRect();
              check(near(box.left, root.left + 20) && near(box.top, root.top + 114) && near(box.width, 200) && near(box.height, 150),
                'the overlay is not at its frame in the root: ' + JSON.stringify(box));
              check(popover.contains(hit()), 'the overlay is clipped or under the page');
              const doc = document.documentElement;
              check(JSON.stringify(areas.at(-1)) === JSON.stringify([-root.left, -root.top, doc.clientWidth, doc.clientHeight]),
                'the core did not get the window: ' + JSON.stringify(areas.at(-1)));
              // The page scrolls: the overlay moves with the container, and its room in the window changes.
              // A headless run on virtual time draws no frames, which is where the browser fires \`scroll\`.
              scrollTo(0, 60); document.dispatchEvent(new Event('scroll')); await pause();
              const moved = p.root.getBoundingClientRect();
              box = popover.getBoundingClientRect();
              check(near(moved.top, root.top - 60) && near(box.top, moved.top + 114), 'the overlay did not follow the scroll');
              check(areas.at(-1)[1] === -moved.top, 'the core did not hear the scroll');
              // The app's own scroll views do not move the container: not measured.
              let measured = 0;
              const rect = p.root.getBoundingClientRect.bind(p.root);
              p.root.getBoundingClientRect = () => { measured++; return rect(); };
              p.views.get(12).dispatchEvent(new Event('scroll')); p.views.get(2).dispatchEvent(new Event('scroll'));
              check(measured === 0, 'scrolling in the app measured the container');
              p.root.getBoundingClientRect = rect;
              // A press on the page around the container is outside the overlay;
              // one on the overlay or in the container is the app's as before.
              const down = (el, x, y) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, clientX:x, clientY:y }));
              down(document.querySelector('#below'), moved.left + 300, moved.top + 400);
              check(presses.length === 1 && near(presses[0][0], 300) && near(presses[0][1], 400), 'a press around missed: ' + JSON.stringify(presses));
              down(p.views.get(12), box.left + 10, box.top + 10);
              down(p.views.get(4), moved.left + 30, moved.top + 90);
              check(presses.length === 1, 'a press in the app was taken for one around it');
              // A view moved in the DOM leaves the top layer: lifted again, above the ones before it.
              p.apply([['i',1,10,14]]); await pause();
              check(open(popover) && open(after), 'a moved overlay stayed out of the top layer');
              // It closes: in the container again, as the one after it.
              p.apply([['r',10],['vp',14,props(false)]]); await pause();
              check(!popover.isConnected && !open(after) && !after.hasAttribute('popover'), 'lifted views stayed lifted');
              down(document.querySelector('#below'), 10, 10);
              check(presses.length === 1, 'a press around reached the core with no overlay over the page');
              document.body.dataset.result = 'passed';
            }
          } catch(e) { document.body.dataset.result = 'failed: ' + e.message; }
          </script>`;
        await writeFile(join(dir, 'index.html'), html);
        const result = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
          '--allow-file-access-from-files', '--window-size=640,480', '--virtual-time-budget=3000',
          '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(result.match(/data-result="([^"]*)"/)?.[1], 'passed');
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
}
