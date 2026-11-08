import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

let chromium;
try { execFileSync('chromium', ['--version'], { stdio: 'ignore' }); chromium = 'chromium'; } catch {}

test('entering a sticky track cancels the content-coordinate layout animation', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-scroll-browser-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player, KEYFRAMES };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>body { margin:0; }</style>
    <script type="module">
      import { Player, KEYFRAMES } from '${module}';
      try {
        const style=document.createElement('style'); style.textContent=KEYFRAMES; document.head.append(style);
        for (const horizontal of [false,true]) {
          const list=document.createElement('div'), cell=document.createElement('div');
          list.className='nsh-v nsh-scroll'; cell.className='nsh-v';
          list.style.cssText='left:0;top:0;width:300px;height:200px;';
          list._id=1; list._kind='scroll'; list._horizontal=horizontal;
          list._content=horizontal?[2000,200]:[300,2000];
          cell._id=2; cell._kind='cell'; list.append(cell); document.body.append(list);
          const player=Object.create(Player.prototype); player.views=new Map([[1,list],[2,cell]]);
          const frame=position=>horizontal?[position,0,40,200]:[0,position,300,40];
          player.op_f(['f',2,...frame(400)]);
          player.layoutAnimation={update:{duration:100000,delay:0,easing:'linear'}};
          player.op_f(['f',2,...frame(500)]);
          const animation=cell._frameAnimation;
          if (!animation) throw Error('missing initial animation');
          animation.pause(); animation.currentTime=0;
          player.op_sticky(['sticky',1,[[2,500,1000]]]);
          if (horizontal) list.scrollLeft=600; else list.scrollTop=600;
          const rect=cell.getBoundingClientRect(), position=horizontal?rect.left:rect.top;
          if (Math.abs(position)>0.01) throw Error('sticky position: '+position);
          if (animation.playState!=='idle' || cell._frameAnimation) throw Error('animation still active');
          list.remove();
        }
        document.body.dataset.result='passed';
      } catch(e) { document.body.dataset.result='failed: '+e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a scroll view\'s content takes the reading order it has on screen', { skip: !chromium }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-reading-browser-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player, KEYFRAMES };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>body { margin:0; }</style>
    <script type="module">
      import { Player, KEYFRAMES } from '${module}';
      try {
        if (!CSS.supports('reading-flow', 'source-order')) throw Error('unsupported');
        const style=document.createElement('style'); style.textContent=KEYFRAMES; document.head.append(style);
        // A list of its own each way, and a list in its parent's viewport:
        // a plain view whose props say its cells are read in screen order.
        for (const mode of ['vertical','horizontal','page']) {
          const horizontal=mode==='horizontal', page=mode==='page';
          const list=document.createElement('div');
          list.className=page?'nsh-v':'nsh-v nsh-scroll';
          list.style.cssText='left:0;top:0;width:300px;height:200px;';
          list._id=1; list._kind=page?'view':'scroll'; list._horizontal=horizontal; list._events=new Set();
          list._content=horizontal?[2000,200]:[300,2000];
          document.body.append(list);
          const player=Object.create(Player.prototype);
          player.views=new Map([[1,list]]); player.changedStacks=new Set(); player.removals=[];
          player.appearing=[]; player.disappearing=[];
          // Cells made for rows 0 to 3; rows 0 and 1 scrolled away and their
          // cells bound to rows 4 and 5; row 3's cell sticks.
          const rows=[[2,4],[4,5],[6,2],[8,3]];
          const frame=row=>horizontal?[row*40,0,40,200]:[0,row*40,300,40];
          for (const [id] of rows) {
            const cell=document.createElement('div'); cell.className='nsh-v'; cell._id=id; cell._kind='view';
            cell.tabIndex=0; player.views.set(id,cell);
          }
          if (page) player.apply([['vp',1,{pointerEvents:'auto',hitSlop:[0,0,0,0],role:'none',screenOrder:'vertical'}]]);
          player.apply(rows.flatMap(([id,row])=>[['i',1,id,null],['f',id,...frame(row)]]));
          if (list.style.readingFlow!=='source-order') throw Error('reading flow: '+list.style.readingFlow);
          if (!page) player.apply([['sticky',1,[[8,120,400]]]]);
          player.apply([['f',4,...frame(5)]]);
          const order=[...list.children].filter(c=>c._id!==undefined||c._list)
            .sort((a,b)=>Number(a.style.readingOrder)-Number(b.style.readingOrder))
            .map(c=>(c._list?c.firstElementChild:c)._id);
          if (order.join()!=='6,8,2,4' || (!page && !list.querySelector('.nsh-track'))) throw Error('reading order: '+order.join());
          // The DOM, which is the paint order, is left alone.
          const dom=[...list.querySelectorAll('[tabindex]')].map(c=>c._id);
          if (dom.join()!=='2,4,6,8') throw Error('dom order: '+dom.join());
          list.remove();
        }
        document.body.dataset.result='passed';
      } catch(e) { document.body.dataset.result='failed: '+e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    const result = html.match(/data-result="([^"]*)"/)?.[1];
    // A browser without `reading-flow` keeps the DOM's order.
    if (result === 'failed: unsupported') t.skip('no reading-flow in this browser');
    else assert.equal(result, 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
