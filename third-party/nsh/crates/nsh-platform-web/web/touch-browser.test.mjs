import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const chromium = [process.env.CHROME, 'chromium', 'chromium-browser', 'google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((name) => {
  try { execFileSync(name, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
});

test('a zoomable view hands the touch drag it cannot take to the pager around it', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-touch-browser-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>body { margin:0; } #app { width:300px; height:200px; }</style>
    <div id="app"></div>
    <script type="module">
      import { Player } from '${module}';
      const check = (ok, message) => { if (!ok) throw Error(message); };
      const near = (a, b) => Math.abs(a - b) < 1;
      try {
        const p = new Player(document.querySelector('#app'), { history: false });
        p.size = [300, 200];
        p.wasm = new Proxy({}, { get: () => () => -1 });
        p.call = (f) => f(p.wasm);
        p.event = () => {};
        p.installInput();
        const behavior = (b) => ({ paging: false, snapInterval: 0, snapOffsets: [], snapAlignment: 'start', enabled: true,
          bounces: true, inset: [0, 0, 0, 0], minZoom: 1, maxZoom: 1, bouncesZoom: true, pinch: true, centerContent: false,
          refreshIndicator: null, ...b });
        // An image viewer: a horizontal pager of three zoomable views, 300 wide.
        p.op_c(['c', 2, 'scroll']);
        const pager = p.view(2);
        p.root.append(pager);
        p.op_f(['f', 2, 0, 0, 300, 200]);
        p.op_sc(['sc', 2, true, false, null, false]);
        p.op_sbh(['sbh', 2, behavior({ paging: true })]);
        p.op_scs(['scs', 2, 900, 200]);
        for (const n of [0, 1, 2]) {
          const id = 4 + 2 * n;
          p.op_c(['c', id, 'scroll']);
          p.op_i(['i', 2, id, null]);
          p.op_f(['f', id, 300 * n, 0, 300, 200]);
          p.op_sc(['sc', id, false, false, null, false]);
          p.op_sbh(['sbh', id, behavior({ maxZoom: 4 })]);
          p.op_scs(['scs', id, 300, 200]);
          p.op_c(['c', id + 1, 'view']);
          p.op_i(['i', id, id + 1, null]);
          p.op_f(['f', id + 1, 0, 0, 300, 200]);
        }
        const image = p.view(4), photo = p.view(5);
        // Where a release settles, there at once and ended: smooth scrolls and their ends hardly come in virtual time.
        const settles = [];
        pager.scrollTo = (o) => {
          settles.push(o.left);
          Element.prototype.scrollTo.call(pager, { ...o, behavior: 'instant' });
          setTimeout(() => pager.dispatchEvent(new Event('scrollend')));
        };
        // Moves dispatched at once: no speed at the release, which settles on the nearest page.
        const touch = (type, x) => photo.dispatchEvent(new PointerEvent(type,
          { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, buttons: 1, clientX: x, clientY: 100 }));
        const drag = (from, to) => { for (let x = from; x !== to; x += Math.sign(to - from) * 10) touch('pointermove', x); touch('pointermove', to); };
        const settled = async () => {
          for (let i = 0; i < 100 && (pager.style.scrollSnapType || pager.scrollLeft % 300); i++) await new Promise((r) => setTimeout(r, 20));
        };

        // Not zoomed in, a swipe pages.
        touch('pointerdown', 250);
        drag(250, 70);
        check(near(pager.scrollLeft, 180) && image.scrollLeft === 0, 'not zoomed: pager ' + pager.scrollLeft + ', image ' + image.scrollLeft);
        touch('pointerup', 70);
        await settled();
        check(settles.join() === '300' && pager.scrollLeft === 300 && pager.style.scrollSnapType === '',
          'not zoomed: settled at ' + settles + ', now ' + pager.scrollLeft);

        // Zoomed in, a swipe pans the image; at its edge the rest moves the pager, which goes back first.
        pager.scrollLeft = 0;
        p.zoomContent(image, 2, 150, 100, 150, 100);
        check(near(image.scrollLeft, 150), 'zoom: ' + image.scrollLeft);
        touch('pointerdown', 250);
        drag(250, 150);
        check(near(image.scrollLeft, 250) && pager.scrollLeft === 0, 'zoomed: pager ' + pager.scrollLeft + ', image ' + image.scrollLeft);
        drag(150, -100);
        check(near(image.scrollLeft, 300) && near(pager.scrollLeft, 200), 'at the edge: pager ' + pager.scrollLeft + ', image ' + image.scrollLeft);
        drag(-100, 0);
        check(near(image.scrollLeft, 300) && near(pager.scrollLeft, 100), 'back: pager ' + pager.scrollLeft + ', image ' + image.scrollLeft);
        touch('pointerup', 0);
        await settled();
        check(settles.join() === '300,0' && pager.scrollLeft === 0 && pager.style.scrollSnapType === '' && near(image.scrollLeft, 300),
          'released: settled at ' + settles + ', pager ' + pager.scrollLeft + ', image ' + image.scrollLeft);
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=5000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a one-axis scroll view leaves swipes across it to the scroll view around it', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-touch-browser-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>body { margin:0; } #app { width:300px; height:200px; }</style>
    <div id="app"></div>
    <script type="module">
      import { Player } from '${module}';
      const check = (ok, message) => { if (!ok) throw Error(message); };
      try {
        const p = new Player(document.querySelector('#app'), { history: false });
        p.size = [300, 200];
        p.wasm = new Proxy({}, { get: () => () => -1 });
        p.call = (f) => f(p.wasm);
        p.event = () => {};
        p.installInput();
        const behavior = { paging: false, snapInterval: 0, snapOffsets: [], snapAlignment: 'start', enabled: true,
          bounces: true, inset: [0, 0, 0, 0], minZoom: 1, maxZoom: 1, bouncesZoom: true, pinch: true, centerContent: false,
          refreshIndicator: null };
        // A code editor: long lines scroll sideways inside the vertical scroll of all the lines.
        p.op_c(['c', 2, 'scroll']);
        const page = p.view(2);
        p.root.append(page);
        p.op_f(['f', 2, 0, 0, 300, 200]);
        p.op_sc(['sc', 2, false, false, null, false]);
        p.op_sbh(['sbh', 2, behavior]);
        p.op_scs(['scs', 2, 300, 2000]);
        p.op_c(['c', 4, 'scroll']);
        p.op_i(['i', 2, 4, null]);
        p.op_f(['f', 4, 0, 0, 300, 2000]);
        p.op_sc(['sc', 4, true, false, null, false]);
        p.op_sbh(['sbh', 4, behavior]);
        p.op_scs(['scs', 4, 900, 2000]);
        const style = (el) => getComputedStyle(el);
        // Each contains its own axis (no chaining past it, no pull-to-refresh) and passes the other on: the
        // vertical swipe that starts over the lines is the page's.
        check(style(p.view(4)).overscrollBehaviorX === 'contain' && style(p.view(4)).overscrollBehaviorY === 'auto',
          'horizontal: ' + style(p.view(4)).overscrollBehavior);
        check(style(page).overscrollBehaviorY === 'contain' && style(page).overscrollBehaviorX === 'auto',
          'vertical: ' + style(page).overscrollBehavior);
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=5000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a scroll view with nothing to scroll leaves the swipe to the scroll view around it', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-touch-browser-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>body { margin:0; } #app { width:300px; height:200px; }</style>
    <div id="app"></div>
    <script type="module">
      import { Player } from '${module}';
      const check = (ok, message) => { if (!ok) throw Error(message); };
      try {
        const p = new Player(document.querySelector('#app'), { history: false });
        p.size = [300, 200];
        p.wasm = new Proxy({}, { get: () => () => -1 });
        p.call = (f) => f(p.wasm);
        p.event = () => {};
        p.installInput();
        const behavior = (b) => ({ paging: false, snapInterval: 0, snapOffsets: [], snapAlignment: 'start', enabled: true,
          bounces: true, inset: [0, 0, 0, 0], minZoom: 1, maxZoom: 1, bouncesZoom: true, pinch: true, centerContent: false,
          refreshIndicator: null, ...b });
        // A chat: a long transcript scrolls, and a reply's short command output is a scroll view of its own.
        p.op_c(['c', 2, 'scroll']);
        const page = p.view(2);
        p.root.append(page);
        p.op_f(['f', 2, 0, 0, 300, 200]);
        p.op_sc(['sc', 2, false, false, null, false]);
        p.op_sbh(['sbh', 2, behavior()]);
        p.op_scs(['scs', 2, 300, 2000]);
        p.op_c(['c', 4, 'scroll']);
        p.op_i(['i', 2, 4, null]);
        p.op_f(['f', 4, 0, 40, 300, 120]);
        p.op_sc(['sc', 4, false, false, null, false]);
        p.op_sbh(['sbh', 4, behavior()]);
        p.op_scs(['scs', 4, 300, 100]);
        const output = p.view(4);
        const y = (el) => getComputedStyle(el).overscrollBehaviorY;
        // Its content fits: a vertical swipe on it is the transcript's.
        check(y(output) === 'auto', 'fitting: ' + y(output));
        check(y(page) === 'contain', 'transcript: ' + y(page));
        // Once it has more than it shows, it keeps its own axis again; and lets go when its frame grows to fit.
        p.op_scs(['scs', 4, 300, 400]);
        check(y(output) === 'contain', 'overflowing: ' + y(output));
        p.op_f(['f', 4, 0, 40, 300, 400]);
        check(y(output) === 'auto', 'grown: ' + y(output));
        // Sideways the same: a short line in a horizontal one passes a sideways swipe on.
        p.op_c(['c', 6, 'scroll']);
        p.op_i(['i', 2, 6, null]);
        p.op_f(['f', 6, 0, 500, 300, 60]);
        p.op_sc(['sc', 6, true, false, null, false]);
        p.op_sbh(['sbh', 6, behavior()]);
        p.op_scs(['scs', 6, 200, 60]);
        check(getComputedStyle(p.view(6)).overscrollBehaviorX === 'auto', 'short line: ' + getComputedStyle(p.view(6)).overscrollBehaviorX);
        // A zoomable view keeps its own, fitting or not.
        p.op_sbh(['sbh', 6, behavior({ maxZoom: 3 })]);
        check(getComputedStyle(p.view(6)).overscrollBehaviorX === 'contain', 'zoomable: ' + getComputedStyle(p.view(6)).overscrollBehaviorX);
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=5000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a press on a text field or around it reaches its input after the focus a tap gives it', { skip: !chromium }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-touch-browser-'));
  try {
    const source = await readFile(new URL('./nsh.js', import.meta.url), 'utf8');
    const module = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { Player };').toString('base64');
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>body { margin:0; } #app { width:300px; height:200px; }</style>
    <div id="app"></div>
    <script type="module">
      import { Player } from '${module}';
      const check = (ok, message) => { if (!ok) throw Error(message); };
      try {
        const p = new Player(document.querySelector('#app'), { history: false });
        p.size = [300, 200];
        p.wasm = new Proxy({}, { get: () => () => -1 });
        p.call = (f) => f(p.wasm);
        const heard = [];
        p.event = (id, name) => { if (name === 'onPress' || name === 'onFocus') heard.push(id + ' ' + name); };
        p.installInput();
        // A pressable row holding an input that opens a list on a press.
        p.op_c(['c', 2, 'view']);
        p.root.append(p.view(2));
        p.op_f(['f', 2, 0, 0, 300, 200]);
        p.op_e(['e', 2, ['onPress']]);
        p.op_c(['c', 3, 'view']);
        p.op_i(['i', 2, 3, null]);
        p.op_f(['f', 3, 10, 10, 200, 40]);
        p.op_in(['in', 3, { multiline: false, placeholder: '', editable: true, autoCapitalize: 'none' }, null]);
        p.op_e(['e', 3, ['onPress']]);
        const field = p.view(3)._field;
        const pointer = (type, pointerType) => field.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
          pointerId: 1, isPrimary: true, pointerType, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 50, clientY: 30 }));
        const tap = (pointerType) => { heard.length = 0; pointer('pointerdown', pointerType); pointer('pointerup', pointerType); };
        const click = () => field.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 30 }));

        // A tap on the unfocused field: the browser focuses it from the mouse events it makes once the finger
        // lifts, and the press comes after that focus, once (not again with the click that follows).
        tap('touch');
        check(heard.join() === '', 'before the focus: ' + heard);
        field.dispatchEvent(new FocusEvent('focus'));
        click();
        check(heard.join() === '3 onFocus,3 onPress', 'tap: ' + heard);

        // A tap whose focus does not come is pressed by its click.
        tap('touch');
        click();
        check(heard.join() === '3 onPress', 'tap without a focus: ' + heard);

        // A click on the focused field is pressed as it ends; the row around it hears no press.
        field.focus();
        check(document.activeElement === field, 'focused: ' + document.activeElement?.tagName);
        tap('mouse');
        check(heard.join() === '3 onPress', 'click: ' + heard);

        // A tap whose focus does not come is forgotten once the mouse events of the tap are over (a key, a click
        // elsewhere, a short wait): a focus that comes later another way reports no press.
        const unfocused = (end) => async () => {
          field.blur();
          tap('touch');
          await end();
          field.dispatchEvent(new FocusEvent('focus'));
          check(heard.join() === '3 onFocus', 'stale press: ' + heard);
        };
        await unfocused(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })))();
        await unfocused(() => p.view(2).dispatchEvent(new MouseEvent('click', { bubbles: true })))();
        await unfocused(() => new Promise((resolve) => setTimeout(resolve, 1100)))();

        // The input's padding around its field is the field's too: a press there focuses the field and is the
        // input's press, as on its text, and the row around it hears none.
        p.op_ic(['ic', 3, 10, 5, 180, 30]);
        const input = p.view(3);
        const around = (type, pointerType) => input.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
          pointerId: 1, isPrimary: true, pointerType, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 12, clientY: 12 }));
        const mouse = (type) => input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
          buttons: type === 'mousedown' ? 1 : 0, clientX: 12, clientY: 12 }));
        check(document.elementFromPoint(12, 12) === input, 'padding: ' + document.elementFromPoint(12, 12)?.className);
        // A click: the focus as it goes down, the press as it ends.
        field.blur();
        heard.length = 0;
        around('pointerdown', 'mouse');
        mouse('mousedown');
        check(document.activeElement === field, 'click around: ' + document.activeElement?.tagName);
        around('pointerup', 'mouse');
        mouse('mouseup');
        mouse('click');
        check(heard.join() === '3 onFocus,3 onPress', 'click around: ' + heard);
        // A tap: the focus with the mouse events once the finger lifts, the press after it.
        field.blur();
        heard.length = 0;
        around('pointerdown', 'touch');
        around('pointerup', 'touch');
        check(heard.join() === '', 'tap around, before the focus: ' + heard);
        mouse('mousedown');
        mouse('mouseup');
        mouse('click');
        check(document.activeElement === field, 'tap around: ' + document.activeElement?.tagName);
        check(heard.join() === '3 onFocus,3 onPress', 'tap around: ' + heard);

        // An input that does not listen leaves the press to no one, and a press around its field still focuses it.
        p.op_e(['e', 3, []]);
        tap('mouse');
        tap('touch');
        click();
        check(heard.join() === '', 'not listening: ' + heard);
        field.blur();
        around('pointerdown', 'mouse');
        mouse('mousedown');
        around('pointerup', 'mouse');
        mouse('click');
        check(document.activeElement === field, 'not listening, around: ' + document.activeElement?.tagName);
        check(heard.join() === '3 onFocus', 'not listening, around: ' + heard);
        document.body.dataset.result = 'passed';
      } catch (e) { document.body.dataset.result = 'failed: ' + e.message; }
    </script>`);
    const html = execFileSync(chromium, ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=5000',
      '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(join(dir, 'index.html')).href],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.equal(html.match(/data-result="([^"]*)"/)?.[1], 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
