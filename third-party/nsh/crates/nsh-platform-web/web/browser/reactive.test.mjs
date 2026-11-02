import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Values } from "./values.js";
import { createReactive } from "./reactive.js";
import { createModules } from "./modules.js";
import { createDom } from "./dom.js";
import { createGestures } from "./gesture.js";
import { createAnimation } from "./animation.js";
import { createCanvas } from "./canvas.js";
import { createNavigation } from "./navigation.js";
import { createKeymap } from "./keymap.js";
import { createEnvironment } from "./environment.js";
import { createComponents } from "./components.js";

const path = process.env.NSH_BROWSER_WASM;
async function fixture() {
  const module = await WebAssembly.compile(await readFile(path));
  let bridge;
  const imports = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    assert.equal(entry.kind, "function");
    (imports[entry.module] ??= {})[entry.name] = () => 0;
    assert.doesNotMatch(entry.name, /rquickjs/);
  }
  imports.nsh_browser = { value: (...args) => bridge.value(...args) };
  const raw = (await WebAssembly.instantiate(module, imports)).exports;
  // As `nsh.js` does: link every part, standard module and feature the runtime kept.
  for (const name of Object.keys(raw)) if (/^nsh_(part|std|feature)_/.test(name)) raw[name]();
  const start = () => {
    const values = new Values();
    bridge = values.imports(() => raw.memory);
    const wasm = values.bind(raw);
    wasm.nsh_browser_initialize();
    let live = true;
    const invoke = (op, args) => values.boundary(() => values.with([args], ([id]) => values.result(wasm.nsh_browser_call(op, id))), () => raw.nsh_browser_trace());
    const api = createReactive(invoke, () => live, values);
    const dom = createDom(invoke, values, api, () => live, () => {});
    const components = createComponents(invoke, values, api, dom);
    const close = () => { if (live) { wasm.nsh_browser_dispose(); live = false; values.dispose(); } };
    return { api, values, invoke, dom, components, mouseEvents: () => values.result(wasm.nsh_browser_test_mouse_events()), fileDropEvents: () => values.result(wasm.nsh_browser_test_file_drop_events()), videoLoadEvent: () => values.result(wasm.nsh_browser_test_video_load_event()), modules: () => createModules(invoke, values, () => live, () => {}, components.make), close,
      restart() { close(); return start(); } };
  };
  return start();
}

test("browser closures run on the shared Wasm reactive scheduler", { skip: !path }, async () => {
  const { api, close } = await fixture();
  const seen = [];
  let dispose;
  let count;
  api.root(stop => {
    dispose = stop;
    count = api.signal(1);
    const doubled = api.computed(() => count() * 2);
    api.effect(() => seen.push(doubled()));
    api.batch(() => { count.set(2); count.set(3); });
    api.cleanup(() => seen.push("disposed"));
  });
  assert.deepEqual(seen, [6]);
  dispose();
  count.set(4);
  assert.deepEqual(seen, [6, "disposed"]);
  close();
  assert.throws(() => count(), /disposed/);
});

test("contexts and untracked reads keep their owner across callbacks", { skip: !path }, async () => {
  const { api, close } = await fixture();
  const Context = api.context("default");
  let dispose;
  let read;
  let owner;
  api.root(stop => {
    dispose = stop;
    Context.Provider({ value: "provided", get children() { owner = api.getOwner(); return null; } });
    read = () => api.runWithOwner(owner, Context);
  });
  assert.equal(read(), "provided");
  assert.equal(Context(), "default");
  dispose();
  close();
});

test("exceptions restore the graph and comparison callbacks preserve identity", { skip: !path }, async () => {
  const { api, close } = await fixture();
  const signal = api.signal({ n: 1 }, { equals: (a, b) => a.n === b.n });
  let runs = 0;
  let dispose;
  api.root(stop => { dispose = stop; api.effect(() => { signal(); runs++; }); });
  signal.set({ n: 1 });
  assert.equal(runs, 1);
  signal.set({ n: 2 });
  assert.equal(runs, 2);
  assert.throws(() => api.batch(() => { throw new Error("callback failed"); }), /callback failed/);
  signal.set({ n: 3 });
  assert.equal(runs, 3);
  dispose();
  close();
});


test("registry functions use Rust conversions and preserve error classes", { skip: !path }, async () => {
  const fixture = await fixtureForModules();
  try {
    const os = fixture.modules.exports.get("os");
    assert.equal(typeof os.platform(), "string");
    assert.equal(os.arch(), "wasm32");
    assert.equal(os.default, os);
    assert.equal(os.EOL, "\n");
    assert.throws(() => os.homedir(), error => error instanceof Error && error.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM");
    const process = fixture.modules.exports.get("process");
    // A function returning a promise never throws: a wrong argument rejects.
    let thrown = false, run;
    try { run = process.run(42); } catch { thrown = true; }
    assert.equal(thrown, false);
    await assert.rejects(run, TypeError);
    assert.equal(process.platform, os.platform());
  } finally { fixture.modules.dispose(); fixture.close(); }
});
async function fixtureForModules() { const f = await fixture(); return { ...f, modules: f.modules() }; }


test("null owner clears context and root disposal is idempotent", { skip: !path }, async () => {
  const { api, close } = await fixture();
  const Context = api.context("default");
  let dispose;
  api.root(stop => {
    dispose = stop;
    Context.Provider({ value: "provided", get children() {
      assert.equal(api.runWithOwner(null, Context), "default");
      assert.equal(api.runWithOwner(null, api.getOwner), null);
      return null;
    }});
  });
  dispose();
  assert.doesNotThrow(dispose);
  close();
});

test("hostile thrown message getters preserve the exception without recursive decoding", { skip: !path }, async () => {
  const { api, close } = await fixture();
  const error = { get message() { throw error; } };
  assert.throws(() => api.batch(() => { throw error; }), caught => caught === error);
  assert.equal(api.signal(3)(), 3);
  close();
});


test("computed options and returned effect cleanups match the public API", { skip: !path }, async () => {
  const { api, close } = await fixture();
  const signal = api.signal(1);
  let effects = 0, cleanups = 0, dispose;
  api.root(stop => {
    dispose = stop;
    const derived = api.computed(() => ({ value: signal() % 2 }), { equals: (a, b) => a?.value === b.value });
    api.effect(() => { derived(); effects++; return () => cleanups++; });
  });
  signal.set(3);
  assert.equal(effects, 1);
  signal.set(4);
  assert.equal(effects, 2);
  assert.equal(cleanups, 1);
  dispose();
  assert.equal(cleanups, 2);
  close();
});

test("throwing null and undefined preserves their identity", { skip: !path }, async () => {
  const { api, close } = await fixture();
  for (const error of [null, undefined]) {
    let caught = false;
    try { api.batch(() => { throw error; }); }
    catch (value) { caught = true; assert.equal(value, error); }
    assert.ok(caught);
  }
  close();
});


test("keyed rows reuse zero keys and recover after a key callback throws", { skip: !path }, async () => {
  const { invoke, close } = await fixture();
  const id = invoke(310, []);
  let created = 0, disposed = 0;
  const factory = () => ({
    item: { set() {} }, index: { set() {} },
    output: ++created, dispose() { disposed++; },
  });
  try {
    assert.deepEqual(invoke(311, [id, [-0], factory]), [1]);
    assert.deepEqual(invoke(311, [id, [0], factory]), [1]);
    assert.equal(disposed, 0);
    const failure = new Error("key failed");
    assert.throws(() => invoke(311, [id, [0], factory, () => { throw failure; }]), error => error === failure);
    assert.equal(disposed, 1);
    assert.deepEqual(invoke(311, [id, [1], factory]), [2]);
    invoke(312, [id]);
    assert.equal(disposed, 2);
  } finally { close(); }
});

test("discarded signal cycles are collected without disposing the app", { skip: !path || !global.gc }, async () => {
  const { api, values, close } = await fixture();
  const baseline = values.retained;
  const refs = [];
  for (let i = 0; i < 30; i++) {
    (() => {
      const initial = {};
      const signal = api.signal(initial);
      initial.read = signal;
      const next = { read: signal };
      signal.set(next);
      refs.push(new WeakRef(signal));
    })();
  }
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    global.gc();
  }
  assert.ok(refs.every(ref => !ref.deref()));
  assert.equal(values.retained, baseline);
  close();
});


test("class cycles collect, escaped callbacks stay live, and old callbacks are inert after remount", { skip: !path || !global.gc }, async () => {
  let f = await fixture();
  let modules = f.modules();
  let Box = modules.exports.get("test/browser")?.CallbackBox;
  assert.ok(Box, "build ownership tests with --features browser-tests");
  const collect = async () => { for (let i = 0; i < 30; i++) { await new Promise(resolve => setTimeout(resolve, 5)); global.gc(); } };
  let weak;
  (() => { const object = new Box(() => object ? 42 : 0); weak = new WeakRef(object); })();
  await collect();
  assert.equal(weak.deref(), undefined);
  (() => { const object = new Box(() => object ? 43 : 0); object.escape(); weak = new WeakRef(object); })();
  await collect();
  assert.ok(weak.deref());
  assert.equal(Box.callKept(), 43);
  Box.clearKept();
  await collect();
  assert.equal(weak.deref(), undefined);
  (() => { const object = new Box(() => object ? 44 : 0); object.escape(); })();
  modules.dispose();
  f = f.restart();
  modules = f.modules();
  Box = modules.exports.get("test/browser").CallbackBox;
  assert.equal(Box.callKept(), -1);
  const signal = f.api.signal({ live: true });
  Box.clearKept();
  assert.deepEqual(signal(), { live: true });
  modules.dispose();
  f.close();
});


test("a Rust stop function runs once and goes with its owner", { skip: !path }, async () => {
  const f = await fixture();
  const modules = f.modules();
  const Box = modules.exports.get("test/browser").CallbackBox;
  const stop = Box.listen(() => 1);
  assert.equal(typeof stop, "function");
  assert.equal(Box.listening(), 1);
  stop();
  stop();
  assert.equal(Box.listening(), 0);
  let dispose;
  f.api.root(d => { dispose = d; Box.listen(() => 2); Box.listen(() => 3)(); });
  assert.equal(Box.listening(), 1);
  dispose();
  assert.equal(Box.listening(), 0);
  modules.dispose();
  f.close();
});

test("active memo payloads survive accessor collection until their owner is disposed", { skip: !path || !global.gc }, async () => {
  const { api, close } = await fixture();
  let dispose, payload;
  api.root(stop => { dispose = stop; const memo = api.computed(() => ({ alive: true })); payload = new WeakRef(memo()); });
  const collect = async () => { for(let i=0;i<20;i++){await new Promise(resolve=>setTimeout(resolve,5));global.gc();} };
  await collect();
  assert.ok(payload.deref());
  dispose();
  await collect();
  assert.equal(payload.deref(), undefined);
  close();
});

test("native animation samples and derived-node identity use the Rust graph protocol", { skip: !path }, async () => {
  const f = await fixture();
  const animation = createAnimation(f.invoke, ()=>!f.values.closed, ()=>{}, {api:{reduceMotion:()=>false}});
  const {AnimatedValue,Animated,Easing}=animation.api;
  assert.deepEqual(Easing.sample(Easing.quad,3),[0,0.25,1]);
  const a=AnimatedValue(1),b=AnimatedValue(2);
  assert.equal(a.add(3),a.add(3));
  assert.notEqual(a.add(3),b.add(3));
  a.add(NaN);
  assert.throws(()=>a.add(null),TypeError);
  let jsonCalls=0;
  const range=[0,1];range.toJSON=()=>{jsonCalls++;return [];};
  const first=a.interpolate({inputRange:range,outputRange:[0,10]});
  range[1]=2;
  assert.notEqual(first,a.interpolate({inputRange:range,outputRange:[0,10]}));
  assert.equal(jsonCalls,0);
  assert.ok(a instanceof AnimatedValue);
  assert.ok(Animated.sampleSpring({toValue:1}).length>1);
  const read=a.getValue();animation.finished([[2,true,7]]);assert.equal(await read,7);
  let finished;
  const composite=Animated.sequence([Animated.timing(a,{toValue:3}),Animated.delay(5)]);
  const end=composite.start(value=>{finished=value.finished;});animation.finished([[4,true]]);
  assert.deepEqual(await end,{finished:true});assert.equal(finished,true);
  animation.dispose();f.close();
});

test("canvas records paths and gradients through the shared Rust decoder", { skip: !path }, async () => {
  const f = await fixture();
  const canvas = createCanvas(f.invoke,f.api,f.dom,()=>!f.values.closed,()=>{});
  let node,dispose,hit,context;
  f.api.root(stop=>{dispose=stop;node=canvas.Canvas({draw(cx){
    context=cx;const path=new canvas.Path2D();path.rect(0,0,10,10);
    const gradient=cx.createLinearGradient(0,0,10,10);gradient.addColorStop(0,"red");gradient.addColorStop(1,"blue");
    cx.fillStyle=gradient;cx.fill(path);hit=cx.isPointInPath(path,5,5);cx.save();cx.lineWidth=4;cx.restore();
  }});});
  f.dom.event(f.values.nodeIds.get(node),"onLayout",{bounds:{origin:{x:0,y:0},size:{width:20,height:20}}});
  assert.equal(f.invoke(602,[[999],null,0,0,undefined,false]),false);
  assert.equal(hit,true);assert.equal(context.lineWidth,1);assert.equal(context.canvas.width,20);
  assert.ok(context instanceof canvas.CanvasRenderingContext2D);
  assert.equal(context.isPointInPath(new canvas.Path2D("M0 0L10 0L10 10Z"),7,3),true);
  dispose();f.close();
});

test("navigation keeps duplicate route entries and keymaps validate atomically", { skip: !path }, async () => {
  const f=await fixture();const env=createEnvironment(f.api,f.invoke,f.dom);
  const {createNavStack}=createNavigation(f.api,f.dom,env);
  let dispose,nav;
  f.api.root(stop=>{dispose=stop;nav=createNavStack(["a","a","b"]);});
  const before=nav.__nshEntries();nav.setRoutes(["a","b","a"]);
  assert.deepEqual(nav.__nshEntries(),[before[0],before[2],before[1]]);
  nav.pop(99);assert.deepEqual(nav.routes(),["a"]);nav.replace("c");assert.deepEqual(nav.routes(),["c"]);
  const keymap=createKeymap(f.invoke,f.api,f.dom,{appleKeyboard:false},()=>{});
  assert.equal(keymap.label("mod+k"),"Ctrl+K");
  let hits=0;const unbind=keymap.bind("mod+k",()=>hits++);
  assert.throws(()=>keymap.bind({"mod+l":()=>{},"invalid-key":()=>{}}),TypeError);
  f.dom.event(1,"onKeyCommand",1);assert.equal(hits,1);unbind();unbind();f.dom.event(1,"onKeyCommand",1);assert.equal(hits,1);
  dispose();f.close();
});


test("touch dispatch captures, grants, tracks the Rust pan, and releases", { skip: !path }, async () => {
  const f=await fixture();const gestures=createGestures(f.invoke,f.values,f.api,f.dom,()=>!f.values.closed,()=>{});f.dom.setTouches(gestures);
  const seen=[];let child,parent,dispose;
  f.api.root(stop=>{
    dispose=stop;parent=f.dom.rt.element("view");child=f.dom.rt.element("view");f.dom.rt.append(parent,child);
    f.dom.rt.prop(parent,"onTouchStartCapture",()=>seen.push("capture"));
    const pan=gestures.PanResponder.create({onStartShouldSetPanResponder:()=>true,onPanResponderGrant:()=>seen.push("grant"),onPanResponderMove:(e,g)=>seen.push([g.dx,g.dy]),onPanResponderRelease:(e,g)=>seen.push(["release",g.dx])});
    f.dom.rt.spread(child,pan.panHandlers);
  });
  const target=f.values.nodeIds.get(child),outer=f.values.nodeIds.get(parent);
  const touch=(phase,x,y,timestamp)=>f.dom.event(target,"onTouch",{phase,timestamp,points:[{identifier:1,target,path:[target,outer],pageX:x,pageY:y,locationX:x,locationY:y,changed:true,timestamp}]});
  touch("start",0,0,0);touch("move",10,5,10);touch("end",10,5,20);
  assert.deepEqual(seen,["capture","grant",[10,5],["release",10]]);
  dispose();f.close();
});

test("virtualized lists recycle owners and preserve the last item while data shrinks", { skip: !path }, async () => {
  const { createLists } = await import("./list.js");
  const { api, invoke, values, dom, close } = await fixture();
  const lists = createLists(invoke, values, api, dom, () => true, () => {});
  const data = api.signal([{ id: "a" }, { id: "b" }, { id: "c" }]);
  const rows = [], reports = [];
  let node, dispose, cleaned = 0;
  api.root(stop => {
    dispose = stop;
    node = lists.render({ get each() { return data(); },
      children(item, index) { rows.push({ item, index }); api.cleanup(() => cleaned++); return () => item()?.id; },
      onViewableItemsChange(info) { reports.push(info); } });
  });
  const id = values.nodeIds.get(node);
  lists.bind(id, [[0, 0], [1, 1]]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].item().id, "a");
  lists.bind(id, [[0, 2]]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].item().id, "c");
  data.set([{ id: "d" }]);
  assert.equal(rows[0].item().id, "c");
  lists.bind(id, [[0, 0]]);
  assert.equal(rows[0].item().id, "d");
  dom.event(id, "onViewableItemsChange", { first: 0, last: 0 });
  assert.equal(reports[0].viewableItems[0].key, "d");
  dispose();
  assert.equal(cleaned, 2);
  lists.bind(id, [[0, 0]]);
  assert.equal(rows.length, 2);
  close();
});

test("list cells keep their items when items are inserted before them", { skip: !path }, async () => {
  const { createLists } = await import("./list.js");
  const { api, invoke, values, dom, close } = await fixture();
  const lists = createLists(invoke, values, api, dom, () => true, () => {});
  const data = api.signal([{ id: "a" }, { id: "b" }]);
  const shown = [], indices = [];
  let node, dispose;
  api.root(stop => {
    dispose = stop;
    node = lists.render({ get each() { return data(); },
      children(item, index) { indices.push(index); return () => { shown.push(item().id); return item().id; }; } });
  });
  const id = values.nodeIds.get(node);
  lists.bind(id, [[0, 0], [1, 1]]);
  assert.deepEqual(shown, ["a", "b"]);
  data.set([{ id: "new" }, ...data()]);
  assert.deepEqual(indices.map(index => index()), [1, 2]);
  // The core's bindings after the splice move nothing more.
  lists.bind(id, [[0, 1], [1, 2]]);
  assert.deepEqual(shown, ["a", "b"]);
  dispose();
  close();
});

test("resources cancel superseded loads, retain values, and ignore settlement after disposal", { skip: !path }, async () => {
  const { createResource } = await import("./resource.js");
  const { api, invoke, close } = await fixture();
  const resource = createResource(invoke, api, () => true, () => {});
  const source = api.signal(1), requests = [];
  let result, dispose;
  api.root(stop => {
    dispose = stop;
    result = resource(source, (key, info) => new Promise((resolve, reject) => requests.push({ key, info, resolve, reject })));
  });
  assert.equal(result.state(), "pending");
  source.set(2);
  assert.equal(requests[0].info.signal.aborted, true);
  requests[0].resolve("stale"); requests[1].resolve("current");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(result(), "current"); assert.equal(result.state(), "ready");
  result.refetch(); assert.equal(result.state(), "refreshing"); assert.equal(requests[2].info.refetching, true);
  assert.equal(result.mutate("local"), "local");
  requests[2].reject("failure"); await Promise.resolve(); await Promise.resolve();
  assert.equal(result.error(), "failure"); assert.equal(result(), "local");
  source.set(false); assert.equal(result.state(), "ready");
  source.set(3); dispose(); assert.equal(requests[3].info.signal.aborted, true);
  requests[3].resolve("late"); await Promise.resolve(); await Promise.resolve();
  assert.equal(result(), "local"); close();
});

test("list binding continues after a row failure and teardown finishes after cleanup throws", { skip: !path }, async () => {
  const { createLists } = await import("./list.js");
  const { api, invoke, values, dom, close } = await fixture();
  const lists = createLists(invoke, values, api, dom, () => true, () => {});
  let node, dispose, made = [], cleaned = [];
  api.root(stop => {
    dispose = stop;
    node = lists.render({ each: [0, 1, 2], children(item) {
      const key = item(); made.push(key);
      api.cleanup(() => { cleaned.push(key); if (key === 1) throw new Error("cleanup"); });
      if (key === 0) throw new Error("render");
      return key;
    } });
  });
  const id = values.nodeIds.get(node);
  assert.throws(() => lists.bind(id, [[0, 0], [1, 1], [2, 2]]), /render/);
  assert.deepEqual(made, [0, 1, 2]);
  assert.throws(dispose, /cleanup/);
  assert.deepEqual(cleaned, [0, 1, 2]);
  assert.doesNotThrow(() => lists.bind(id, [[0, 0]]));
  close();
});

test("standard utilities retain Buffer, hash, compression, and virtual path behavior", { skip: !path }, async () => {
  const { createStandard } = await import("./standard.js");
  const { invoke, close } = await fixture();
  const modules = createStandard(invoke, () => true), { Buffer } = modules.get("buffer"), crypto = modules.get("crypto"), zlib = modules.get("zlib"), paths = modules.get("path"), url = modules.get("url");
  const native = await import("node:crypto");
  const bytes = Buffer.from("Native Shell");
  assert.equal(bytes.toString("base64"), "TmF0aXZlIFNoZWxs");
  assert.equal(Buffer.from([0, 1, 255]).readUInt16BE(1), 511);
  for (const algorithm of ["md5", "sha1", "sha256", "sha384", "sha512"]) {
    assert.equal(crypto.createHash(algorithm).update(bytes).digest("hex"), native.createHash(algorithm).update(bytes).digest("hex"));
    assert.equal(crypto.createHmac(algorithm, "key").update(bytes).digest("hex"), native.createHmac(algorithm, "key").update(bytes).digest("hex"));
  }
  for (const [compress, decompress] of [["gzip", "gunzip"], ["deflate", "inflate"], ["deflateRaw", "inflateRaw"], ["brotliCompress", "brotliDecompress"], ["zstdCompress", "zstdDecompress"]]) {
    assert.equal(zlib[decompress + "Sync"](zlib[compress + "Sync"](bytes)).toString(), "Native Shell");
  }
  assert.throws(() => zlib.gunzipSync(zlib.gzipSync(bytes), { maxOutputLength: 1 }), /output exceeds/);
  assert.equal(paths.resolve("docs", "..", "images"), "/images");
  assert.equal(url.pathToFileURL("docs/a b#c%20.txt").href, "file:///docs/a%20b%23c%2520.txt");
  assert.equal(url.fileURLToPath("file:///a%20b"), "/a%20b");
  assert.equal(url.domainToUnicode("xn--bcher-kva.de"), "bücher.de");
  close();
});

test("symbol and bigint keyed rows reuse identity and release symbol intern entries", { skip: !path }, async () => {
  const { api, dom, values, close } = await fixture();
  const symbol = Symbol.for("row"), local = Symbol("row");
  const source = api.signal([symbol, 123n, local]); let rows, dispose, created = 0;
  api.root(stop => { dispose = stop; rows = dom.rt.each(source, () => ++created); });
  assert.deepEqual(rows(), [1, 2, 3]);
  source.set([local, symbol, 123n]);
  assert.deepEqual(rows(), [3, 1, 2]);
  source.set([]); assert.deepEqual(rows(), []);
  for (let i = 0; i < 20 && values.symbols.size; i++) { await new Promise(resolve => setTimeout(resolve, 5)); global.gc?.(); }
  assert.equal(values.symbols.size, 0);
  dispose(); close();
});

test("hash updates consume ArrayBuffers immediately and HMAC refuses CRC", { skip: !path }, async () => {
  const { createStandard } = await import("./standard.js");
  const { invoke, close } = await fixture();
  const crypto = createStandard(invoke, () => true).get("crypto");
  const input = new Uint8Array([1, 2]), key = new Uint8Array([3, 4]);
  const hash = crypto.createHash("sha256").update(input.buffer), hmac = crypto.createHmac("sha256", key.buffer).update(input.buffer);
  input.fill(0); key.fill(0);
  const native = await import("node:crypto");
  assert.equal(hash.digest("hex"), native.createHash("sha256").update(new Uint8Array([1, 2])).digest("hex"));
  assert.equal(hmac.digest("hex"), native.createHmac("sha256", new Uint8Array([3, 4])).update(new Uint8Array([1, 2])).digest("hex"));
  assert.throws(() => crypto.createHmac("crc32", "secret"), /not available/);
  assert.throws(() => crypto.createHash("crc32c"), /not available/);
  assert.equal(new crypto.Crc32().update("123456789").digest("hex"), "cbf43926");
  close();
});

test("compiled refs assign variables, signals and callbacks and reject memo refs", { skip: !path }, async () => {
  const { api, dom, close } = await fixture();
  const node = dom.rt.element("view"), ref = api.signal(null), memo = api.computed(() => null);
  assert.equal(dom.rt.ref(undefined, node), false);
  assert.equal(dom.rt.ref(ref, node), true); assert.equal(ref(), node);
  let received; assert.equal(dom.rt.ref(value => { received = value; }, node), true); assert.equal(received, node);
  assert.throws(() => dom.rt.ref(memo, node), /read-only/);
  assert.throws(() => dom.rt.ref(null, node, "constant"), /cannot be assigned/);
  close();
});

test("error boundaries catch component, binding and listener failures and reset", { skip: !path }, async () => {
  const { api, dom, values, close } = await fixture();
  const fail = api.signal(false); let output, reset, dispose, node;
  const read = value => typeof value === "function" ? read(value()) : value;
  api.root(stop => {
    dispose = stop;
    output = api.ErrorBoundary({
      fallback(error, retry) { reset = retry; return `caught ${error}`; },
      get children() { node = dom.rt.element("view"); dom.rt.prop(node, "onPress", () => { throw "event"; }); return () => { if (fail()) throw "binding"; return "ok"; }; },
    });
  });
  assert.equal(read(output), "ok"); fail.set(true);
  assert.equal(read(output), "caught binding"); fail.set(false); reset(); assert.equal(read(output), "ok");
  dom.event(values.nodeIds.get(node), "onPress", {});
  assert.equal(read(output), "caught event"); dispose(); close();
});

test("detached DOM parent-child callback cycles collect without stopping the app", { skip: !path || !global.gc }, async () => {
  const { api, dom, values, close } = await fixture();
  let parentRef, childRef;
  api.root(dispose => {
    const parent = dom.rt.element("view"), child = dom.rt.element("view");
    dom.rt.append(parent, child);
    dom.rt.prop(child, "onPress", () => parent.focus());
    parentRef = new WeakRef(parent); childRef = new WeakRef(child);
    dispose();
  });
  for (let i = 0; i < 30; i++) { await new Promise(resolve => setTimeout(resolve, 5)); global.gc(); }
  assert.equal(parentRef.deref(), undefined);
  assert.equal(childRef.deref(), undefined);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(values.nodes.size, 1);
  close();
});

test("error boundaries deliver the first failure after a batch unwinds", { skip: !path }, async () => {
  const { api, close } = await fixture();
  const trigger = api.signal(false), order = [];
  let output, dispose;
  const read = v => typeof v === "function" ? read(v()) : v;
  api.root(stop => {
    dispose = stop;
    output = api.ErrorBoundary({ fallback(error) { order.push("fallback"); return error; }, get children() {
      api.renderEffect(() => { if (trigger()) { order.push("first"); throw "first error"; } });
      api.renderEffect(() => { if (trigger()) { order.push("second"); throw "second error"; } });
      api.cleanup(() => { throw "cleanup error"; });
      return "ok";
    } });
  });
  assert.equal(read(output), "ok");
  api.batch(() => { trigger.set(true); order.push("batch end"); });
  assert.equal(read(output), "first error");
  assert.deepEqual(order, ["batch end", "first", "second", "fallback"]);
  dispose(); close();
});

test("a listener whose owner went runs unowned, as QuickJS runs it", { skip: !path }, async () => {
  const { api, values, dom, close } = await fixture();
  const heard = [];
  let owner, node, dispose;
  api.root(stop => {
    dispose = stop;
    owner = api.getOwner();
    node = dom.rt.element("view");
    dom.rt.prop(node, "onPress", payload => heard.push([payload, api.getOwner()]));
  });
  // The view outlives the owner it was made under (a popup leaving with
  // its exit motion still reports its events).
  dispose();
  assert.equal(api.runWithOwner(owner, () => api.getOwner()), null);
  assert.doesNotThrow(() => dom.event(values.nodeIds.get(node), "onPress", 1));
  assert.deepEqual(heard, [[1, null]]);
  close();
});

test("host events preserve order, owner cleanup and platform calls", { skip: !path }, async () => {
  const { createHost } = await import("./host.js");
  const { api, invoke, dom, close } = await fixture();
  const calls = [], heard = [];
  const channel = createHost(invoke, api, dom, { host: () => true }, () => true, { call: async (...args) => { calls.push(args); return 42; } });
  assert.equal(channel.host.available(), true);
  channel.event("ready", 1);
  let dispose;
  api.root(stop => { dispose = stop; channel.host.on("ready", value => heard.push(value)); });
  await Promise.resolve(); assert.deepEqual(heard, [1]);
  channel.event("ready", 2); assert.deepEqual(heard, [1, 2]);
  assert.equal(await channel.host.call("example", { a: 1 }, { timeout: 0 }), 42);
  assert.deepEqual(calls, [["example", { a: 1 }, { timeout: 0 }]]);
  dispose(); channel.event("ready", 3); assert.deepEqual(heard, [1, 2]);
  const top = [];
  channel.host.on("top", value => top.push(value));
  channel.event("top", 4); assert.deepEqual(top, [4]);
  channel.dispose(); channel.event("top", 5); assert.deepEqual(top, [4]);
  close();
});


test("Rust component event callbacks retain their error boundary owner", { skip: !path }, async () => {
  const { api, values, components, close } = await fixture();
  const Component = components.make({ name: "Fixture", id: 0, props: [], events: ["change"], methods: [] }, () => {});
  let output, node, dispose;
  api.root(stop => {
    dispose = stop;
    output = api.ErrorBoundary({ fallback: error => error, get children() {
      node = Component({ onChange() { throw "component event"; } });
      return node;
    } });
  });
  components.component(values.nodeIds.get(node), "change", 1);
  const read = value => typeof value === "function" ? read(value()) : value;
  assert.equal(read(output), "component event");
  dispose(); close();
});

test("Rust renderer getters retain their error boundary owner", { skip: !path }, async () => {
  const { api, values, components, close } = await fixture();
  const Component = components.make({ name: "Fixture", id: 0, props: [], events: [], methods: [] }, () => {});
  let output, node, dispose;
  api.root(stop => {
    dispose = stop;
    output = api.ErrorBoundary({ fallback: error => error, get children() {
      node = Component({ get cell() { throw "renderer getter"; } });
      return node;
    } });
  });
  components.render(values.nodeIds.get(node), "cell", "row", 1);
  const read = value => typeof value === "function" ? read(value()) : value;
  assert.equal(read(output), "renderer getter");
  dispose(); close();
});

test("cleanup returns its callback and permits an unowned registration", { skip: !path }, async () => {
  const { api, close } = await fixture();
  let calls = 0;
  const cleanup = () => calls++;
  assert.equal(api.cleanup(cleanup), cleanup);
  api.root(dispose => {
    assert.equal(api.cleanup(cleanup), cleanup);
    dispose();
  });
  assert.equal(calls, 1);
  close();
  assert.equal(calls, 1);
});


test("native mouse payloads preserve positions, modifiers and nullable pressed buttons", { skip: !path }, async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.mouseEvents(), [null, "left", "right", "middle", "back", "forward"].map(pressedButton => ({
      position: { x: 3, y: 4 }, pagePosition: { x: 30, y: 40 },
      modifiers: { control: false, alt: false, shift: true, platform: false }, pressedButton,
    })));
  } finally { f.close(); }
});


test("native file drops preserve URIs and optional page position", { skip: !path }, async () => {
  const f = await fixture();
  try {
    const uris = ["file:///tmp/hello.txt", "file:///tmp/world.txt"];
    assert.deepEqual(f.fileDropEvents(), [
      { uris },
      { uris, pagePosition: { x: 30, y: 40 } },
    ]);
  } finally { f.close(); }
});

test("merged props answer `in` from their sources, getters included", { skip: !path }, async () => {
  const { dom, close } = await fixture();
  const props = dom.rt.merge({ onPress() {} }, () => ({ style: {} }), { get children() { return "label"; } });
  assert.ok("children" in props);
  assert.ok("style" in props);
  assert.ok(!("missing" in props));
  assert.equal(props.children, "label");
  close();
});

test("what a component's children read runs them alone, never the expression that made the component", { skip: !path }, async () => {
  const { api, dom, close } = await fixture();
  const seq = api.signal(0);
  let made = 0, runs = 0, dispose;
  // A component returning a fragment's dynamic child, and one returning an
  // array holding a function.
  const Fragment = () => { made++; return () => { runs++; return `seq ${seq()}`; }; };
  const Items = () => { made++; return ["a", () => { runs++; return seq(); }]; };
  api.root(stop => {
    dispose = stop;
    for (const Component of [Fragment, Items]) {
      const kind = "message";
      dom.rt.insert(dom.rt.element("view"), () => kind === "message" ? dom.rt.component(Component, {}) : null);
    }
  });
  seq.set(1); seq.set(2);
  assert.equal(made, 2);
  assert.equal(runs, 6);
  dispose(); close();
});

test("native video loads nest their size as the native JS host does", { skip: !path }, async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.videoLoadEvent(), { duration: 12.5, size: { width: 1920, height: 1080 } });
  } finally { f.close(); }
});
