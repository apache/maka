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

from playwright.async_api import async_playwright


async def check(wasm, chrome):
    with tempfile.TemporaryDirectory(prefix="nsh-browser-") as directory:
        root = pathlib.Path(directory)
        source = pathlib.Path(__file__).resolve().parent.parent
        shutil.copytree(source, root, dirs_exist_ok=True)
        shutil.copyfile(wasm, root / "nsh.wasm")
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
        (root / "bad.js").write_text("import {mount,cleanup} from 'nsh'; mount(()=>{cleanup(()=>parent.result.failedCleaned++);return null;}); throw new Error('startup failed');")
        (root / "slow.js").write_text("await new Promise(resolve=>setTimeout(resolve,300)); parent.result.late=true;")
        (root / "cleanup.js").write_text("import {mount,cleanup} from 'nsh'; mount(()=>{cleanup(()=>{throw new Error('cleanup failed');});return null;});")
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(executable_path=chrome, args=["--no-sandbox"])
                page = await browser.new_page()
                await page.goto(f"http://127.0.0.1:{server.server_port}/index.html")
                await page.wait_for_function("window.ready")
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
                print(result)
                await browser.close()
        finally:
            server.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", required=True)
    parser.add_argument("--chrome", default=shutil.which("chromium") or shutil.which("google-chrome"))
    args = parser.parse_args()
    asyncio.run(check(args.wasm, args.chrome))
