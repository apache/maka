//! Web APIs installed by the host: encoding, URL, headers, abort and fetch.

use nsh_core::Op;
use nsh_js::{FetchEvent, FetchOp, Host, HttpBody, HttpHead, HttpRequest, NetworkQueue};

/// The requests started in `queue`.
fn started(queue: &NetworkQueue) -> Vec<(u32, &HttpRequest)> {
    queue
        .ops
        .iter()
        .filter_map(|(id, op)| match op {
            FetchOp::Start(r) => Some((*id, r)),
            _ => None,
        })
        .collect()
}

/// Answers request `id` with `head` and `body` (in two chunks).
fn respond(host: &Host, id: u32, head: HttpHead, body: &[u8]) {
    host.fetch_event(id, FetchEvent::Head(head));
    let (a, b) = body.split_at(body.len() / 2);
    host.fetch_event(id, FetchEvent::Data(a.to_vec()));
    host.fetch_event(id, FetchEvent::Data(b.to_vec()));
    host.fetch_event(id, FetchEvent::End);
}

/// Runs `script` (which sets `globalThis.out`) and returns `out` as a string.
fn run(host: &Host, script: &str) -> String {
    host.eval_source(&format!(
        "{REPORT}{script}\n;report(typeof out === 'string' ? out : JSON.stringify(out));"
    ))
    .unwrap();
    output(host)
}

/// Defines `report(text)`: the text a test reads with [`output`].
const REPORT: &str =
    "import { text as __text } from \"nsh:rt\";\nconst report = (t) => __text(t);\n";

/// The text the last `report` call made.
fn output(host: &Host) -> String {
    let mut ops = Vec::new();
    host.take_ops(&mut ops);
    ops.into_iter()
        .rev()
        .find_map(|op| match op {
            Op::CreateText { text, .. } => Some(text.to_string()),
            _ => None,
        })
        .expect("no output")
}

#[test]
fn lazy_globals_resolve_and_can_be_replaced() {
    let host = Host::new().unwrap();
    let out = run(
        &host,
        r#"
        globalThis.fetch = "mine";
        const names = ["TextEncoder", "TextDecoder", "URL", "URLSearchParams", "Event", "EventTarget",
            "AbortSignal", "AbortController", "Headers", "Request", "Response", "fetch"];
        globalThis.out = names.map((n) => typeof globalThis[n]).join(",") + " " + Object.keys(globalThis).includes("URL");
        "#,
    );
    assert_eq!(
        out,
        "function,function,function,function,function,function,function,function,function,function,function,string false"
    );
}

#[test]
fn text_encoding_round_trips() {
    let host = Host::new().unwrap();
    let out = run(
        &host,
        r#"
        const bytes = new TextEncoder().encode("héllo 👋");
        const sub = new Uint8Array([0, ...bytes]).subarray(1);
        globalThis.out = [bytes.length, new TextDecoder().decode(sub), new TextDecoder().decode(new Uint8Array([0xff]))];
        try { new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff])); out.push("no throw"); }
        catch (e) { out.push(e instanceof TypeError); }
        "#,
    );
    assert_eq!(out, r#"[11,"héllo 👋","�",true]"#);
}

#[test]
fn urls_follow_whatwg() {
    let host = Host::new().unwrap();
    let out = run(
        &host,
        r#"
        const u = new URL("../b?x=1&y=a+b#h", "https://user:pw@例え.jp:8443/a/c");
        u.searchParams.append("z", "c d&e");
        const p = new URLSearchParams({ q: "1 2", r: "~!" });
        globalThis.out = [u.href, u.origin, u.hostname, u.port, u.searchParams.get("y"), p.toString(), URL.canParse("nope"), String(new URL("HTTP://X.COM"))];
        u.pathname = "/new path";
        out.push(u.pathname);
        "#,
    );
    assert_eq!(
        out,
        r#"["https://user:pw@xn--r8jz45g.jp:8443/b?x=1&y=a+b&z=c+d%26e#h","https://xn--r8jz45g.jp:8443","xn--r8jz45g.jp","8443","a b","q=1+2&r=%7E%21",false,"http://x.com/","/new%20path"]"#
    );
}

#[test]
fn headers_combine_and_sort() {
    let host = Host::new().unwrap();
    let out = run(
        &host,
        r#"
        const h = new Headers({ "X-B": "2", Accept: "text/html" });
        h.append("x-b", " 3 ");
        h.append("Set-Cookie", "a=1");
        h.append("Set-Cookie", "b=2");
        globalThis.out = [h.get("X-b"), [...h].map(([k, v]) => k + "=" + v).join(";"), h.has("accept")];
        try { h.set("bad name", "x"); } catch (e) { out.push(e instanceof TypeError); }
        "#,
    );
    assert_eq!(
        out,
        r#"["2, 3","accept=text/html;set-cookie=a=1;set-cookie=b=2;x-b=2, 3",true,true]"#
    );
}

#[test]
fn fetch_goes_through_the_network_queue() {
    let host = Host::new().unwrap();
    host.eval_source(
        r#"
        globalThis.out = [];
        fetch("https://example.com/api?q=1", {
            method: "post",
            headers: { "X-Token": "t" },
            body: JSON.stringify({ a: 1 }),
        }).then(async (r) => {
            out.push(r.status, r.ok, r.headers.get("content-type"), r.url, await r.json());
            try { await r.text(); } catch (e) { out.push("used"); }
        });
        const c = new AbortController();
        fetch("https://example.com/slow", { signal: c.signal }).catch((e) => out.push(e.name));
        c.abort();
        fetch("https://example.com/down").catch((e) => out.push(e instanceof TypeError, e.message));
        "#,
    )
    .unwrap();
    let mut queue = NetworkQueue::default();
    host.take_network(&mut queue);
    // The aborted request never reached the network.
    let requests = started(&queue);
    assert_eq!(requests.len(), 2, "{queue:?}");
    assert_eq!(queue.ops.len(), 2, "{queue:?}");
    let (id, req) = requests[0];
    assert_eq!(req.method, "POST");
    assert_eq!(req.url, "https://example.com/api?q=1");
    assert_eq!(req.body, HttpBody::Bytes(br#"{"a":1}"#.to_vec()));
    assert!(req.headers.contains(&("x-token".into(), "t".into())));
    assert!(
        req.headers
            .contains(&("content-type".into(), "text/plain;charset=UTF-8".into()))
    );
    respond(
        &host,
        id,
        HttpHead {
            status: 201,
            status_text: "Created".into(),
            url: "https://example.com/api?q=1".into(),
            redirected: false,
            headers: vec![("Content-Type".into(), "application/json".into())],
        },
        br#"{"ok":true}"#,
    );
    host.fetch_event(requests[1].0, FetchEvent::Failed("offline".into()));
    host.eval_source(&(REPORT.to_owned() + "report(JSON.stringify(out));"))
        .unwrap();
    assert_eq!(
        output(&host),
        r#"["AbortError",201,true,"application/json","https://example.com/api?q=1",{"ok":true},"used",true,"Network request failed: offline"]"#
    );
}

#[test]
fn relative_urls_resolve_against_the_base_url_only_where_there_is_one() {
    let script = r#"
        globalThis.out = [];
        try { out.push(new Request("/api?q=1").url); } catch (e) { out.push(e instanceof TypeError); }
        fetch("data.json").catch((e) => out.push(e.name));
        "#;
    // Native hosts: no document, so no base.
    let host = Host::new().unwrap();
    host.eval_source(script).unwrap();
    let mut queue = NetworkQueue::default();
    host.take_network(&mut queue);
    assert!(started(&queue).is_empty(), "{queue:?}");
    host.eval_source(&(REPORT.to_owned() + "report(JSON.stringify(out));"))
        .unwrap();
    assert_eq!(output(&host), r#"[true,"TypeError"]"#);
    // The web: the page's URL.
    let host = Host::with_options(nsh_js::HostOptions {
        base_url: Some("https://app.example.com/shop/index.html".into()),
        ..Default::default()
    })
    .unwrap();
    host.eval_source(script).unwrap();
    let mut queue = NetworkQueue::default();
    host.take_network(&mut queue);
    let urls: Vec<_> = started(&queue).iter().map(|(_, r)| r.url.clone()).collect();
    assert_eq!(urls, ["https://app.example.com/shop/data.json"]);
    host.eval_source(&(REPORT.to_owned() + "report(JSON.stringify(out));"))
        .unwrap();
    assert_eq!(output(&host), r#"["https://app.example.com/api?q=1"]"#);
}

#[test]
fn aborting_an_inflight_fetch_cancels_it() {
    let host = Host::new().unwrap();
    host.eval_source(
        r#"
        globalThis.c = new AbortController();
        globalThis.out = [];
        fetch("https://example.com/", { signal: AbortSignal.any([c.signal]) }).catch((e) => out.push(e.name));
        "#,
    )
    .unwrap();
    let mut queue = NetworkQueue::default();
    host.take_network(&mut queue);
    let id = started(&queue)[0].0;
    host.eval_source("c.abort();").unwrap();
    let mut queue = NetworkQueue::default();
    host.take_network(&mut queue);
    assert_eq!(queue.ops, vec![(id, FetchOp::Cancel)]);
    // A late completion is ignored.
    host.fetch_event(id, FetchEvent::Failed("cancelled".into()));
    host.eval_source(&(REPORT.to_owned() + "report(JSON.stringify(out));"))
        .unwrap();
    assert_eq!(output(&host), r#"["AbortError"]"#);
}

#[test]
#[ignore]
fn bench_host_startup() {
    let _ = Host::new().unwrap();
    let n = 50;
    let start = std::time::Instant::now();
    for _ in 0..n {
        drop(Host::new().unwrap());
    }
    eprintln!("Host::new: {:?}", start.elapsed() / n);
}

#[test]
fn events_dispatch_as_in_the_dom() {
    let host = Host::new().unwrap();
    let out = run(
        &host,
        r#"
        const log = [];
        const t = new EventTarget();
        const once = () => log.push("once");
        t.addEventListener("x", (e) => log.push(`bubble ${e.eventPhase} ${e.target === t} ${e.currentTarget === t}`));
        t.addEventListener("x", () => log.push("capture"), true);
        t.addEventListener("x", once, { once: true });
        t.addEventListener("x", once, { once: true }); // the same listener: once
        t.addEventListener("x", { handleEvent(e) { log.push(`object ${this !== t}`); } });
        const c = new AbortController();
        t.addEventListener("x", () => log.push("signal"), { signal: c.signal });
        t.addEventListener("x", () => { throw new Error("reported, not thrown"); });
        t.addEventListener("x", (e) => e.preventDefault(), { passive: true });
        const e = new Event("x", { cancelable: true });
        log.push(t.dispatchEvent(e), e.defaultPrevented, e.eventPhase, e.currentTarget);
        c.abort();
        log.push(t.dispatchEvent(new Event("x")));
        // Removal during dispatch: the removed listener is skipped.
        const u = new EventTarget();
        const second = () => log.push("removed ran");
        u.addEventListener("y", () => u.removeEventListener("y", second));
        u.addEventListener("y", second);
        u.addEventListener("y", (e) => { e.stopImmediatePropagation(); log.push("stop"); });
        u.addEventListener("y", () => log.push("after stop"));
        u.dispatchEvent(new Event("y"));
        // Subclasses and CustomEvent.
        class Channel extends EventTarget { send(v) { return this.dispatchEvent(new CustomEvent("msg", { detail: v })); } }
        const ch = new Channel();
        ch.addEventListener("msg", (e) => log.push(`detail ${e.detail} ${e instanceof CustomEvent} ${e instanceof Event}`));
        ch.send(7);
        log.push(ch instanceof Channel, ch instanceof EventTarget, typeof ch.send);
        log.push(Object.prototype.toString.call(new Event("z")), Object.prototype.toString.call(c.signal), Event.AT_TARGET);
        try { Event("x"); } catch (err) { log.push(err instanceof TypeError); }
        try { new AbortSignal(); } catch (err) { log.push(`illegal ${err instanceof TypeError}`); }
        try { EventTarget.prototype.addEventListener.call({}, "x", () => {}); } catch (err) { log.push(`brand ${err instanceof TypeError}`); }
        globalThis.out = log;
        "#,
    );
    assert_eq!(
        out,
        concat!(
            r#"["capture","bubble 2 true true","once","object true","signal",true,false,0,null,"#,
            r#""capture","bubble 2 true true","object true",true,"stop","#,
            r#""detail 7 true true",true,true,"function","[object Event]","[object AbortSignal]",2,true,"illegal true","brand true"]"#
        )
    );
}

#[test]
fn abort_signals_abort_once_and_propagate() {
    let host = Host::new().unwrap();
    host.eval_source(
        r#"
        globalThis.out = [];
        const c = new AbortController();
        const s = c.signal;
        s.onabort = (e) => out.push(`onabort ${e.type} ${e.isTrusted}`);
        s.addEventListener("abort", () => out.push(`listener ${s.reason}`));
        const any = AbortSignal.any([s, new AbortController().signal]);
        any.addEventListener("abort", () => out.push(`any ${any.reason === s.reason}`));
        c.abort("why");
        c.abort("again");
        out.push(s.aborted, s.reason, any.aborted);
        try { s.throwIfAborted(); } catch (e) { out.push(`threw ${e}`); }
        const d = AbortSignal.abort();
        out.push(d.aborted, d.reason.name, d.reason instanceof DOMException);
        const pre = AbortSignal.any([d]);
        out.push(pre.aborted, pre.reason === d.reason);
        const t = AbortSignal.timeout(1);
        t.addEventListener("abort", () => { out.push(`timeout ${t.reason.name}`); });
        "#,
    )
    .unwrap();
    // Let the timer fire.
    std::thread::sleep(std::time::Duration::from_millis(5));
    host.run_timers(std::time::Instant::now());
    host.eval_source(&(REPORT.to_owned() + "report(JSON.stringify(out));"))
        .unwrap();
    assert_eq!(
        output(&host),
        r#"["onabort abort true","listener why","any true",true,"why",true,"threw why",true,"AbortError",true,true,true,"timeout TimeoutError"]"#
    );
}

#[test]
fn urls_and_their_params_stay_in_sync() {
    let host = Host::new().unwrap();
    let out = run(
        &host,
        r#"
        const u = new URL("../b?x=1&y=2#h", "https://user:pw@example.com:8080/a/c");
        const log = [u.href, u.origin, u.username, u.host, u.pathname, u.search, u.hash];
        u.searchParams.append("z", "a b&c");
        log.push(u.search);
        u.search = "?q=é";
        log.push(u.searchParams.get("q"), u.href);
        u.searchParams.delete("q");
        log.push(u.href, u.search);
        u.port = "443"; u.protocol = "http"; u.hostname = "example.org";
        log.push(u.href);
        try { u.href = "not a url"; } catch (e) { log.push(e instanceof TypeError); }
        const p = new URLSearchParams({ b: "2", a: "1" });
        p.append("a", "0");
        p.sort();
        log.push(p.toString(), p.size, p.getAll("a").join(), p.has("a", "1"), p.has("a", "9"));
        p.set("a", "x");
        log.push([...p].map(([k, v]) => k + v).join(), p.keys().toArray().join(), Object.prototype.toString.call(p.entries()));
        log.push(new URLSearchParams([["k", "v"]]).toString(), new URLSearchParams("?a=1+2&b=%20").get("a"), URL.canParse("x"), URL.parse("x"), URL.parse("https://e.com/") instanceof URL);
        log.push(JSON.stringify({ u: new URL("https://e.com/p") }), String(new URL("https://e.com")));
        globalThis.out = log;
        "#,
    );
    assert_eq!(
        out,
        concat!(
            r##"["https://user:pw@example.com:8080/b?x=1&y=2#h","https://example.com:8080","user","example.com:8080","/b","?x=1&y=2","#h","##,
            r##""?x=1&y=2&z=a+b%26c","é","https://user:pw@example.com:8080/b?q=%C3%A9#h","https://user:pw@example.com:8080/b#h","","##,
            r##""http://user:pw@example.org/b#h",true,"a=1&a=0&b=2",3,"1,0",true,false,"ax,b2","a,b","[object Iterator]","##,
            r#""k=v","1 2",false,null,true,"{\"u\":\"https://e.com/p\"}","https://e.com/"]"#
        )
    );
}

#[test]
fn text_encoding_follows_the_encoding_standard() {
    let host = Host::new().unwrap();
    let out = run(
        &host,
        r#"
        const log = [];
        const enc = new TextEncoder();
        log.push(enc.encoding, enc.encode().length, Array.from(enc.encode("\uD800")).join());
        const dest = new Uint8Array(5);
        const r = enc.encodeInto("a€👋", dest);
        log.push(r.read, r.written, Array.from(dest).join());
        const d = new TextDecoder();
        const bytes = enc.encode("﻿hé👋");
        let s = "";
        for (const b of bytes) s += d.decode(new Uint8Array([b]), { stream: true });
        s += d.decode();
        log.push(s, d.encoding, d.fatal, d.ignoreBOM);
        log.push(new TextDecoder("utf-16le").decode(new Uint16Array([0x68, 0x69])), new TextDecoder("latin1").encoding);
        log.push(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xEF, 0xBB, 0xBF, 0x61])).length);
        try { new TextDecoder("koi8-x"); } catch (e) { log.push(e instanceof RangeError); }
        log.push(new TextDecoder().decode(new DataView(new Uint8Array([0x6f, 0x6b]).buffer)));
        globalThis.out = log;
        "#,
    );
    assert_eq!(
        out,
        r#"["utf-8",0,"239,191,189",2,4,"97,226,130,172,0","hé👋","utf-8",false,false,"hi","windows-1252",2,true,"ok"]"#
    );
}

/// Runs the body of an async function and returns its result as JSON
/// (`ERR …` when it throws).
fn run_async(host: &Host, body: &str) -> String {
    host.eval_source(&format!(
        "globalThis.done = (async () => {{ {body} }})().then((v) => {{ globalThis.result = JSON.stringify(v); }}, (e) => {{ globalThis.result = `ERR ${{e}} ${{e && e.stack}}`; }});"
    ))
    .unwrap();
    for _ in 0..4 {
        host.run_jobs();
    }
    host.eval_source(&(REPORT.to_owned() + "report(String(globalThis.result));"))
        .unwrap();
    output(host)
}

#[test]
fn readable_streams_pull_by_their_high_water_mark() {
    let host = Host::new().unwrap();
    let out = run_async(
        &host,
        r#"
        const log = [];
        let n = 0;
        const s = new ReadableStream({
            start(c) { log.push(`start ${c.desiredSize}`); },
            pull(c) { n++; log.push(`pull ${c.desiredSize}`); if (n <= 3) c.enqueue(n); else c.close(); },
            cancel(r) { log.push(`cancel ${r}`); },
        }, { highWaterMark: 2 });
        await null; await null;
        log.push(`queued`);
        const r = s.getReader();
        log.push(s.locked);
        for (;;) { const { value, done } = await r.read(); log.push(done ? "done" : value); if (done) break; }
        await r.closed;
        r.releaseLock();
        log.push(s.locked);
        // Errors reach readers and the closed promise.
        const e = new ReadableStream({ start(c) { c.enqueue("a"); c.error(new Error("boom")); } });
        const er = e.getReader();
        try { await er.read(); } catch (err) { log.push(err.message); }
        try { await er.closed; } catch (err) { log.push(`closed ${err.message}`); }
        // Cancel reaches the source.
        const c = new ReadableStream({ cancel(r) { log.push(`source cancel ${r}`); return 1; } });
        log.push(await c.cancel("why"));
        try { s.getReader(); new ReadableStream().getReader().releaseLock(); const l = new ReadableStream(); l.getReader(); l.getReader(); } catch (err) { log.push(err instanceof TypeError); }
        try { new ReadableStream({ type: "nope" }); } catch (err) { log.push(err instanceof TypeError); }
        try { new ReadableStream({}, { highWaterMark: -1 }); } catch (err) { log.push(err instanceof RangeError); }
        return log;
        "#,
    );
    assert_eq!(
        out,
        r#"["start 2","pull 2","pull 1","queued",true,"pull 1",1,"pull 1",2,3,"done",false,"boom","closed boom","source cancel why",null,true,true,true]"#
    );
}

#[test]
fn readable_streams_iterate_tee_and_come_from_iterables() {
    let host = Host::new().unwrap();
    let out = run_async(
        &host,
        r#"
        const log = [];
        const s = ReadableStream.from([1, Promise.resolve(2), 3]);
        for await (const v of s) log.push(v);
        async function* gen() { try { yield "a"; yield "b"; yield "c"; } finally { log.push("gen done"); } }
        for await (const v of ReadableStream.from(gen())) { log.push(v); if (v === "b") break; }
        const [a, b] = new ReadableStream({ start(c) { c.enqueue("x"); c.enqueue("y"); c.close(); } }).tee();
        const all = async (st) => { const out = []; for await (const v of st) out.push(v); return out.join(""); };
        log.push(await all(a), await all(b));
        let reason;
        const [c1, c2] = new ReadableStream({ cancel(r) { reason = r; } }).tee();
        await Promise.all([c1.cancel("one"), c2.cancel("two")]);
        log.push(JSON.stringify(reason));
        const it = new ReadableStream({ start(c) { c.enqueue(1); }, cancel() { log.push("canceled"); } }).values({ preventCancel: false });
        log.push((await it.next()).value, JSON.stringify(await it.return("r")), JSON.stringify(await it.next()));
        log.push(typeof ReadableStream.prototype[Symbol.asyncIterator]);
        return log;
        "#,
    );
    assert_eq!(
        out,
        r#"[1,2,3,"a","b","gen done","xy","xy","[\"one\",\"two\"]","canceled",1,"{\"value\":\"r\",\"done\":true}","{\"done\":true}","function"]"#
    );
}

#[test]
fn byte_streams_fill_byob_reads() {
    let host = Host::new().unwrap();
    let out = run_async(
        &host,
        r#"
        const log = [];
        // A source answering BYOB requests.
        let i = 0;
        const s = new ReadableStream({
            type: "bytes",
            autoAllocateChunkSize: 4,
            pull(c) {
                const req = c.byobRequest;
                if (i >= 3) { c.close(); if (req) req.respond(0); return; }
                const v = req.view;
                v[0] = 10 + i; v[1] = 20 + i;
                req.respond(2);
                i++;
            },
        });
        const r = s.getReader({ mode: "byob" });
        let res = await r.read(new Uint8Array(8));
        log.push(Array.from(res.value).join(), res.value.buffer.byteLength, res.done);
        res = await r.read(new Uint16Array(2), { min: 1 });
        log.push(res.value.constructor.name, res.value.length);
        r.releaseLock();
        // The auto-allocated buffer for a default reader.
        const d = s.getReader();
        res = await d.read();
        log.push(Array.from(res.value).join());
        res = await d.read();
        log.push(res.done);
        // Enqueued chunks: transferred, and readable with either reader.
        const chunk = new Uint8Array([1, 2, 3, 4, 5]);
        const q = new ReadableStream({ type: "bytes", start(c) { c.enqueue(chunk); c.close(); } });
        log.push(chunk.byteLength);
        const br = q.getReader({ mode: "byob" });
        res = await br.read(new Uint8Array(3));
        log.push(Array.from(res.value).join());
        res = await br.read(new Uint8Array(3));
        log.push(Array.from(res.value).join());
        res = await br.read(new Uint8Array(3));
        log.push(res.done, res.value.byteLength);
        // A byte tee: both branches, and BYOB on a branch.
        const [t1, t2] = new ReadableStream({ type: "bytes", start(c) { c.enqueue(new Uint8Array([7, 8])); c.close(); } }).tee();
        const tr = t1.getReader({ mode: "byob" });
        res = await tr.read(new Uint8Array(4));
        log.push(Array.from(res.value).join());
        res = await t2.getReader().read();
        log.push(Array.from(res.value).join());
        try { new ReadableStream().getReader({ mode: "byob" }); } catch (e) { log.push(e instanceof TypeError); }
        return log;
        "#,
    );
    assert_eq!(
        out,
        r#"["10,20",8,false,"Uint16Array",1,"12,22",true,0,"1,2,3","4,5",true,0,"7,8","7,8",true]"#
    );
}

#[test]
fn writable_streams_queue_writes_with_backpressure() {
    let host = Host::new().unwrap();
    let out = run_async(
        &host,
        r#"
        const log = [];
        let release;
        const s = new WritableStream({
            start(c) { log.push("start"); },
            write(chunk, c) { log.push(`write ${chunk}`); return chunk === 1 ? new Promise((r) => { release = r; }) : undefined; },
            close() { log.push("close"); },
            abort(r) { log.push(`abort ${r}`); },
        }, { highWaterMark: 1 });
        const w = s.getWriter();
        log.push(w.desiredSize);
        const p1 = w.write(1);
        const p2 = w.write(2);
        log.push(w.desiredSize);
        await null; await null;
        release();
        await Promise.all([p1, p2]);
        await w.ready;
        log.push(w.desiredSize);
        await w.close();
        try { await w.write(3); } catch (e) { log.push(e instanceof TypeError); }
        // Abort: the sink's abort, the signal, and rejected writes.
        let signal;
        const a = new WritableStream({ start(c) { signal = c.signal; }, write() { return new Promise(() => {}); }, abort(r) { log.push(`sink abort ${r}`); } });
        const aw = a.getWriter();
        await aw.abort("stop");
        log.push(signal.aborted, signal.reason);
        // A sink error.
        const bad = new WritableStream({ write() { throw new Error("sink"); } });
        const bw = bad.getWriter();
        try { await bw.write(1); } catch (e) { log.push(e.message); }
        try { await bw.closed; } catch (e) { log.push(`closed ${e.message}`); }
        return log;
        "#,
    );
    assert_eq!(
        out,
        r#"["start",1,-1,"write 1","write 2",1,"close",true,"sink abort stop",true,"stop","sink","closed sink"]"#
    );
}

#[test]
fn pipes_and_transforms_carry_chunks_and_errors() {
    let host = Host::new().unwrap();
    let out = run_async(
        &host,
        r#"
        const log = [];
        const chunks = [];
        const src = () => new ReadableStream({ start(c) { ["a", "b", "c"].forEach((x) => c.enqueue(x)); c.close(); } });
        const sink = () => new WritableStream({ write(c) { chunks.push(c); }, close() { chunks.push("|"); } });
        await src().pipeTo(sink());
        await src().pipeTo(sink(), { preventClose: true });
        log.push(chunks.join(""));
        const upper = new TransformStream({ transform(c, ctl) { ctl.enqueue(c.toUpperCase()); }, flush(ctl) { ctl.enqueue("!"); } });
        const out = [];
        for await (const v of src().pipeThrough(upper)) out.push(v);
        log.push(out.join(""));
        const id = [];
        for await (const v of src().pipeThrough(new TransformStream())) id.push(v);
        log.push(id.join(""));
        // An error in the source aborts the destination.
        const failing = new ReadableStream({ pull(c) { c.error(new Error("src")); } });
        let aborted;
        try { await failing.pipeTo(new WritableStream({ abort(r) { aborted = r.message; } })); } catch (e) { log.push(`pipe ${e.message} ${aborted}`); }
        // A signal stops the pipe and cancels the source.
        const ac = new AbortController();
        let canceled;
        const endless = new ReadableStream({ pull(c) { c.enqueue(1); }, cancel(r) { canceled = r.name; } }, { highWaterMark: 0 });
        const p = endless.pipeTo(new WritableStream({ write() { return new Promise((r) => setTimeout(r, 0)); } }), { signal: ac.signal });
        ac.abort();
        try { await p; } catch (e) { log.push(`${e.name} ${canceled}`); }
        // Terminate closes the readable side.
        const t = new TransformStream({ start(ctl) { ctl.enqueue(1); ctl.terminate(); } });
        const r = t.readable.getReader();
        log.push((await r.read()).value, (await r.read()).done);
        // Text streams across chunk boundaries.
        const bytes = new TextEncoder().encode("héllo 👋");
        const parts = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
        let text = "";
        for await (const s of parts.pipeThrough(new TextDecoderStream())) text += s;
        log.push(text);
        const enc = new TextEncoderStream();
        const ew = enc.writable.getWriter();
        ew.write("\uD83D"); ew.write("\uDC4B!"); ew.close();
        const er = enc.readable.getReader();
        const got = [];
        for (;;) { const { value, done } = await er.read(); if (done) break; got.push(...value); }
        log.push(new TextDecoder().decode(new Uint8Array(got)), enc.encoding);
        return log;
        "#,
    );
    assert_eq!(
        out,
        r#"["abc|abc","ABC!","abc","pipe src src","AbortError AbortError",1,true,"héllo 👋","👋!","utf-8"]"#
    );
}

#[test]
fn blobs_files_and_form_data() {
    let host = Host::new().unwrap();
    let out = run_async(
        &host,
        r#"
        const log = [];
        const b = new Blob(["héllo", new Uint8Array([33]), new Blob([" x"])], { type: "Text/Plain" });
        log.push(b.size, b.type, await b.text(), await b.slice(-2).text(), b.slice(1, 3, "a/b").type);
        log.push(Array.from(await b.slice(0, 2).bytes()).join(), (await b.arrayBuffer()).byteLength);
        let streamed = "";
        for await (const c of b.stream().pipeThrough(new TextDecoderStream())) streamed += c;
        log.push(streamed);
        const f = new File(["data"], "a.txt", { type: "text/plain", lastModified: 42 });
        log.push(f.name, f.lastModified, f.size, f instanceof Blob, Object.prototype.toString.call(f));
        const fd = new FormData();
        fd.append("k", "v1");
        fd.append("k", "v2");
        fd.append("file", new Blob(["z"]), "z.bin");
        fd.set("s", 1);
        log.push(fd.getAll("k").join(), fd.get("file").name, fd.get("file") instanceof File, fd.get("s"), fd.has("x"));
        fd.delete("k");
        log.push([...fd.keys()].join(), [...fd].length);
        const url = URL.createObjectURL(b);
        log.push(url.startsWith("blob:"));
        URL.revokeObjectURL(url);
        return log;
        "#,
    );
    assert_eq!(
        out,
        r#"[9,"text/plain","héllo! x"," x","a/b","104,195",9,"héllo! x","a.txt",42,4,true,"[object File]","v1,v2","z.bin",true,"1",false,"file,s",2,true]"#
    );
}

#[test]
fn queuing_strategies_size_chunks() {
    let host = Host::new().unwrap();
    let out = run(
        &host,
        r#"
        const b = new ByteLengthQueuingStrategy({ highWaterMark: 16 });
        const c = new CountQueuingStrategy({ highWaterMark: 2 });
        globalThis.out = [b.highWaterMark, b.size(new Uint8Array(5)), c.size("x"), b.size === new ByteLengthQueuingStrategy({ highWaterMark: 1 }).size];
        "#,
    );
    assert_eq!(out, "[16,5,1,true]");
}

/// The web objects of a workload are all collected: values held natively
/// are marked for the cycle collector and freed with their owners.
#[test]
fn web_objects_do_not_leak() {
    let host = Host::new().unwrap();
    // In a function: the module each evaluation keeps would hold
    // top-level bindings.
    let workload = r#"(() => {
        const c = new AbortController();
        const t = new EventTarget();
        t.addEventListener("x", () => {}, { signal: AbortSignal.any([c.signal]) });
        t.dispatchEvent(new CustomEvent("x", { detail: {} }));
        const u = new URL("https://e.com/?a=1"); u.searchParams.append("b", "2");
        new TextDecoder().decode(new TextEncoder().encode("x"));
        const fd = new FormData(); fd.append("f", new Blob(["x"]), "f");
        const [a, b] = new ReadableStream({ start(k) { k.enqueue("v"); k.close(); } }).tee();
        const bytes = new ReadableStream({ type: "bytes", start(k) { k.enqueue(new Uint8Array([1])); k.close(); } });
        (async () => {
            for await (const _ of a) {}
            await b.pipeThrough(new TransformStream()).pipeTo(new WritableStream());
            const r = bytes.getReader({ mode: "byob" });
            await r.read(new Uint8Array(4));
            await new Blob(["y"]).stream().pipeThrough(new TextDecoderStream()).getReader().read();
            c.abort();
        })();
    })();"#;
    // Warm up (classes, prototypes and caches are made once).
    host.eval_source(workload).unwrap();
    host.run_jobs();
    host.collect_garbage();
    let before = host.object_count();
    for _ in 0..20 {
        host.eval_source(workload).unwrap();
        host.run_jobs();
    }
    host.collect_garbage();
    let after = host.object_count();
    // The modules themselves: 4 objects each.
    assert!(after - before <= 4 * 20 + 4, "{before} -> {after} objects");
}

fn take(host: &Host) -> Vec<(u32, FetchOp)> {
    let mut queue = NetworkQueue::default();
    host.take_network(&mut queue);
    queue.ops
}

fn head(status: u16, headers: &[(&str, &str)]) -> HttpHead {
    HttpHead {
        status,
        status_text: String::new(),
        url: "https://example.com/".into(),
        redirected: false,
        headers: headers
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
    }
}

fn read_out(host: &Host) -> String {
    host.run_jobs();
    host.eval_source(&(REPORT.to_owned() + "report(JSON.stringify(out));"))
        .unwrap();
    output(host)
}

#[test]
fn response_bodies_stream_with_back_pressure() {
    let host = Host::new().unwrap();
    host.eval_source(
        r#"
        globalThis.out = [];
        fetch("https://example.com/stream").then(async (r) => {
            out.push(r.status, r.headers.get("x-a"), r.bodyUsed);
            try { r.headers.set("x", "y"); } catch (e) { out.push("immutable"); }
            const reader = r.body.getReader();
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                out.push(value.length);
            }
            out.push(r.bodyUsed);
        });
        "#,
    )
    .unwrap();
    let ops = take(&host);
    let FetchOp::Start(req) = &ops[0].1 else {
        panic!("{ops:?}")
    };
    assert!(req.headers.contains(&("accept".into(), "*/*".into())));
    let id = ops[0].0;
    host.fetch_event(id, FetchEvent::Head(head(200, &[("X-A", "1")])));
    host.run_jobs();
    // Chunks reach the reader as they arrive, before the end.
    host.fetch_event(id, FetchEvent::Data(vec![1; 10]));
    host.run_jobs();
    host.fetch_event(id, FetchEvent::Data(vec![2; 20]));
    host.run_jobs();
    host.eval_source(&(REPORT.to_owned() + "report(JSON.stringify(out));"))
        .unwrap();
    assert_eq!(output(&host), r#"[200,"1",false,"immutable",10,20]"#);
    host.fetch_event(id, FetchEvent::End);
    assert_eq!(read_out(&host), r#"[200,"1",false,"immutable",10,20,true]"#);

    // Unread: paused past the limit, resumed by a read.
    host.eval_source(r#"fetch("https://example.com/big").then((r) => { globalThis.big = r; });"#)
        .unwrap();
    let id = take(&host)[0].0;
    host.fetch_event(id, FetchEvent::Head(head(200, &[])));
    host.run_jobs();
    for _ in 0..20 {
        host.fetch_event(id, FetchEvent::Data(vec![0; 64 << 10]));
    }
    let ops = take(&host);
    assert_eq!(ops, vec![(id, FetchOp::Pause(true))]);
    host.eval_source(
        r#"(async () => { const r = big.body.getReader(); let n = 0; for (let i = 0; i < 20; i++) n += (await r.read()).value.length; globalThis.out = [n]; r.read(); })();"#,
    )
    .unwrap();
    host.run_jobs();
    assert_eq!(take(&host), vec![(id, FetchOp::Pause(false))]);
    assert_eq!(read_out(&host), "[1310720]");
}

#[test]
fn request_bodies_stream_chunk_by_chunk() {
    let host = Host::new().unwrap();
    host.eval_source(
        r#"
        globalThis.out = [];
        try { new Request("https://e.com/", { method: "POST", body: new ReadableStream() }); } catch (e) { out.push(e instanceof TypeError); }
        let n = 0;
        const body = new ReadableStream({
            pull(c) { n++; if (n <= 2) c.enqueue(new TextEncoder().encode(`part${n}`)); else c.close(); },
        }, { highWaterMark: 0 });
        fetch("https://example.com/up", { method: "POST", body, duplex: "half" }).then((r) => out.push(r.status));
        "#,
    )
    .unwrap();
    let ops = take(&host);
    let (id, FetchOp::Start(req)) = &ops[0] else {
        panic!("{ops:?}")
    };
    assert_eq!(req.body, HttpBody::Stream);
    let id = *id;
    let mut sent = Vec::new();
    loop {
        host.fetch_event(id, FetchEvent::BodyWanted);
        host.run_jobs();
        match take(&host).pop() {
            Some((_, FetchOp::Send(b))) => sent.push(String::from_utf8(b).unwrap()),
            Some((_, FetchOp::Finish)) => break,
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(sent, ["part1", "part2"]);
    host.fetch_event(id, FetchEvent::Head(head(201, &[])));
    host.fetch_event(id, FetchEvent::End);
    assert_eq!(read_out(&host), "[true,201]");
}

#[test]
fn fetch_answers_locally_aborts_and_redirects() {
    let host = Host::new().unwrap();
    host.eval_source(
        r#"
        globalThis.out = [];
        (async () => {
            const d = await fetch("data:text/plain;base64,aGk=");
            out.push(await d.text(), d.headers.get("content-type"));
            const url = URL.createObjectURL(new Blob(["blob!"], { type: "text/x" }));
            const b = await fetch(url);
            out.push(await b.text(), b.headers.get("content-length"));
            try { await fetch("ftp://x/"); } catch (e) { out.push(e instanceof TypeError); }
        })();
        const early = new AbortController();
        fetch("https://example.com/early", { signal: early.signal }).catch((e) => out.push(`early ${e.name}`));
        early.abort();
        globalThis.late = new AbortController();
        fetch("https://example.com/late", { signal: late.signal }).then(async (r) => {
            try { await r.text(); } catch (e) { out.push(`late ${e.name}`); }
        });
        fetch("https://example.com/r", { redirect: "error" }).catch((e) => out.push(`redirect ${e instanceof TypeError}`));
        fetch("https://example.com/h", { method: "HEAD" }).then((r) => out.push(`head ${r.body}`));
        "#,
    )
    .unwrap();
    host.run_jobs();
    let ops = take(&host);
    // The early abort never reached the network.
    let starts: Vec<(u32, String, bool)> = ops
        .iter()
        .filter_map(|(id, op)| match op {
            FetchOp::Start(r) => Some((*id, r.url.clone(), r.follow_redirects)),
            _ => None,
        })
        .collect();
    assert_eq!(starts.len(), 3, "{ops:?}");
    let (late, redirect, head_id) = (starts[0].0, starts[1].0, starts[2].0);
    assert!(!starts[1].2, "redirect: error is not followed by the stack");
    host.fetch_event(late, FetchEvent::Head(head(200, &[])));
    host.run_jobs();
    host.eval_source("late.abort();").unwrap();
    host.fetch_event(redirect, FetchEvent::Head(head(302, &[("location", "/x")])));
    host.fetch_event(head_id, FetchEvent::Head(head(200, &[])));
    host.fetch_event(head_id, FetchEvent::End);
    let ops = take(&host);
    assert!(ops.contains(&(late, FetchOp::Cancel)), "{ops:?}");
    assert!(ops.contains(&(redirect, FetchOp::Cancel)), "{ops:?}");
    assert_eq!(
        read_out(&host),
        r#"["early AbortError","hi","text/plain","blob!","5",true,"late AbortError","redirect true","head null"]"#
    );
}

#[test]
fn bodies_extract_and_consume_as_in_fetch() {
    let host = Host::new().unwrap();
    let out = run_async(
        &host,
        r#"
        const log = [];
        const fd = new FormData();
        fd.append("a", "1\n2");
        fd.append("f", new Blob(["x"], { type: "text/plain" }), "f.txt");
        const req = new Request("https://e.com/", { method: "POST", body: fd });
        const ct = req.headers.get("content-type");
        log.push(ct.startsWith("multipart/form-data; boundary="));
        // A FormData body keeps its multipart type over a given one.
        const typed = new Request("https://e.com/", { method: "POST", body: fd, headers: { "content-type": "application/x-www-form-urlencoded" } });
        log.push(typed.headers.get("content-type").startsWith("multipart/form-data; boundary="));
        const back = await req.formData();
        log.push(back.get("a"), back.get("f").name, await back.get("f").text(), req.bodyUsed);
        try { await req.text(); } catch (e) { log.push(e instanceof TypeError); }
        const p = new Request("https://e.com/", { method: "POST", body: new URLSearchParams({ q: "a b" }) });
        log.push(p.headers.get("content-type"), await p.text());
        log.push(new Request("https://e.com/", { method: "post", body: "s" }).method);
        try { new Request("https://e.com/", { body: "x" }); } catch (e) { log.push(e instanceof TypeError); }
        const r = new Response(JSON.stringify({ k: [1] }), { status: 201, headers: { "X-Y": "z" } });
        const c = r.clone();
        log.push((await r.json()).k[0], await c.text(), r.ok, r.status, r.headers.get("x-y"), r.type);
        const j = Response.json({ a: 1 }, { status: 202 });
        log.push(j.headers.get("content-type"), j.status, await j.text());
        const rd = Response.redirect("https://e.com/next", 307);
        log.push(rd.status, rd.headers.get("location"));
        const e = Response.error();
        log.push(e.type, e.status);
        try { new Response("x", { status: 204 }); } catch (err) { log.push(err instanceof TypeError); }
        try { new Response(null, { status: 99 }); } catch (err) { log.push(err instanceof RangeError); }
        const bl = await new Response(new Uint8Array([104, 105]), { headers: { "content-type": "Text/Plain" } }).blob();
        log.push(bl.type, await bl.text());
        const form = await new Response("x=1&y=%202", { headers: { "content-type": "application/x-www-form-urlencoded" } }).formData();
        log.push(form.get("y"));
        const h = new Headers([["Set-Cookie", "a=1"], ["set-cookie", "b=2"], ["B", "2"], ["a", " 1 "]]);
        h.append("b", "3");
        log.push([...h].map(([k, v]) => `${k}=${v}`).join("|"), h.getSetCookie().join(","));
        try { h.append("bad name", "x"); } catch (err) { log.push(err instanceof TypeError); }
        const streamed = new Response(new ReadableStream({ start(k) { k.enqueue(new Uint8Array([1, 2])); k.close(); } }));
        log.push((await streamed.arrayBuffer()).byteLength);
        return log;
        "#,
    );
    assert_eq!(
        out,
        concat!(
            r#"[true,true,"1\r\n2","f.txt","x",true,true,"application/x-www-form-urlencoded;charset=UTF-8","q=a+b","POST",true,"#,
            r#"1,"{\"k\":[1]}",true,201,"z","default","application/json",202,"{\"a\":1}",307,"https://e.com/next","error",0,true,true,"#,
            r#""text/plain","hi"," 2","a=1|b=2, 3|set-cookie=a=1|set-cookie=b=2","a=1,b=2",true,2]"#
        )
    );
}

#[test]
fn abandoned_responses_cancel_their_requests() {
    let host = Host::new().unwrap();
    host.eval_source(r#"fetch("https://example.com/ignored").then((r) => r.status);"#)
        .unwrap();
    let id = take(&host)[0].0;
    host.fetch_event(id, FetchEvent::Head(head(200, &[])));
    host.fetch_event(id, FetchEvent::Data(vec![0; 10]));
    host.run_jobs();
    host.collect_garbage();
    assert_eq!(take(&host), vec![(id, FetchOp::Cancel)]);
}

#[test]
#[ignore]
fn bench_first_web_global() {
    let n = 50;
    let mut total = std::time::Duration::ZERO;
    for _ in 0..n {
        let host = Host::new().unwrap();
        host.eval_source("globalThis.x = 1;").unwrap();
        let start = std::time::Instant::now();
        host.eval_source("void fetch;").unwrap();
        total += start.elapsed();
    }
    println!("first web global: {:?}", total / n);
}

#[path = "standard/mod.rs"]
mod standard;
