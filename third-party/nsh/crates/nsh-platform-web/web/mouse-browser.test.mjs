import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

let chromium;
try { execFileSync('chromium', ['--version'], { stdio: 'ignore' }); chromium = 'chromium'; } catch {}

test('browser mouse coordinates follow nested transforms and rendering emits no motion', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-mouse-browser-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>
      div { position:absolute; box-sizing:border-box; transform-origin:0 0; }
      #root { left:50px; top:40px; width:600px; height:600px; }
      #outer { left:20px; top:30px; width:200px; height:200px; transform:scale(1.5) rotate(20deg); }
      #inner { left:15px; top:25px; width:100px; height:100px; transform:scale(2) rotate(-10deg); }
    </style><div id="root"><div id="outer"><div id="inner"></div></div></div>
    <script type="module">
      import { Player } from '${module}';
      try {
        const root = document.querySelector('#root'), outer = document.querySelector('#outer'), inner = document.querySelector('#inner');
        root._id=1; outer._id=2; inner._id=3;
        for (const el of [outer,inner]) el._events=new Set(['onMouseMove']);
        const player=Object.create(Player.prototype);
        player.root=root; player.pointers=new Map(); player.mouseTracked=new Set([2,3]); player.idiom="phone";
        const sent=[]; player.event=(id,kind,p)=>sent.push([id,kind,p]);
        player.installInput();
        const childPoint=new DOMPoint(20,30).matrixTransform(new DOMMatrix(getComputedStyle(inner).transform));
        const outerPoint=new DOMPoint(childPoint.x+15,childPoint.y+25);
        const world=outerPoint.matrixTransform(new DOMMatrix(getComputedStyle(outer).transform));
        const event={bubbles:true,pointerType:'mouse',buttons:1,clientX:world.x+70,clientY:world.y+70};
        // Targeting the outer simulates capture: hit testing still finds the inner.
        outer.dispatchEvent(new PointerEvent('pointermove',event));
        const close=(a,b)=>Math.abs(a-b)<0.001;
        if(sent.length!==2 || sent[0][0]!==3 || sent[1][0]!==2 || !close(sent[0][2].position.x,20) || !close(sent[0][2].position.y,30) || sent[0][2].pressedButton!=="left"
          || !close(sent[1][2].position.x,outerPoint.x) || !close(sent[1][2].position.y,outerPoint.y)) throw Error(JSON.stringify(sent));
        inner.style.background='red'; inner.style.left='16px';
        setTimeout(()=>{ document.body.dataset.result=sent.length===2?'passed':'render emitted motion'; },50);
      } catch(e) { document.body.dataset.result='failed: '+e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=1000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], "passed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
