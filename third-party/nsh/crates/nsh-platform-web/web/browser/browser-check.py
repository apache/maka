"""Player lifecycle checks on Chromium, Firefox and WebKit; Chromium interaction checks.

Requires Python Playwright and its browser binaries. Use --wasm with a browser
(or browser-tests) Wasm build. Failures are saved under .nsh/browser-tests.
"""
import argparse
import asyncio
import functools
import http.server
import json
import pathlib
import shutil
import tempfile
import threading
import traceback
from contextlib import contextmanager

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError, async_playwright


async def check_scroll_content(page):
    """A scroll view's contentStyle / contentClass style a container its children go into."""
    warnings = []
    listen = lambda message: warnings.append(message.text)
    page.on("console", listen)
    await page.evaluate("errors.length=0; player.options.onError=e=>errors.push(e); player.runModule('./scroll.js')")
    await page.locator("[data-testid=first]").wait_for()
    offset = lambda test_id: page.evaluate('''id=>{
      const el=document.querySelector(`[data-testid=${id}]`);
      if(!el) return null;
      const box=el.getBoundingClientRect(), scroll=document.querySelector('[data-testid=scroll]').getBoundingClientRect();
      return [box.left-scroll.left, box.top-scroll.top];
    }''', test_id)
    # Set after its first child was added: that child moves into the container.
    # Waits for the padding to show; without it the assertion below says where the child is.
    try:
        await page.wait_for_function(
            "document.querySelector('[data-testid=first]').getBoundingClientRect().left > 0", timeout=2000)
    except TimeoutError:
        pass
    seen = {"first": await offset("first"), "last": await offset("last")}
    # Added once the container exists, before a child already in it: it goes into the container, in order.
    await page.evaluate("document.querySelector('iframe').contentWindow.toggleExtra()")
    await page.locator("[data-testid=extra]").wait_for()
    seen["extra"] = await offset("extra")
    seen["last (extra shown)"] = await offset("last")
    await page.evaluate("document.querySelector('iframe').contentWindow.toggleExtra()")
    await page.locator("[data-testid=extra]").wait_for(state="detached")
    seen["removed"] = await offset("extra")
    seen["last (extra removed)"] = await offset("last")
    page.remove_listener("console", listen)
    # Padding 30, gap-4 (16) between children 10 high.
    assert seen == {
        "first": [30, 30],
        "last": [30, 56],
        "extra": [30, 56],
        "last (extra shown)": [30, 82],
        "removed": None,
        "last (extra removed)": [30, 56],
    }, seen
    assert not [w for w in warnings if "unsupported prop" in w], warnings
    assert await page.evaluate("errors.length") == 0, await page.evaluate("errors.map(String)")
    await page.evaluate("player.stop()")


APP_SOURCE = '''import {mount,signal,cleanup,host} from 'nsh';
import {element,prop,append,insert} from 'nsh:rt';
const run=parent.harness.active;
mount(()=>{
  const count=signal(0),root=element('view'),label=element('text');
  prop(root,'style',{width:240,height:60});prop(label,'testID','count');
  insert(label,()=>`${run}:${count()}`);append(root,label);
  host.on('ping',()=>{count.update(n=>n+1);parent.harness.events.push(`ping:${run}`);});
  cleanup(()=>parent.harness.events.push(`cleaned:${run}`));
  parent.harness.events.push(`mounted:${run}`);
  return root;
});
'''


@contextmanager
def serve(wasm):
    with tempfile.TemporaryDirectory(prefix="nsh-browser-") as directory:
        root = pathlib.Path(directory)
        source = pathlib.Path(__file__).resolve().parent.parent
        shutil.copytree(source, root, dirs_exist_ok=True)
        shutil.copyfile(wasm, root / "nsh.wasm")
        (root / "platform.js").write_text('''import {mount,signal} from 'nsh';
import {element,prop,bindProp,append} from 'nsh:rt';
mount(()=>{const root=element('view');const view=element('view');prop(view,'testID','platform');
// A platform object replaces the element's prop, it does not merge with it: each sets the whole style.
const style=backgroundColor=>({width:60,height:20,backgroundColor});
const web=signal({style:style('#00ff00')});window.dropWebStyle=()=>web.set({});
bindProp(view,'web',()=>web());prop(view,'desktop',{accessibilityLabel:'desktop'});
// Set last, so either would override the web's style if it applied.
prop(view,'ios',{style:style('#ff0000'),accessibilityLabel:'ios'});
prop(view,'android',{style:style('#ff0000'),accessibilityLabel:'android'});
append(root,view);return root;});
''')
        (root / "index.html").write_text('''<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div><script type="module">
import {createPlayer} from './nsh.js';
window.errors=[];
window.harness={events:[],gates:{},outcomes:{},expectedReports:[]};
window.player=await createPlayer(document.querySelector('#app'),{wasm:'./nsh.wasm',onError:e=>errors.push(String(e))});
window.ready=true;
</script>''')
        (root / "app.js").write_text(APP_SOURCE)
        (root / "hot.js").write_text('''import "nsh:hot";
import * as nsh from "nsh";
import * as rt from "nsh:rt";
__nsh_hot.define("App.js",function(module,exports,require){
''' + APP_SOURCE.replace(
            "import {mount,signal,cleanup,host} from 'nsh';",
            'const {mount,signal,cleanup,host}=require("nsh");').replace(
            "import {element,prop,append,insert} from 'nsh:rt';",
            'const {element,prop,append,insert}=require("nsh:rt");') + '''
});
__nsh_hot.start("App.js",{"nsh":{...nsh,__esModule:true},"nsh:rt":{...rt,__esModule:true}});
''')
        (root / "brands.js").write_text(APP_SOURCE.replace(
            "cleanup(()=>parent.harness.events.push(`cleaned:${run}`));",
            "cleanup(()=>{parent.harness.events.push(`cleaned:${run}`);parent.result.cleaned++;});") + '''
import {nextTick,View} from 'nsh';
import {Menu} from 'nsh/desktop';
import {InputAccessoryView} from 'nsh/mobile';
import {Buffer} from 'buffer';
const result=parent.result;
host.on('before', value=>result.events.push(value));
try { nextTick(null); } catch(e) { result.errorBrand=e instanceof TypeError; }
result.functionBrand=View instanceof Function && InputAccessoryView instanceof Function;
result.promiseBrand=Menu.popup([]) instanceof Promise;
result.bufferBrand=Buffer.from('abc') instanceof Uint8Array;
result.runs++;
''')
        (root / "scroll.js").write_text('''import {mount,signal} from 'nsh';
import {element,prop,append,insert} from 'nsh:rt';
mount(()=>{const root=element('view');const scroll=element('scroll');
prop(scroll,'testID','scroll');prop(scroll,'style',{position:'absolute',left:0,top:0,width:200,height:200});
const first=element('view');prop(first,'testID','first');prop(first,'style',{width:50,height:10});append(scroll,first);
prop(scroll,'contentStyle',{padding:30});prop(scroll,'contentClass','gap-4');
const last=element('view');prop(last,'testID','last');prop(last,'style',{width:50,height:10});append(scroll,last);
const show=signal(false);window.toggleExtra=()=>show.set(!show());
const extra=element('view');prop(extra,'testID','extra');prop(extra,'style',{width:50,height:10});
insert(scroll,()=>show()?extra:null,last);
append(root,scroll);return root;});
''')
        (root / "bad.js").write_text("import './app.js'; throw new Error('fixture startup failed');")
        (root / "slow.js").write_text("import './app.js'; parent.harness.events.push('entered:slow'); await parent.harness.gates.slow.promise;")
        (root / "held.js").write_text(APP_SOURCE)
        (root / "styles.js").write_text('''import {mount} from 'nsh';
import {element,prop,append} from 'nsh:rt';
mount(()=>{const root=element('view');const view=element('view');
prop(view,'testID','styled');prop(view,'onPress',()=>{});
prop(view,'style',{position:'absolute',left:20,top:20,width:100,height:40,backgroundColor:'#0000ff'});
prop(view,'hoverStyle',{backgroundColor:'#ffff00'});prop(view,'activeStyle',{backgroundColor:'#00ff00'});
append(root,view);return root;});
''')
        (root / "states.js").write_text('''import {mount,List} from 'nsh';
import {element,prop,append} from 'nsh:rt';
const box=(id,props)=>{const v=element('view');prop(v,'testID',id);
prop(v,'style',{width:60,height:20,margin:4,backgroundColor:'#0000ff'});
for(const [k,x] of Object.entries(props)) prop(v,k,x);return v;};
const on={backgroundColor:'#00ff00'};
mount(()=>{const root=element('view');
const cleared=box('cleared',{disabled:true,disabledStyle:on});window.clearStyle=()=>prop(cleared,'disabledStyle',undefined);
const within=box('within',{focusWithinStyle:on});append(within,box('inner',{focusable:true,style:{width:20,height:10,backgroundColor:'#ffffff'}}));
for(const v of [
box('disabled',{disabled:true,disabledStyle:on}),
box('selected',{accessibilityState:{selected:true},selectedStyle:on}),
box('checked',{accessibilityState:{checked:true},checkedStyle:on}),
box('mixed',{accessibilityState:{checked:'mixed'},indeterminateStyle:on}),
box('expanded',{accessibilityState:{expanded:true},expandedStyle:on}),
box('pressed',{accessibilityState:{pressed:true},pressedStyle:on}),
box('focus',{focusable:true,focusStyle:on}),
within,cleared]) append(root,v);
const list=List({each:[1],contentClass:'px-[7px]',style:{width:100,height:40},children:()=>box('row',{})});
const holder=element('view');prop(holder,'testID','list');append(holder,list);append(root,holder);
const screen=element('screen');prop(screen,'headerStyle',{backgroundColor:'#ff0000'});prop(screen,'headerClass','bg-red-500');
return root;});
''')
        (root / "tooltip.js").write_text('''import {mount,signal} from 'nsh';
import {element,prop,append,text} from 'nsh:rt';
mount(()=>{const root=element('view');const trigger=element('view');prop(trigger,'testID','trigger');
prop(trigger,'style',{position:'absolute',left:40,top:120,width:120,height:40,backgroundColor:'#cccccc'});
const hint=label=>{const view=element('view');const words=element('text');append(words,text(label));append(view,words);return view;};
const first=hint('first hint'),second=hint('second hint');const shown=signal(first);window.showSecond=()=>shown.set(second);
// A function, as a development bundle gives an app's component (its hot proxy's memo).
prop(trigger,'tooltip',()=>shown());
append(root,trigger);return root;});
''')
        (root / "cleanup.js").write_text(APP_SOURCE.replace(
            "cleanup(()=>parent.harness.events.push(`cleaned:${run}`));",
            "cleanup(()=>{const e=new Error('fixture cleanup failed');parent.harness.expectedReports.push(e.stack??String(e));throw e;});cleanup(()=>parent.harness.events.push(`cleaned:${run}`));"))
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        page_origin = f"http://127.0.0.1:{server.server_port}"

        class CorsHandler(http.server.SimpleHTTPRequestHandler):
            def end_headers(self):
                self.send_header("Access-Control-Allow-Origin", page_origin)
                super().end_headers()

        cdn = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
            functools.partial(CorsHandler, directory=directory))
        (root / "cdn.html").write_text((root / "index.html").read_text().replace(
            "from './nsh.js'", f"from 'http://127.0.0.1:{cdn.server_port}/nsh.js'"))
        servers = [server, cdn]
        threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in servers]
        for thread in threads:
            thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/index.html"
        finally:
            for s, thread in zip(servers, threads, strict=True):
                s.shutdown()
                s.server_close()
                thread.join()


async def check_platform_props(page):
    """Web and desktop props apply; removing a key clears its previous value."""
    await page.evaluate("player.runModule('./platform.js')")
    view = page.locator("[data-testid=platform]")
    await view.wait_for(state="attached")
    seen = {"set": await view.evaluate("el => [getComputedStyle(el).backgroundColor, el.getAttribute('aria-label')]")}
    await page.evaluate("document.querySelector('iframe').contentWindow.dropWebStyle()")
    await page.wait_for_function(
        "getComputedStyle(document.querySelector('[data-testid=platform]')).backgroundColor !== 'rgb(0, 255, 0)'")
    seen["web emptied"] = await view.evaluate("el => [getComputedStyle(el).backgroundColor, el.getAttribute('aria-label')]")
    assert seen == {
        "set": ["rgb(0, 255, 0)", "desktop"],
        "web emptied": ["rgba(0, 0, 0, 0)", "desktop"],
    }, seen


async def check_state_styles(page):
    """A view's state styles apply as the pointer moves over it and presses it."""
    warnings = []
    listen = lambda message: warnings.append(message.text)
    page.on("console", listen)
    await page.evaluate("errors.length=0; player.options.onError=e=>errors.push(e); player.runModule('./styles.js')")
    view = page.locator("[data-testid=styled]")
    await view.wait_for()
    handle = await view.element_handle()
    color = lambda: view.evaluate("el => getComputedStyle(el).backgroundColor")

    async def settle(expected):
        # The restyle lands on a later frame; without the fix the assertion below says what it read.
        try:
            await page.wait_for_function(
                "([el, c]) => getComputedStyle(el).backgroundColor === c", arg=[handle, expected], timeout=2000)
        except TimeoutError:
            pass
        return await color()

    box = await view.bounding_box()
    seen = {"rest": await color()}
    await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    seen["hover"] = await settle("rgb(255, 255, 0)")
    await page.mouse.down()
    seen["press"] = await settle("rgb(0, 255, 0)")
    await page.mouse.up()
    seen["release"] = await settle("rgb(255, 255, 0)")
    await page.mouse.move(0, 0)
    seen["leave"] = await settle("rgb(0, 0, 255)")
    page.remove_listener("console", listen)
    assert seen == {
        "rest": "rgb(0, 0, 255)",
        "hover": "rgb(255, 255, 0)",
        "press": "rgb(0, 255, 0)",
        "release": "rgb(255, 255, 0)",
        "leave": "rgb(0, 0, 255)",
    }, seen
    assert not [w for w in warnings if "unsupported prop" in w], warnings
    assert await page.evaluate("errors.length") == 0, await page.evaluate("errors.map(String)")
    await page.evaluate("player.stop()")


async def check_other_states(page):
    """The other state styles and a list's contentClass apply; a page's header styles are accepted."""
    warnings = []
    listen = lambda message: warnings.append(message.text)
    page.on("console", listen)
    await page.evaluate("errors.length=0; player.options.onError=e=>errors.push(e); player.runModule('./states.js')")
    await page.locator("[data-testid=row]").wait_for()
    green, blue = "rgb(0, 255, 0)", "rgb(0, 0, 255)"
    color = lambda test_id: page.locator(f"[data-testid={test_id}]").evaluate("el => getComputedStyle(el).backgroundColor")

    async def settle(test_id, expected):
        # The restyle lands on a later frame; without the fix the assertion below says what it read.
        try:
            await page.wait_for_function(
                "([id, c]) => getComputedStyle(document.querySelector(`[data-testid=${id}]`)).backgroundColor === c",
                arg=[test_id, expected], timeout=2000)
        except TimeoutError:
            pass
        return await color(test_id)

    seen = {}
    for test_id in ["disabled", "selected", "checked", "mixed", "expanded", "pressed"]:
        seen[test_id] = await settle(test_id, green)
    seen["focus (rest)"] = await color("focus")
    await page.mouse.click(1000, 700)
    await page.keyboard.press("Tab")
    seen["focus"] = await settle("focus", green)
    seen["within (rest)"] = await color("within")
    await page.keyboard.press("Tab")
    seen["within"] = await settle("within", green)
    seen["focus (left)"] = await settle("focus", blue)
    await page.keyboard.press("Tab")
    seen["within (left)"] = await settle("within", blue)
    # Setting a state style to undefined clears it.
    seen["cleared (set)"] = await settle("cleared", green)
    await page.evaluate("document.querySelector('iframe').contentWindow.clearStyle()")
    seen["cleared"] = await settle("cleared", blue)
    seen["row offset"] = await page.evaluate('''()=>{
      const row=document.querySelector('[data-testid=row]').getBoundingClientRect();
      const list=document.querySelector('[data-testid=list]').getBoundingClientRect();
      return row.left-list.left;
    }''')
    page.remove_listener("console", listen)
    assert seen == {
        **{test_id: green for test_id in ["disabled", "selected", "checked", "mixed", "expanded", "pressed"]},
        "focus (rest)": blue,
        "focus": green,
        "within (rest)": blue,
        "within": green,
        "focus (left)": blue,
        "within (left)": blue,
        "cleared (set)": green,
        "cleared": blue,
        # The list's `px-[7px]` content padding plus the row's 4-point margin.
        "row offset": 11,
    }, seen
    assert not [w for w in warnings if "unsupported prop" in w], warnings
    assert await page.evaluate("errors.length") == 0, await page.evaluate("errors.map(String)")
    await page.evaluate("player.stop()")


async def check_tooltip_function(page):
    """A tooltip given by a function shows the element it gives and follows it."""
    await page.evaluate("errors.length=0; player.options.onError=e=>errors.push(e); player.runModule('./tooltip.js')")
    trigger = page.locator("[data-testid=trigger]")
    await trigger.wait_for()

    async def hover(expected):
        # No hint left from before; then a tooltip shows once the pointer has rested on its element for 500 ms.
        await page.mouse.move(1000, 700)
        try:
            await page.wait_for_function("!/(first|second) hint/.test(document.body.innerText)", timeout=3000)
        except TimeoutError:
            shown = await page.evaluate("document.body.innerText")
            raise AssertionError(f"a hint still shows before hovering for {expected!r}: {shown!r}")
        box = await trigger.bounding_box()
        await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        # Without the fix no hint shows: the assertion below says so.
        try:
            await page.wait_for_function("t => document.body.innerText.includes(t)", arg=expected, timeout=3000)
        except TimeoutError:
            pass
        shown = await page.evaluate("document.body.innerText")
        return [label for label in ["first hint", "second hint"] if label in shown]

    seen = {"first": await hover("first hint")}
    await page.evaluate("document.querySelector('iframe').contentWindow.showSecond()")
    seen["second"] = await hover("second hint")
    await page.mouse.move(1000, 700)
    assert seen == {"first": ["first hint"], "second": ["second hint"]}, seen
    assert await page.evaluate("errors.length") == 0, await page.evaluate("errors.map(String)")
    await page.evaluate("player.stop()")


async def begin(page, run, entry="./app.js", *, source=False, options=None):
    # Observe rejection immediately: a cancelled startup can finish while Python
    # is checking its replacement. Never leave a rejected promise unhandled.
    await page.evaluate('''({run,entry,source,options})=>{
      harness.active=run;
      const load=source ? player.runSource(entry) : player.runModule(entry,options);
      load.then(()=>harness.outcomes[run]={status:'resolved'},
        e=>harness.outcomes[run]={status:'rejected',error:String(e),report:e.stack??String(e)});
    }''', {"run": run, "entry": entry, "source": source, "options": options or {}})


async def outcome(page, run, status="resolved", error=None):
    await page.wait_for_function("run => !!harness.outcomes[run]", arg=run)
    result = await page.evaluate("run => harness.outcomes[run]", run)
    assert result["status"] == status, result
    if error:
        assert error in result.get("error", ""), result


async def rendered(page, run, count=0):
    await page.wait_for_function(
        "text => document.querySelector('[data-testid=count]')?.textContent === text",
        arg=f"{run}:{count}")


async def ping(page, run, count=1):
    await page.evaluate("player.hostEvent('ping',null)")
    await rendered(page, run, count)


async def stopped(page, runs):
    await page.evaluate("player.stop();player.stop()")
    assert await page.locator("iframe").count() == 0
    events = await page.evaluate("harness.events")
    for run in runs:
        assert events.count(f"cleaned:{run}") == 1, events


async def start(page, run, entry="./app.js", **options):
    await begin(page, run, entry, **options)
    await outcome(page, run)
    await rendered(page, run)
    await ping(page, run)


async def import_map_order(page):
    scripts = await page.evaluate('''()=>Array.from(
      document.querySelector('iframe').contentDocument.scripts,
      script=>({type:script.type,src:script.src,map:script.type==='importmap'?JSON.parse(script.textContent).imports:null}))''')
    assert [script["type"] for script in scripts] == ["", "importmap", "module"], scripts
    assert scripts[0]["src"].endswith("/browser/bootstrap.js"), scripts
    assert scripts[2]["src"].endswith("/browser/realm.js"), scripts
    assert {"nsh", "nsh:rt", "buffer"} <= scripts[1]["map"].keys(), scripts


async def check_module(page):
    # No nativeExports metadata: the complete catalog still precedes the first
    # module load, including engines that ignore maps inserted afterwards.
    await start(page, "module")
    await import_map_order(page)
    await stopped(page, ["module"])


async def check_source(page):
    await start(page, "module")
    await start(page, "source", APP_SOURCE, source=True)
    assert await page.locator("iframe").count() == 1
    await stopped(page, ["module", "source"])


async def check_native_exports(page):
    await start(page, "native", options={"nativeExports": {
        "nsh": ["mount", "signal", "cleanup", "host"],
        "nsh:rt": ["element", "prop", "append", "insert"],
    }})
    await import_map_order(page)
    await stopped(page, ["native"])


async def check_namespace(page):
    source = APP_SOURCE.replace(
        "import {mount,signal,cleanup,host} from 'nsh';",
        "import * as nsh from 'nsh'; const {mount,signal,cleanup,host}=nsh;")
    await start(page, "namespace", source, source=True)
    await import_map_order(page)
    await stopped(page, ["namespace"])


async def check_development(page):
    await start(page, "development", "./hot.js")
    await import_map_order(page)
    assert await page.evaluate("typeof document.querySelector('iframe').contentWindow.__nsh_hot.start") == "function"
    await stopped(page, ["development"])


async def check_repeated(page):
    runs = [f"repeat-{i}" for i in range(3)]
    for run in runs:
        await start(page, run)
        await stopped(page, [run])
    await stopped(page, runs)


async def check_brands(page):
    await page.evaluate("window.result={events:[],runs:0,cleaned:0}")
    for i in range(3):
        await page.evaluate("i => player.hostEvent('before',i)", i)
        await start(page, f"brand-{i}", "./brands.js")
        await stopped(page, [f"brand-{i}"])
    result = await page.evaluate("result")
    assert result["events"] == [0, 1, 2], result
    assert result["runs"] == result["cleaned"] == 3, result
    assert all(result[key] for key in ["errorBrand", "functionBrand", "promiseBrand", "bufferBrand"]), result


async def check_startup_failure(page):
    await begin(page, "bad", "./bad.js")
    await outcome(page, "bad", "rejected", "fixture startup failed")
    await page.evaluate("harness.expectedReports.push(harness.outcomes.bad.report)")
    await stopped(page, ["bad"])
    assert len(await page.evaluate("errors")) == 1
    await start(page, "recovered")
    await stopped(page, ["bad", "recovered"])


async def check_loading(page, replace):
    entered, release, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
    failures = []

    async def hold(route):
        entered.set()
        await release.wait()
        try:
            await route.fulfill(status=200, content_type="text/javascript", body=APP_SOURCE)
        except PlaywrightError as error:
            # Removing the iframe may cancel its request before the gate opens.
            # Only that cancellation is allowed, not an arbitrary routing error.
            if not route.request.failure:
                failures.append(str(error))
        finally:
            finished.set()

    await page.route("**/held.js", hold)
    try:
        await begin(page, "old", "./held.js")
        await asyncio.wait_for(entered.wait(), 10)
        if replace:
            await start(page, "new")
        else:
            await page.evaluate("player.stop()")
        await outcome(page, "old", "rejected", "disposed")
        if not replace:
            assert await page.locator("iframe").count() == 0
        release.set()
        await asyncio.wait_for(finished.wait(), 10)
        assert not failures, failures
        if not replace:
            await start(page, "new")
        await ping(page, "new", 2)
        await stopped(page, ["new"])
    finally:
        release.set()
        await page.unroute("**/held.js", hold)


async def check_tla(page, replace):
    await page.evaluate('''()=>{
      let release;const promise=new Promise(resolve=>release=resolve);
      harness.gates.slow={promise,release};
    }''')
    try:
        await begin(page, "old", "./slow.js")
        await page.wait_for_function("harness.events.includes('entered:slow')")
        await rendered(page, "old")
        if replace:
            await start(page, "new")
        else:
            await stopped(page, ["old"])
        await outcome(page, "old", "rejected", "disposed")
        await page.evaluate("harness.gates.slow.release()")
        # The detached realm need not resume its continuation. Assert the
        # public cancellation result and that its replacement stays usable.
        if not replace:
            await start(page, "new")
        await ping(page, "new", 2)
        await stopped(page, ["old", "new"])
    finally:
        await page.evaluate("harness.gates.slow.release()")


async def check_facade_failure(page, script):
    pattern = f"**/browser/{script}"
    await page.route(pattern, lambda route: route.abort())
    try:
        await begin(page, "failed")
        reason = "could not load the browser facade" if script == "bootstrap.js" else "could not load the app realm"
        await outcome(page, "failed", "rejected", reason)
        await page.evaluate("harness.expectedReports.push(harness.outcomes.failed.report)")
        assert await page.locator("iframe").count() == 0
        assert len(await page.evaluate("errors")) == 1
    finally:
        await page.unroute(pattern)
    await start(page, "recovered")
    await stopped(page, ["recovered"])


async def check_bootstrap_execution_failure(page, code, expected_error=None):
    pattern = "**/browser/bootstrap.js"
    origin = await page.evaluate("location.origin")
    await page.route(pattern, lambda route: route.fulfill(
        status=200, content_type="text/javascript", body=code,
        headers={"Access-Control-Allow-Origin": origin}))
    try:
        await begin(page, "failed")
        await outcome(page, "failed", "rejected")
        await page.evaluate("harness.expectedReports.push(harness.outcomes.failed.report)")
        if expected_error is not None:
            assert await page.evaluate("harness.outcomes.failed.error") == expected_error
        assert await page.locator("iframe").count() == 0
        assert len(await page.evaluate("errors")) == 1
    finally:
        await page.unroute(pattern)
    await start(page, "recovered")
    await stopped(page, ["recovered"])


async def check_cdn_bootstrap(page):
    await page.goto(page.url.replace("/index.html", "/cdn.html"))
    await page.wait_for_function("window.ready")
    await start(page, "cdn")
    await import_map_order(page)
    assert await page.evaluate('''()=>Array.from(
      document.querySelector('iframe').contentDocument.scripts).filter(s=>s.src)
      .every(s=>new URL(s.src).origin !== location.origin)''')
    await stopped(page, ["cdn"])
    # A successful cross-origin fetch must also retain execution errors rather
    # than muting them to a generic missing-initialization failure.
    await check_bootstrap_execution_failure(page, "throw 0;", expected_error="0")


async def check_cleanup_failure(page):
    await page.evaluate('''()=>{
      harness.reports=0;
      player.options.onError=e=>{errors.push(String(e));harness.reports++;player.reset();};
    }''')
    await start(page, "cleanup", "./cleanup.js")
    await stopped(page, ["cleanup"])
    assert await page.evaluate("harness.reports") == 1
    await start(page, "recovered")
    await stopped(page, ["cleanup", "recovered"])
    assert await page.evaluate("harness.reports") == 1


def lifecycle_cases():
    return [
        ("module", check_module, ()),
        ("cdn-bootstrap", check_cdn_bootstrap, ()),
        ("source-replaces-module", check_source, ()),
        ("native-exports", check_native_exports, ()),
        ("namespace-import", check_namespace, ()),
        ("development-factory", check_development, ()),
        ("repeated-start-stop", check_repeated, ()),
        ("host-queue-and-brands", check_brands, ()),
        ("startup-failure", check_startup_failure, ()),
        *[(f"loading-{action}", functools.partial(check_loading, replace=action == "replace"), ("/held.js",))
          for action in ("stop", "replace")],
        *[(f"tla-{action}", functools.partial(check_tla, replace=action == "replace"), ())
          for action in ("stop", "replace")],
        *[(f"failed-{script[:-3]}", functools.partial(check_facade_failure, script=script),
           (f"/browser/{script}",)) for script in ("bootstrap.js", "realm.js")],
        *[(f"bootstrap-{name}", functools.partial(check_bootstrap_execution_failure, code=code), ())
          for name, code in [("syntax-error", "const = ;"),
                             ("throw", "throw new Error('fixture bootstrap failed');"),
                             ("missing-callback", "void 0;")]],
        ("bootstrap-falsy-throw", functools.partial(check_bootstrap_execution_failure,
                                                  code="throw 0;", expected_error="0"), ()),
        ("cleanup-failure", check_cleanup_failure, ()),
    ]


def unexpected(log, reports, failed_paths):
    errors = []
    for message in log:
        text = message.get("text", "")
        url = message.get("url", "")
        if message["kind"] == "requestfailed":
            if not any(url.endswith(path) for path in failed_paths):
                errors.append(message)
        elif message["kind"] == "pageerror" or message.get("type") == "error":
            if message["kind"] == "console" and text in [f"[nsh] {report}" for report in reports]:
                continue
            # Browser resource diagnostics differ; only the deliberately failed
            # request's own URL is allowed, not every error in a negative case.
            if message["kind"] == "console" and any(url.endswith(path) for path in failed_paths):
                continue
            errors.append(message)
        elif message.get("type") == "warning" and "unsupported prop" in text:
            errors.append(message)
    return errors


async def run_case(browser, url, directory, name, test, failed_paths):
    directory = directory / name
    directory.mkdir(parents=True, exist_ok=True)
    for artifact in ("trace.zip", "failure.png"):
        (directory / artifact).unlink(missing_ok=True)
    context, page, tracing = None, None, False
    log = []
    result = {"case": name, "stage": "context-setup", "status": "failed", "log": log}
    try:
        async with asyncio.timeout(45):
            context = await browser.new_context(viewport={"width": 1280, "height": 720})
            result["stage"] = "trace-setup"
            await context.tracing.start(screenshots=True, snapshots=True, sources=True)
            tracing = True
            result["stage"] = "page-setup"
            page = await context.new_page()
            page.set_default_timeout(10000)
            page.on("console", lambda m: log.append({"kind": "console", "type": m.type, "text": m.text, "url": m.location.get("url", "")}))
            page.on("pageerror", lambda e: log.append({"kind": "pageerror", "text": str(e)}))
            page.on("requestfailed", lambda r: log.append({"kind": "requestfailed", "url": r.url, "text": r.failure}))
            result["stage"] = "page-startup"
            await page.goto(url)
            await page.wait_for_function("window.ready")
            result["stage"] = "check"
            await test(page)
            result["stage"] = "stop"
            await page.evaluate("player.stop()")
            assert await page.locator("iframe").count() == 0
            result["stage"] = "errors"
            reported, expected = await page.evaluate("[errors,harness.expectedReports]")
            # WebKit's Error.stack omits the message. Compare the exact stack
            # observed at the deliberate throw/rejection, not its formatting.
            assert reported == expected, {"reported": reported, "expected": expected}
            assert not unexpected(log, expected, failed_paths), unexpected(log, expected, failed_paths)
            result.update(status="passed", stage="done")
    except Exception:
        result["error"] = traceback.format_exc()
    finally:
        if page:
            try:
                async with asyncio.timeout(10):
                    result["fixture"] = await page.evaluate("({events:window.harness?.events,outcomes:window.harness?.outcomes,errors:window.errors,frames:document.querySelectorAll('iframe').length})")
                    if result["status"] != "passed":
                        await page.screenshot(path=str(directory / "failure.png"), full_page=True, timeout=5000)
            except Exception as error:
                result["diagnostic_error"] = str(error)
            try:
                async with asyncio.timeout(5):
                    await page.evaluate("window.player?.stop()")
            except Exception as error:
                result.update(status="failed", stop_error=str(error))
        if tracing and context:
            try:
                await asyncio.wait_for(context.tracing.stop(
                    **({"path": str(directory / "trace.zip")} if result["status"] != "passed" else {})), 10)
            except Exception as error:
                result.update(status="failed", trace_error=str(error))
        if context:
            try:
                await asyncio.wait_for(context.close(), 10)
            except Exception as error:
                result.update(status="failed", close_error=str(error))
        (directory / "result.json").write_text(json.dumps(result, indent=2))
    print(f"{browser.browser_type.name} {name}: {result['status']} ({result['stage']})", flush=True)
    if result["status"] != "passed":
        print(result.get("error", result), flush=True)
    return result["status"] == "passed"


async def check(wasm, chrome, browser_name, suite, artifacts):
    directory = pathlib.Path(artifacts) / browser_name
    directory.mkdir(parents=True, exist_ok=True)
    summary = {"browser": browser_name, "suite": suite, "status": "failed"}
    try:
        with serve(wasm) as url:
            async with async_playwright() as playwright:
                options: dict = {"timeout": 20000}
                if browser_name == "chromium":
                    options["args"] = ["--no-sandbox"]
                if chrome:
                    options["executable_path"] = chrome
                browser = await getattr(playwright, browser_name).launch(**options)
                summary["version"] = browser.version
                try:
                    cases = lifecycle_cases() if suite in ("all", "lifecycle") else []
                    if suite in ("all", "interaction"):
                        cases += [(name, test, ()) for name, test in [
                            ("platform-props", check_platform_props),
                            ("pointer-styles", check_state_styles),
                            ("state-styles", check_other_states),
                            ("tooltip", check_tooltip_function),
                            ("scroll-content", check_scroll_content),
                        ]]
                    passed = [await run_case(browser, url, directory, *case) for case in cases]
                    summary.update(passed=sum(passed), total=len(passed), status="passed" if all(passed) else "failed")
                finally:
                    await asyncio.wait_for(browser.close(), 10)
    except Exception:
        summary["status"] = "failed"
        summary["error"] = traceback.format_exc()
        print(summary["error"], flush=True)
    finally:
        (directory / "result.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary), flush=True)
    return summary["status"] == "passed"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", required=True)
    parser.add_argument("--chrome", help="override the Chromium executable only")
    parser.add_argument("--browser", choices=["chromium", "firefox", "webkit"], default="chromium")
    parser.add_argument("--suite", choices=["lifecycle", "interaction", "all"], default="all")
    parser.add_argument("--artifacts", default=".nsh/browser-tests")
    args = parser.parse_args()
    if args.chrome and args.browser != "chromium":
        parser.error("--chrome requires --browser chromium")
    if args.browser != "chromium" and args.suite != "lifecycle":
        parser.error("Firefox and WebKit currently require --suite lifecycle")
    raise SystemExit(0 if asyncio.run(check(args.wasm, args.chrome, args.browser, args.suite, args.artifacts)) else 1)
