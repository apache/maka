//! gpui-shell parity: the standard-library calls the gpui-shell bench apps
//! (`gpui-shell-benchs/apps`: chat, disktree, finder, folio-deck, signed,
//! skills-manager, ocean-view) make, run under the grants those apps
//! declare, give what gpui-shell gives them. Each snippet is the app's own
//! use (named in its comment); the expectations are gpui-shell's results
//! (`gpui-kit/crates/shell`), noted where NSH adds to them.
#![cfg(target_os = "linux")]

use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicUsize},
};

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, MountBatch, Size, platform::Os};
use nsh_engine::{
    Bundle, Engine, EngineConfig, Environment, FetchEvent, FetchEvents, FetchTask, HttpBody,
    HttpHead, HttpRequest, Network,
};

use crate::{ChannelSink, rust_classes::shown};

const APP_ID: &str = "com.example.parity";

/// One app: its engine, what it shows, its directories.
struct App {
    engine: Option<Engine>,
    rx: Receiver<MountBatch>,
    root: PathBuf,
    /// The app's data directory (`process.dataDir`, `${dataDir}`).
    data: PathBuf,
}

impl Drop for App {
    fn drop(&mut self) {
        drop(self.engine.take());
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl App {
    /// The app `body` (it calls `report(value)` to show `done <JSON>`) on
    /// Linux with `capabilities`, and `setup` run on its data directory
    /// first.
    fn start(
        body: &str,
        capabilities: serde_json::Value,
        network: Option<Arc<dyn Network>>,
        setup: impl FnOnce(&std::path::Path),
    ) -> Self {
        Self::start_in(body, capabilities, network, setup, true)
    }

    /// [`App::start`], the app's directory its `${pluginDir}` when
    /// `located` (as a local or packaged desktop app's is).
    fn start_in(
        body: &str,
        capabilities: serde_json::Value,
        network: Option<Arc<dyn Network>>,
        setup: impl FnOnce(&std::path::Path),
        located: bool,
    ) -> Self {
        static APPS: AtomicUsize = AtomicUsize::new(0);
        let tmp = crate::temporary_root();
        let root = tmp.join(format!(
            "nsh-parity-{}-{}",
            std::process::id(),
            APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        let data = root.join("data").join(APP_ID);
        std::fs::create_dir_all(&data).unwrap();
        let data = data.canonicalize().unwrap();
        setup(&data);
        let entry = root.join("App.tsx");
        std::fs::write(
            &entry,
            format!(
                r#"import {{ mount, signal, Text }} from "nsh";
const shown = signal("waiting");
const report = (value) => shown.set(`done ${{JSON.stringify(value)}}`);
{body}
mount(() => <Text>{{shown()}}</Text>);
"#
            ),
        )
        .unwrap();
        let bundled = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry,
            minify: false,
            split: false,
            ui_sets: Vec::new(),
        })
        .unwrap();
        let mut paths = nsh_core::access::TrustedPaths::default();
        if located {
            paths.plugin_dir = Some(root.canonicalize().unwrap());
        }
        let bundle = Bundle::source(bundled.code)
            .with_app_id(Some(APP_ID))
            .with_system_paths(paths)
            .with_capabilities_json(Some(&capabilities.to_string()))
            .unwrap();
        let (tx, rx) = crossbeam_channel::unbounded();
        let config = EngineConfig {
            app: nsh_engine::App::Js(bundle),
            viewport: Size::new(nsh_core::geometry::px(400.0), nsh_core::geometry::px(300.0)),
            trace: false,
            network,
            websocket: None,
            filesystem: None,
            assets: None,
            environment: Environment {
                os: Os::Linux,
                ..Default::default()
            },
            header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
            limits: nsh_engine::Limits::default(),
            ui_sets: Vec::new(),
            runtime: None,
            data_dir: Some(root.join("data")),
            cache: nsh_engine::CacheOptions::off(),
            storage: None,
            clock: Default::default(),
            context: Default::default(),
            pinned: Default::default(),
            clipboard: None,
            host: Default::default(),
            picker: None,
        };
        let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
        Self {
            engine: Some(engine),
            rx,
            root,
            data,
        }
    }

    /// What the app reported.
    fn result(&self) -> serde_json::Value {
        let text = shown(&self.rx, "done ");
        let json = text
            .strip_prefix("done ")
            .unwrap_or_else(|| panic!("the app reported nothing: {text}"));
        serde_json::from_str(json).unwrap_or_else(|e| panic!("{e}: {json}"))
    }
}

const DATA_GRANT: &str = "${dataDir}";

fn data_grant() -> serde_json::Value {
    serde_json::json!({ "fs": { "read": [DATA_GRANT], "write": [DATA_GRANT] } })
}

/// skills-manager `lib/library.js` (`exists`, `statPaths`, `list`,
/// `readText`, `move`, `removeTree`, `copyTree`), disktree and finder
/// `lib/files.js` (`readDirectory`, `missing`, the trash records), signed
/// and ocean-view (`mkdir` with `recursive`, `writeFile` of bytes and of
/// text).
#[test]
fn file_calls_of_the_bench_apps() {
    let app = App::start(
        r##"
import * as fs from "fs/promises";
const reason = (error) => (error instanceof Error ? error.message : String(error));
// skills-manager's and finder's test for a missing entry.
const missing = (error) => error?.code === "ENOENT" || /no such file|not found/i.test(reason(error));
const exists = async (path, follow = true) => {
  try { await (follow ? fs.stat(path) : fs.lstat(path)); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
};
const kindOf = (stat) => stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
(async () => {
  const out = {};
  // ocean-view: reports
  await fs.mkdir("reports", { recursive: true });
  await fs.mkdir("reports", { recursive: true });
  await fs.writeFile("reports/day.md", "# Report\n");
  // signed: bytes out
  await fs.writeFile("reports/doc.pdf", new Uint8Array([37, 80, 68, 70]));
  // finder: preview bytes, `new Uint8Array(await fs.readFile(p))`
  const bytes = new Uint8Array(await fs.readFile("reports/doc.pdf"));
  out.bytes = [...bytes];
  out.bytesType = Object.prototype.toString.call(await fs.readFile("reports/doc.pdf"));
  out.text = await fs.readFile("reports/day.md", "utf8");
  // finder / disktree readDirectory
  const entries = await fs.readdir(".", { withFileTypes: true });
  out.entries = entries.map((e) => [e.name, e.isDirectory()]);
  out.names = await fs.readdir("reports");
  const stat = await fs.stat("reports/day.md");
  out.stat = { size: stat.size, file: stat.isFile(), dir: stat.isDirectory(), kind: kindOf(stat),
    mtime: typeof stat.mtimeMs === "number" && stat.mtime instanceof Date, mode: stat.mode & 0o170000 };
  // Data fields are own properties, as gpui-shell's and Node's are.
  out.statJson = Object.keys(JSON.parse(JSON.stringify(stat))).sort();
  out.spread = typeof { ...stat }.mtimeMs;
  out.direntJson = JSON.stringify(entries[2]);
  // skills-manager statPaths on a link
  const link = await fs.lstat("current");
  out.link = [kindOf(link), await fs.readlink("current")];
  out.followed = kindOf(await fs.stat("current"));
  // exists() through `missing`
  out.exists = [await exists("reports"), await exists("nowhere"), await exists("dangling", false), await exists("dangling")];
  // skills-manager move: mkdir(parent, recursive) + rename
  await fs.mkdir("store/skills", { recursive: true });
  await fs.rename("reports/day.md", "store/skills/day.md");
  out.moved = [await exists("reports/day.md"), await exists("store/skills/day.md")];
  // removeTree
  const removeTree = async (path) => {
    const s = await fs.lstat(path);
    if (s.isDirectory() && !s.isSymbolicLink()) {
      for (const name of await fs.readdir(path)) await removeTree(`${path}/${name}`);
      await fs.rmdir(path);
    } else await fs.unlink(path);
  };
  await removeTree("store");
  out.removed = await exists("store");
  // disktree / finder trash record JSON round trip
  await fs.mkdir("trash/1", { recursive: true });
  await fs.writeFile("trash/1/entry.json", JSON.stringify({ path: "/x", at: 1 }));
  out.record = JSON.parse(await fs.readFile("trash/1/entry.json", "utf8"));
  // Errors the apps tell apart by message or code.
  const failure = async (p) => { try { await p; return null; } catch (e) { return { code: e.code ?? null, missing: missing(e), message: e.message }; } };
  out.errors = {
    stat: await failure(fs.stat("nowhere")),
    readdir: await failure(fs.readdir("nowhere")),
    mkdir: await failure(fs.mkdir("trash")),
    rmdir: await failure(fs.rmdir("trash")),
  };
  report(out);
})().catch((e) => report({ failed: String(e) }));
"##,
        data_grant(),
        None,
        |data| {
            std::fs::write(data.join("target.txt"), "t").unwrap();
            std::os::unix::fs::symlink("target.txt", data.join("current")).unwrap();
            std::os::unix::fs::symlink("gone", data.join("dangling")).unwrap();
        },
    );
    let out = app.result();
    assert_eq!(out["bytes"], serde_json::json!([37, 80, 68, 70]), "{out}");
    assert_eq!(out["bytesType"], "[object Uint8Array]");
    assert_eq!(out["text"], "# Report\n");
    // Sorted by name, as gpui-shell's `read_dir` sorts.
    assert_eq!(
        out["entries"],
        serde_json::json!([
            ["current", false],
            ["dangling", false],
            ["reports", true],
            ["target.txt", false]
        ])
    );
    assert_eq!(out["names"], serde_json::json!(["day.md", "doc.pdf"]));
    assert_eq!(
        out["stat"],
        serde_json::json!({ "size": 9, "file": true, "dir": false, "kind": "file", "mtime": true, "mode": 0o100000 })
    );
    assert_eq!(
        out["statJson"],
        serde_json::json!([
            "atime",
            "atimeMs",
            "birthtime",
            "birthtimeMs",
            "mode",
            "mtime",
            "mtimeMs",
            "size"
        ])
    );
    assert_eq!(out["spread"], "number");
    assert_eq!(out["direntJson"], r#"{"name":"reports"}"#);
    assert_eq!(out["link"], serde_json::json!(["link", "target.txt"]));
    assert_eq!(out["followed"], "file");
    assert_eq!(out["exists"], serde_json::json!([true, false, true, false]));
    assert_eq!(out["moved"], serde_json::json!([false, true]));
    assert_eq!(out["removed"], false);
    assert_eq!(out["record"], serde_json::json!({ "path": "/x", "at": 1 }));
    // gpui-shell's messages, which the apps' `missing` matches; NSH adds
    // Node's `code`.
    let errors = &out["errors"];
    assert_eq!(
        errors["stat"],
        serde_json::json!({ "code": "ENOENT", "missing": true, "message": "cannot stat `nowhere`: No such file or directory (os error 2)" })
    );
    assert_eq!(errors["readdir"]["code"], "ENOENT");
    assert_eq!(errors["readdir"]["missing"], true);
    assert_eq!(errors["mkdir"]["code"], "EEXIST");
    assert_eq!(errors["mkdir"]["missing"], false);
    assert_eq!(errors["rmdir"]["code"], "ENOTEMPTY");
}

/// What the apps read of the environment: `process.platform` (chat, signed,
/// finder), `process.dataDir` (chat, disktree, finder, skills-manager,
/// signed), `os.homedir()` (disktree, finder, skills-manager), `process.env`.
#[test]
fn process_and_os_metadata() {
    let app = App::start(
        r##"
import process from "process";
import { homedir, platform } from "os";
import os from "os";
report({
  platform: process.platform,
  osPlatform: platform(),
  arch: typeof process.arch,
  global: globalThis.process === process,
  dataDir: process.dataDir,
  home: homedir() === os.homedir() && homedir(),
  envType: typeof process.env,
  spawn: typeof process.spawn,
  run: typeof process.run,
});
"##,
        serde_json::json!({}),
        None,
        |_| {},
    );
    let out = app.result();
    // gpui-shell: `std::env::consts::OS`, so "linux" (and "macos", never
    // "darwin": chat's and signed's "darwin" checks are false there too).
    assert_eq!(out["platform"], "linux", "{out}");
    assert_eq!(out["osPlatform"], "linux");
    assert_eq!(out["arch"], "string");
    assert_eq!(out["global"], true);
    assert_eq!(out["dataDir"], app.data.to_str().unwrap());
    assert_eq!(out["home"], std::env::var("HOME").unwrap());
    assert_eq!(out["envType"], "object");
    assert_eq!(
        (out["spawn"].as_str(), out["run"].as_str()),
        (Some("function"), Some("function"))
    );
}

/// chat `main.js`: `process.run` for versions, `process.spawn` with
/// `{ lines: true, stdin: "null" | "pipe", cwd }`, chained `on("stdout")`
/// / `on("stderr")` / `on("exit")`, `write(line)` and `kill()`; signed and
/// disktree: `run(...)` results' `code` / `stdout` / `stderr`.
#[test]
fn process_calls_of_the_bench_apps() {
    let app = App::start(
        r##"
import process from "process";
(async () => {
  const out = {};
  const ran = await process.run("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"]);
  out.run = { code: ran.code, stdout: ran.stdout, stderr: ran.stderr, keys: Object.keys(ran).sort() };
  const ok = await process.run("/bin/sh", ["-c", "pwd"], { cwd: process.dataDir });
  out.cwd = ok.stdout.trim() === process.dataDir && ok.code === 0;
  // chat: a one-shot provider, read line by line.
  out.lines = await new Promise((resolve) => {
    const lines = [], errs = [];
    const child = process.spawn("/bin/sh", ["-c", "printf 'a\\nb\\r\\nc'; echo e >&2"], { lines: true, stdin: "null", cwd: process.dataDir });
    child.on("stdout", (line) => lines.push(line)).on("stderr", (line) => errs.push(line)).on("exit", (exit) => resolve({ lines, errs, exit }));
  });
  // chat: the codex app server, JSON lines over stdin.
  out.server = await new Promise((resolve) => {
    const replies = [];
    const child = process.spawn("/bin/sh", ["-c", "while read line; do echo \"got $line\"; done"], { lines: true, stdin: "pipe" });
    child.on("stdout", (line) => {
      replies.push(line);
      if (replies.length === 2) child.kill();
    }).on("exit", (exit) => resolve({ replies, exit, pid: typeof child.pid }));
    child.write(JSON.stringify({ id: 0 }) + "\n");
    child.write("second\n");
  });
  // A launch failure: chat's `catch (error)` around spawn, its `run` path.
  try { await process.run("/nonexistent/bin", []); out.missing = "ran"; }
  catch (e) { out.missing = { name: e.constructor.name, code: e.code ?? null, syscall: e.syscall, path: e.path }; }
  try { process.spawn("/nonexistent/bin", [], { lines: true }); out.spawnMissing = "spawned"; }
  catch (e) { out.spawnMissing = { name: e.constructor.name, code: e.code ?? null }; }
  report(out);
})().catch((e) => report({ failed: String(e) }));
"##,
        serde_json::json!({
            "process": { "execute": ["/bin/sh", "/nonexistent/bin"] },
            "fs": { "write": [DATA_GRANT] }
        }),
        None,
        |_| {},
    );
    let out = app.result();
    // gpui-shell's `Output`: exactly `code`, `stdout`, `stderr`.
    assert_eq!(
        out["run"],
        serde_json::json!({ "code": 3, "stdout": "out\n", "stderr": "err\n", "keys": ["code", "stderr", "stdout"] }),
        "{out}"
    );
    assert_eq!(out["cwd"], true);
    // Lines without their endings, the last partial one delivered; the
    // exit `{ code, signal }` with `null` for the half that does not apply.
    // `error` only when the runtime ended the child.
    assert_eq!(
        out["lines"],
        serde_json::json!({ "lines": ["a", "b", "c"], "errs": ["e"], "exit": { "code": 0, "signal": null } })
    );
    assert_eq!(
        out["server"]["replies"],
        serde_json::json!(["got {\"id\":0}", "got second"])
    );
    assert_eq!(out["server"]["exit"]["code"], serde_json::Value::Null);
    assert_eq!(out["server"]["exit"]["signal"], "SIGTERM");
    assert_eq!(out["server"]["pid"], "number");
    // gpui-shell rejects (`run`) and throws (`spawn`) an `Error` with the
    // message; NSH adds Node's `code`, `syscall` and `path`.
    assert_eq!(
        out["missing"],
        serde_json::json!({ "name": "Error", "code": "ENOENT", "syscall": "spawn /nonexistent/bin", "path": "/nonexistent/bin" })
    );
    assert_eq!(
        out["spawnMissing"],
        serde_json::json!({ "name": "Error", "code": "ENOENT" })
    );
}

/// skills-manager, disktree, finder, chat: `randomUUID()`; folio-deck
/// `gmail.js`: PKCE (`randomBytes(32)`, `createHash("sha256")`), base64url
/// and MIME encodings through `Buffer`; signed: `TextEncoder` /
/// `TextDecoder`; finder: `TextDecoder("utf-8", { fatal: true })`.
#[test]
fn crypto_buffer_and_encoding() {
    let app = App::start(
        r##"
import { randomUUID, createHash, randomBytes } from "crypto";
import { Buffer } from "buffer";
const base64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const out = {};
const id = randomUUID();
out.uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) && id !== randomUUID();
const verifier = base64url(randomBytes(32));
out.verifier = verifier.length;
out.challenge = base64url(createHash("sha256").update("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").digest());
out.hex = createHash("sha256").update("abc").digest("hex");
out.subject = `=?UTF-8?B?${Buffer.from("Grüße").toString("base64")}?=`;
out.length = Buffer.from("é" + "x").length;
out.latin1 = Buffer.from("R3L8ZQ==", "base64").toString("latin1");
out.utf8 = Buffer.from("R3LDvMOfZQ==", "base64").toString("utf8");
out.bytes = [...new Uint8Array(Buffer.from("aGk=", "base64"))];
out.instance = Buffer.from("x") instanceof Uint8Array;
out.encoded = [...new TextEncoder().encode("é/")];
out.decoded = new TextDecoder().decode(new Uint8Array([0xc3, 0xa9]));
try { new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff])); out.fatal = "decoded"; }
catch (e) { out.fatal = e.constructor.name; }
out.lossy = new TextDecoder().decode(new Uint8Array([0xff]));
report(out);
"##,
        serde_json::json!({}),
        None,
        |_| {},
    );
    let out = app.result();
    assert_eq!(out["uuid"], true, "{out}");
    assert_eq!(out["verifier"], 43);
    // RFC 7636's example.
    assert_eq!(
        out["challenge"],
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    assert_eq!(
        out["hex"],
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(out["subject"], "=?UTF-8?B?R3LDvMOfZQ==?=");
    assert_eq!(out["length"], 3);
    assert_eq!(out["latin1"], "Grüe");
    assert_eq!(out["utf8"], "Grüße");
    assert_eq!(out["bytes"], serde_json::json!([104, 105]));
    assert_eq!(out["instance"], true);
    assert_eq!(out["encoded"], serde_json::json!([195, 169, 47]));
    assert_eq!(out["decoded"], "é");
    assert_eq!(out["fatal"], "TypeError");
    assert_eq!(out["lossy"], "\u{fffd}");
}

/// Answers every request with JSON naming it: status 404 for `/missing`.
struct JsonNetwork;

struct Done;

impl FetchTask for Done {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {}
}

impl Network for JsonNetwork {
    fn fetch(&self, request: HttpRequest, mut events: FetchEvents) -> Box<dyn FetchTask> {
        let body = match &request.body {
            HttpBody::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
            _ => String::new(),
        };
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
        };
        let status = if request.url.ends_with("/missing") {
            404
        } else {
            200
        };
        let reply = serde_json::json!({
            "method": request.method,
            "url": request.url,
            "body": body,
            "agent": header("user-agent"),
            "accept": header("accept"),
            "type": header("content-type"),
            "message": "Not Found",
        })
        .to_string();
        std::thread::spawn(move || {
            events(FetchEvent::Head(HttpHead {
                status,
                url: request.url,
                headers: vec![("content-type".into(), "application/json".into())],
                ..HttpHead::default()
            }));
            events(FetchEvent::Data(reply.into_bytes()));
            events(FetchEvent::End);
        });
        Box::new(Done)
    }
}

/// skills-manager `getJson` / `getText` (headers, `ok`, `status`, `text()`,
/// `json()`), folio-deck `transport` (a form POST, `json()`), and its URL
/// handling (`new URL(value)`, `.origin`, `.searchParams`).
#[test]
fn fetch_and_url_shapes() {
    let app = App::start(
        r##"
(async () => {
  const out = {};
  const HEADERS = { "User-Agent": "gpui-shell-skills-manager" };
  const response = await fetch("https://api.github.com/repos/x/y", { headers: { ...HEADERS, Accept: "application/vnd.github+json" } });
  const data = await response.json();
  out.get = { ok: response.ok, status: response.status, agent: data.agent, accept: data.accept, method: data.method };
  const missing = await fetch("https://api.github.com/missing", { headers: HEADERS });
  const body = await missing.text();
  out.missing = { ok: missing.ok, status: missing.status, detail: JSON.parse(body).message };
  const form = new URLSearchParams({ client_id: "a b", grant_type: "authorization_code" }).toString();
  const posted = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form })).json();
  out.post = { method: posted.method, body: posted.body, type: posted.type };
  const url = new URL("http://127.0.0.1:9481/callback?code=abc&state=xyz");
  out.url = { origin: url.origin, code: url.searchParams.get("code"), path: url.pathname };
  out.result = `${new URL("http://127.0.0.1:9481/callback").origin}/result`;
  try { new URL("not a url"); out.invalid = "parsed"; } catch (e) { out.invalid = e.constructor.name; }
  report(out);
})().catch((e) => report({ failed: String(e) }));
"##,
        serde_json::json!({ "network": { "hosts": ["api.github.com", "oauth2.googleapis.com"] } }),
        Some(Arc::new(JsonNetwork)),
        |_| {},
    );
    let out = app.result();
    assert_eq!(
        out["get"],
        serde_json::json!({ "ok": true, "status": 200, "agent": "gpui-shell-skills-manager", "accept": "application/vnd.github+json", "method": "GET" }),
        "{out}"
    );
    assert_eq!(
        out["missing"],
        serde_json::json!({ "ok": false, "status": 404, "detail": "Not Found" })
    );
    assert_eq!(
        out["post"],
        serde_json::json!({ "method": "POST", "body": "client_id=a+b&grant_type=authorization_code", "type": "application/x-www-form-urlencoded" })
    );
    assert_eq!(
        out["url"],
        serde_json::json!({ "origin": "http://127.0.0.1:9481", "code": "abc", "path": "/callback" })
    );
    assert_eq!(out["result"], "http://127.0.0.1:9481/result");
    assert_eq!(out["invalid"], "TypeError");
}

/// finder `main.js`: `new URL(".", import.meta.url).pathname` names the
/// app's own directory; gpui-shell sets `import.meta.url` to each module's
/// `file:` URL; NSH's bundler makes each module's `import.meta.url` its
/// own URL in the app's directory (`${pluginDir}`).
#[test]
fn import_meta_url() {
    const BODY: &str = r##"
import { helperUrl } from "./lib/helper.js";
let url = null, root = null;
try { url = import.meta.url ?? null; root = decodeURIComponent(new URL(".", import.meta.url).pathname).replace(/\/$/, ""); }
catch (e) { root = e.constructor.name; }
report({ url, root, helperUrl, image: new URL("./logo.png", import.meta.url).href });
"##;
    let helper = |data: &std::path::Path| {
        let root = data.ancestors().nth(2).unwrap();
        std::fs::create_dir_all(root.join("lib")).unwrap();
        std::fs::write(
            root.join("lib/helper.js"),
            "export const helperUrl = import.meta.url;\n",
        )
        .unwrap();
    };
    let app = App::start(BODY, serde_json::json!({}), None, helper);
    let out = app.result();
    let dir = app.root.canonicalize().unwrap();
    assert_eq!(
        out,
        serde_json::json!({
            "url": format!("file://{}/App.tsx", dir.display()),
            "root": dir.to_str().unwrap(),
            "helperUrl": format!("file://{}/lib/helper.js", dir.display()),
            "image": format!("file://{}/logo.png", dir.display()),
        })
    );
    // Without an app directory (a packaged mobile app), the app's assets.
    let app = App::start_in(BODY, serde_json::json!({}), None, helper, false);
    assert_eq!(
        app.result(),
        serde_json::json!({
            "url": "asset:/App.tsx",
            "root": "",
            "helperUrl": "asset:/lib/helper.js",
            "image": "asset:/logo.png",
        })
    );
}
