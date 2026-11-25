import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

let chromium;
try { execFileSync('chromium', ['--version'], { stdio: 'ignore' }); chromium = 'chromium'; } catch {}

// The page's DOM drag sequence reaches the engine as `nsh_file_drop`: the
// nearest listening ancestor takes it, its children enter nothing new, a
// view without a listener keeps the browser's default, text drags are left
// alone, and the dropped files' bytes arrive as they are.
test('files dragged in reach the nearest file drop receiver with their bytes', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-file-drop-browser-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><style>
      div { position:absolute; }
      #root { left:0; top:0; width:400px; height:400px; }
      #target { left:10px; top:10px; width:200px; height:200px; }
      #child { left:10px; top:10px; width:50px; height:50px; }
      #plain { left:250px; top:10px; width:100px; height:100px; }
    </style><div id="root"><div id="target"><div id="child"></div></div><div id="plain"></div></div>
    <script type="module">
      import { Player } from '${module}';
      try {
        const $ = (s) => document.querySelector(s);
        const root = $('#root'), target = $('#target'), child = $('#child'), plain = $('#plain');
        root._id = 1; target._id = 2; child._id = 3; plain._id = 4;
        target._events = new Set(['onFileDrop', 'onFileDragEnter', 'onFileDragLeave']);
        child._events = new Set(['onPress']);
        plain._events = new Set(['onPress']);
        const player = Object.create(Player.prototype);
        player.root = root; player.app = 1;
        player.windowLayer = () => root; player.origin = () => [0, 0]; player.layerScale = () => [1, 1];
        const sent = [];
        player.event = (id, kind) => sent.push({ id, kind });
        player.call = (f) => f();
        player.withStrings = (values, f) => f(...values.flatMap((v) => [v, v.length]));
        player.wasm = { nsh_file_drop: (id, kind, json, _jl, bytes) => sent.push({ id, kind: kind ? 'drop' : 'enter', info: JSON.parse(json), text: new TextDecoder().decode(bytes) }) };
        player.installFileDrop(root);
        const files = () => {
          const t = new DataTransfer();
          t.items.add(new File(['hello'], 'a.txt', { type: 'text/plain' }));
          t.items.add(new File([new Uint8Array([0xe4, 0xbd, 0xa0])], 'b.bin'));
          return t;
        };
        const fire = (el, type, dataTransfer) => {
          const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX: 40, clientY: 50 });
          el.dispatchEvent(e);
          return e.defaultPrevented;
        };
        const check = (cond, what) => { if (!cond) throw Error(what + ': ' + JSON.stringify(sent)); };
        const text = new DataTransfer(); text.setData('text/plain', 'x');
        check(!fire(target, 'dragover', text) && sent.length === 0, 'a text drag is left alone');
        check(!fire(plain, 'dragover', files()) && sent.length === 0, 'no receiver keeps the default');
        check(fire(target, 'dragenter', files()) && fire(target, 'dragover', files()), 'the receiver cancels the default');
        check(sent.length === 1 && sent[0].id === 2 && sent[0].kind === 'enter' && sent[0].info.mimeTypes.join() === 'text/plain,', 'one enter with the types');
        fire(target, 'dragleave', files()); fire(child, 'dragenter', files()); fire(child, 'dragover', files());
        await new Promise((r) => setTimeout(r, 100));
        check(sent.length === 1, 'moving onto a child enters nothing new');
        check(fire(child, 'drop', files()), 'the drop on a child goes to its receiver');
        // The bytes are read with real I/O while the page runs on virtual time,
        // so give the read plenty of (virtual) polls before giving up.
        for (let i = 0; i < 500 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
        const drop = sent[1];
        check(drop?.id === 2 && drop.kind === 'drop' && drop.text === 'hello\u4f60', 'the bytes arrive in order');
        check(drop.info.files.map((f) => f.name + ':' + f.size + ':' + f.read).join() === 'a.txt:5:true,b.bin:3:true', 'names and sizes');
        check(drop.info.x === 40 && drop.info.y === 50, 'where it was let go');
        fire(target, 'dragenter', files()); fire(target, 'dragleave', files());
        await new Promise((r) => setTimeout(r, 100));
        check(sent.at(-1).kind === 'onFileDragLeave' && sent.at(-1).id === 2, 'leaving the receiver leaves');
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=20000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
