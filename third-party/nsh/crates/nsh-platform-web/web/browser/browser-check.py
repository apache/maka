"""Real-browser lifecycle checks. Requires Python Playwright and Chromium.

Run with --wasm pointing to a browser (or browser-tests) Wasm build.
"""
import argparse
import asyncio
import functools
import http.server
import pathlib
import shutil
import tempfile
import threading

from playwright.async_api import TimeoutError, async_playwright


async def check_scroll_content(page):
    """A scroll view's contentStyle / contentClass style a container its children go into."""
    from playwright.async_api import TimeoutError
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


async def check(wasm, chrome):
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
window.errors=[]; window.player=await createPlayer(document.querySelector('#app'),{wasm:'./nsh.wasm',onError:e=>errors.push(e)});
window.ready=true;
</script>''')
        (root / "app.js").write_text('''import {host,nextTick,View,signal,mount,cleanup} from 'nsh';
import {Menu} from 'nsh/desktop';
import {InputAccessoryView} from 'nsh/mobile';
import {Buffer} from 'buffer';
const result=parent.result;
host.on('before', value=>result.events.push(value));
try { nextTick(null); } catch(e) { result.errorBrand=e instanceof TypeError; }
result.functionBrand=View instanceof Function && InputAccessoryView instanceof Function;
result.promiseBrand=Menu.popup([]) instanceof Promise;
result.bufferBrand=Buffer.from('abc') instanceof Uint8Array;
mount(()=>{const value=signal(1);cleanup(()=>result.cleaned++);result.read=value;return null;});
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
        (root / "bad.js").write_text("import {mount,cleanup} from 'nsh'; mount(()=>{cleanup(()=>parent.result.failedCleaned++);return null;}); throw new Error('startup failed');")
        (root / "slow.js").write_text("await new Promise(resolve=>setTimeout(resolve,300)); parent.result.late=true;")
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
        (root / "cleanup.js").write_text("import {mount,cleanup} from 'nsh'; mount(()=>{cleanup(()=>{throw new Error('cleanup failed');});return null;});")
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(executable_path=chrome, args=["--no-sandbox"])
                # A mouse and a viewport at least 600 wide: the desktop idiom, which the platform props check needs.
                page = await browser.new_page(viewport={"width": 1280, "height": 720})
                await page.goto(f"http://127.0.0.1:{server.server_port}/index.html")
                await page.wait_for_function("window.ready")
                # The web's and, in the desktop idiom, the desktop's platform props apply; iOS' and Android's do not.
                from playwright.async_api import TimeoutError as PlaywrightTimeoutError
                warnings = []
                listen = lambda message: warnings.append(message.text)
                page.on("console", listen)
                await page.evaluate("player.runModule('./platform.js')")
                view = page.locator("[data-testid=platform]")
                # Attached, not visible: without the web's style it has no size.
                await view.wait_for(state="attached")
                read = lambda: view.evaluate("el => [getComputedStyle(el).backgroundColor, el.getAttribute('aria-label')]")
                seen = {"set": await read()}
                # A key the new object no longer has is unset.
                await page.evaluate("document.querySelector('iframe').contentWindow.dropWebStyle()")
                try:
                    await page.wait_for_function(
                        "getComputedStyle(document.querySelector('[data-testid=platform]')).backgroundColor !== 'rgb(0, 255, 0)'",
                        timeout=2000)
                except PlaywrightTimeoutError:
                    pass  # The assertion below says what it read.
                seen["web emptied"] = await read()
                page.remove_listener("console", listen)
                assert seen == {
                    "set": ["rgb(0, 255, 0)", "desktop"],
                    "web emptied": ["rgba(0, 0, 0, 0)", "desktop"],
                }, seen
                assert not [w for w in warnings if "unsupported prop" in w], warnings
                assert await page.evaluate("errors.length") == 0, await page.evaluate("errors.map(String)")
                await page.evaluate("player.stop()")
                result = await page.evaluate('''async()=>{
                  window.result={events:[],runs:0,cleaned:0,failedCleaned:0};
                  for(let i=0;i<3;i++) {
                    player.hostEvent('before',i);
                    await player.runModule('./app.js');
                    player.stop();
                  }
                  try { await player.runModule('./bad.js'); } catch(e) { result.failure=String(e); }
                  result.framesAfterFailure=document.querySelectorAll('iframe').length;
                  const slow=player.runModule('./slow.js').catch(e=>String(e));
                  await new Promise(r=>setTimeout(r,50));
                  await player.runModule('./app.js');
                  result.cancelled=await slow;
                  await new Promise(r=>setTimeout(r,350));
                  player.stop();
                  result.framesAfterStop=document.querySelectorAll('iframe').length;
                  return result;
                }''')
                assert result["events"] == [0, 1, 2], result
                assert all(result[k] for k in ["errorBrand", "functionBrand", "promiseBrand", "bufferBrand"]), result
                assert result["runs"] == 4 and result["cleaned"] == 4, result
                assert result["failedCleaned"] == 1 and "startup failed" in result["failure"], result
                assert result["framesAfterFailure"] == result["framesAfterStop"] == 0, result
                assert "disposed" in result["cancelled"] and not result.get("late"), result
                for script in ["bootstrap.js", "realm.js"]:
                    await page.route(f"**/browser/{script}", lambda route: route.abort())
                    failure = await page.evaluate('''async()=>{
                      try { await player.runModule('./app.js'); return {resolved:true}; }
                      catch(e) { return {error:String(e),frames:document.querySelectorAll('iframe').length}; }
                    }''')
                    assert failure.get("error") and failure["frames"] == 0, failure
                    await page.unroute(f"**/browser/{script}")
                reentrant = await page.evaluate('''async()=>{
                  let reports=0;
                  player.options.onError=()=>{reports++;player.reset();};
                  await player.runModule('./cleanup.js');
                  player.stop();
                  return {reports,frames:document.querySelectorAll('iframe').length};
                }''')
                assert reentrant == {"reports": 1, "frames": 0}, reentrant
                await check_state_styles(page)
                await check_other_states(page)
                await check_tooltip_function(page)
                print(result)
                await check_scroll_content(page)
                await browser.close()
        finally:
            server.shutdown()


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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", required=True)
    parser.add_argument("--chrome", default=shutil.which("chromium") or shutil.which("google-chrome"))
    args = parser.parse_args()
    asyncio.run(check(args.wasm, args.chrome))
