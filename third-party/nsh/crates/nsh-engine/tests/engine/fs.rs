//! `fs/promises` through an engine: the module is the runtime's Rust
//! registry (its JS face and declarations come from its spec); its grant
//! checks and limits throw in the call, its disk work settles as core
//! tasks. The probes are gpui-shell's, so its contract holds here too.

use std::{os::unix::fs::symlink, path::PathBuf, sync::atomic::AtomicUsize};

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, MountBatch, Size, platform::Os};
use nsh_engine::{Bundle, Engine, EngineConfig, Environment};

use crate::{ChannelSink, rust_classes::shown};

const APP_ID: &str = "com.example.fs";

/// A directory of its own for one test, outside /tmp.
fn scratch(name: &str) -> PathBuf {
    static DIRS: AtomicUsize = AtomicUsize::new(0);
    let root = crate::temporary_root();
    let dir = root.join(format!(
        "nsh-fs-{name}-{}-{}",
        std::process::id(),
        DIRS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The app `body` (it calls `report(text)` to show `done <text>`) on a
/// desktop, with `capabilities`, its data directory in `data` (the app's
/// own is `data/com.example.fs`) and the trusted anchors `paths`.
fn start(
    body: &str,
    capabilities: &str,
    data: Option<PathBuf>,
    paths: nsh_core::access::TrustedPaths,
) -> (Engine, Receiver<MountBatch>) {
    let dir = scratch("app");
    let entry = dir.join("App.tsx");
    std::fs::write(
        &entry,
        format!(
            r#"import {{ mount, signal, Text }} from "nsh";
const shown = signal("waiting");
const report = (text) => shown.set(`done ${{text}}`);
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
    let _ = std::fs::remove_dir_all(&dir);
    let bundle = Bundle::source(bundled.code)
        .with_app_id(Some(APP_ID))
        .with_system_paths(paths)
        .with_capabilities_json(Some(capabilities))
        .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(bundle),
        viewport: Size::new(nsh_core::geometry::px(400.0), nsh_core::geometry::px(300.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Environment {
            os: if cfg!(target_os = "macos") {
                Os::MacOs
            } else {
                Os::Linux
            },
            ..Default::default()
        },
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: data,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// A data root whose app directory (returned second) the app may read and
/// write as `${dataDir}`.
fn data_dir(name: &str) -> (PathBuf, PathBuf) {
    let root = scratch(name);
    let app = root.join(APP_ID);
    std::fs::create_dir_all(&app).unwrap();
    // Canonical, as the grant check compares it.
    let app = app.canonicalize().unwrap();
    (root, app)
}

const DATA_GRANT: &str = r#"{"fs":{"read":["${dataDir}"],"write":["${dataDir}"]}}"#;

/// Runs a gpui-shell probe: its `View` and `cx` are stand-ins, and its
/// `notify` reports the state.
fn probe(source: &str) -> String {
    source
        .replace("import { div, View } from \"gpui-kit\";", "class View {}")
        .replace(
            "import { v_flex } from \"gpui-base\";",
            "const v_flex = () => ({ child: (value) => value });",
        )
        .replace("export default class Probe", "class Probe")
        + "\nconst probe = new Probe();\nprobe.init({}, { spawn: (task) => task({ notify() { report(probe.state); } }) });\n"
}

/// The probe of `marker` in gpui-shell's `crates/shell/src/tests/fs.rs`,
/// when `NSH_GPUI_SHELL_REFERENCE` names a checkout: it must be the copy
/// here, and its expectation `expected`.
fn check_reference(marker: &str, copy: &str, expected: &str) {
    let Some(reference) = std::env::var_os("NSH_GPUI_SHELL_REFERENCE") else {
        return;
    };
    let source =
        std::fs::read_to_string(PathBuf::from(reference).join("crates/shell/src/tests/fs.rs"))
            .unwrap();
    let body = source
        .split_once(marker)
        .unwrap()
        .1
        .split_once("\"#;")
        .unwrap()
        .0;
    assert_eq!(
        copy, body,
        "refresh the exact reference probe when its contract changes"
    );
    assert!(source.contains(expected));
}

// Exact script from gpui-shell's stat_rename_and_readlink_settle_through_promises.
const REFERENCE_METADATA_PROBE: &str = r#"
import { div, View } from "gpui-kit";
import { v_flex } from "gpui-base";
import * as fs from "fs/promises";

export default class Probe extends View {
  init(_props, cx) {
    this.state = "pending";
    cx.spawn(async (cx) => {
      try {
        await fs.writeFile("draft.txt", "hello");
        const file = await fs.stat("draft.txt");
        const root = await fs.stat(".");
        const fresh = Date.now() - file.mtimeMs < 60000 && file.mtime instanceof Date;
        await fs.rename("draft.txt", "final.txt");
        const moved = !(await fs.exists("draft.txt")) && await fs.readFile("final.txt", "utf8");
        const link = await fs.lstat("link.txt");
        const target = await fs.readlink("link.txt");
        const followed = await fs.stat("link.txt");
        this.state = [
          `${file.isFile()}:${file.isDirectory()}:${file.size}:${fresh}`,
          `${root.isDirectory()}`,
          moved,
          `${link.isSymbolicLink()}:${target}:${followed.isFile()}:${followed.isSymbolicLink()}`,
        ].join("|");
      } catch (error) {
        this.state = `failed: ${error.message}`;
      }
      cx.notify();
    });
  }
  render() { return v_flex().child(this.state); }
}
"#;

#[test]
fn reference_metadata_script_matches_gpui_shell_contract() {
    let expected = "true:false:5:true|true|hello|true:target.txt:true:false";
    check_reference(
        "const METADATA_PROBE: &str = r#\"",
        REFERENCE_METADATA_PROBE,
        expected,
    );
    let (root, app) = data_dir("metadata");
    std::fs::write(app.join("target.txt"), "linked").unwrap();
    symlink("target.txt", app.join("link.txt")).unwrap();
    let (_engine, rx) = start(
        &probe(REFERENCE_METADATA_PROBE),
        DATA_GRANT,
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(shown(&rx, "done"), format!("done {expected}"));
    let _ = std::fs::remove_dir_all(root);
}

const REFERENCE_IO_PROBE: &str = r#"
import { div, View } from "gpui-kit";
import { v_flex } from "gpui-base";
import * as fs from "fs/promises";

export default class Probe extends View {
  init(_props, cx) {
    this.state = "pending";

    cx.spawn(async (cx) => {
      try {
        await fs.writeFile("notes.txt", "hello");
        await fs.writeFile("bytes.bin", new Uint8Array([0, 255, 42]));
        const back = await fs.readFile("notes.txt", "utf8");
        const bytes = await fs.readFile("bytes.bin");
        const names = await fs.readdir(".");
        const entries = await fs.readdir(".", { withFileTypes: true });
        const entryShape = entries.every((entry) =>
          typeof entry.name === "string" && typeof entry.isDirectory() === "boolean"
        );
        const there = await fs.exists("notes.txt");

        await fs.mkdir("nested/deeper", { recursive: true });
        const nested = await fs.exists("nested/deeper");

        await fs.unlink("notes.txt");
        const gone = !(await fs.exists("notes.txt"));

        this.state = `${back}|${bytes instanceof Uint8Array}:${[...bytes].join(",")}|${names.join(",")}|${entryShape}|${there}|${nested}|${gone}`;
      } catch (error) {
        this.state = `failed: ${error.message}`;
      }
      cx.notify();
    });
  }

  render() {
    return v_flex().child(this.state);
  }
}
"#;

#[test]
fn reference_io_script_matches_gpui_shell_contract() {
    let expected = "hello|true:0,255,42|bytes.bin,notes.txt|true|true|true|true";
    check_reference("const PROBE: &str = r#\"", REFERENCE_IO_PROBE, expected);
    let (root, _app) = data_dir("io");
    let (_engine, rx) = start(
        &probe(REFERENCE_IO_PROBE),
        DATA_GRANT,
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(shown(&rx, "done"), format!("done {expected}"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn options_errors_and_link_operations_match_the_reference() {
    let (root, app) = data_dir("options");
    let outside = root.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret"), "safe").unwrap();
    std::fs::write(app.join("invalid"), [0xff]).unwrap();
    symlink(outside.join("secret"), app.join("link")).unwrap();
    symlink(outside.join("secret"), app.join("absolute")).unwrap();
    symlink(app.join("missing"), app.join("dangling")).unwrap();
    let absolute = serde_json::to_string(&app.join("absolute")).unwrap();
    let body = r#"
import fs from "fs/promises";
import * as namespace from "fs/promises";
const absoluteLink = ABSOLUTE;
(async () => {
  const expected = ["default", "exists", "lstat", "mkdir", "readFile", "readdir", "readlink", "rename", "rmdir", "stat", "unlink", "writeFile"];
  if (JSON.stringify(Object.keys(namespace).sort()) !== JSON.stringify(expected.sort())) throw Error("exports differ: " + Object.keys(namespace));
  if (fs.readFile !== namespace.readFile) throw Error("default and named exports differ");
  let sync = 0;
  for (const op of [
    () => fs.readFile("invalid", "base64"),
    () => fs.readFile("invalid", {}),
    () => fs.readFile("invalid", { encoding: "utf8", other: true }),
    () => fs.mkdir("never", { recursive: "yes" }),
    () => fs.mkdir("never", { typo: true }),
    () => fs.readdir(".", { withFileTypes: 1 }),
    () => fs.readdir(".", { recursive: true }),
    () => fs.exists("/outside-native-root"),
    () => fs.writeFile("never", new ArrayBuffer(4)),
    () => fs.writeFile("never", new Uint16Array(2)),
    () => fs.readFile(1),
  ]) {
    try { op(); } catch (e) { if (e instanceof TypeError) sync++; }
  }
  if (sync !== 11) throw Error("sync checks " + sync);
  let getterCalls = 0;
  await fs.readdir(".", { get withFileTypes() { getterCalls++; return true; } });
  if (getterCalls !== 1) throw Error("option getter called " + getterCalls + " times");
  let invalid = false;
  try { await fs.readFile("invalid", "utf8"); } catch (e) { invalid = e.constructor === Error && e.message.includes("invalid") && e.message.includes("UTF-8"); }
  if (!invalid) throw Error("UTF-8 error differs");
  if ((await fs.readFile("invalid", { encoding: "UTF-8" }).catch((e) => e.message)).includes("UTF-8") !== true) throw Error("object encoding");
  const link = await fs.lstat("link");
  const target = await fs.readlink("link");
  if (!link.isSymbolicLink() || !target.endsWith("/secret")) throw Error("link was followed");
  let denied = false;
  try { await fs.readFile("link"); } catch (e) { denied = e.constructor === Error && !e.message.includes("capabilities.fs"); }
  if (!denied) throw Error("outside read allowed");
  if (!(await fs.exists("link"))) throw Error("link missed");
  if (!(await fs.exists("dangling")) || !(await fs.lstat("dangling")).isSymbolicLink()) throw Error("dangling link missed");
  await fs.unlink("dangling");
  if (await fs.exists("dangling")) throw Error("dangling link kept");
  await fs.unlink(absoluteLink);
  if (await fs.exists("absolute")) throw Error("absolute link kept");
  await fs.rename("link", "moved");
  if (!(await fs.lstat("moved")).isSymbolicLink()) throw Error("rename followed");
  await fs.unlink("moved");
  await fs.mkdir("empty");
  if (await fs.rmdir("empty") !== undefined) throw Error("rmdir return");
  await fs.mkdir("nonempty");
  await fs.writeFile("nonempty/file", "keep");
  let rejected = false;
  try { await fs.rmdir("nonempty"); } catch (e) { rejected = e.constructor === Error; }
  if (!rejected || !(await fs.exists("nonempty/file"))) throw Error("recursive removal");
  let missing = "";
  try { await fs.stat("nowhere"); } catch (e) { missing = e.message; }
  if (!missing.startsWith("cannot stat `nowhere`:")) throw Error("missing entry: " + missing);
  report("ok");
})().catch((e) => report(String(e)));
"#
    .replace("ABSOLUTE", &absolute);
    let (_engine, rx) = start(&body, DATA_GRANT, Some(root.clone()), Default::default());
    assert_eq!(shown(&rx, "done"), "done ok");
    assert_eq!(
        std::fs::read_to_string(outside.join("secret")).unwrap(),
        "safe"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn stats_and_dirents_have_node_s_shape() {
    let (root, app) = data_dir("shapes");
    std::fs::create_dir(app.join("folder")).unwrap();
    let (_engine, rx) = start(
        r#"
import { writeFile, stat, readdir } from "fs/promises";
(async () => {
  await writeFile("binary", Buffer.from([0, 255, 128, 10]));
  const info = await stat("binary");
  const entries = await readdir(".", { withFileTypes: true });
  const ok = info.size === 4 && info.isFile() && !info.isDirectory() && !info.isSymbolicLink()
    && typeof info.mode === "number" && (info.mode & 0o170000) === 0o100000
    && info.mtime instanceof Date && Math.abs(info.mtime.getTime() - info.mtimeMs) < 1
    && info.atime instanceof Date && info.birthtime instanceof Date
    && entries.map((e) => `${e.name}:${e.isDirectory()}`).join(",") === "binary:false,folder:true";
  report(ok ? "ok" : `bad ${JSON.stringify({ ...entries.map((e) => e.name), mode: info.mode, size: info.size })}`);
})().catch((e) => report(String(e)));
"#,
        DATA_GRANT,
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(shown(&rx, "done"), "done ok");
    assert_eq!(
        std::fs::read(app.join("binary")).unwrap(),
        [0, 255, 128, 10]
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn read_and_write_limits_match_the_reference() {
    let (root, app) = data_dir("limits");
    let big = std::fs::File::create(app.join("over-read-limit")).unwrap();
    big.set_len(64 * 1024 * 1024 + 1).unwrap();
    let allowed = std::fs::File::create(app.join("above-native-text-limit")).unwrap();
    allowed.set_len(16 * 1024 * 1024 + 1).unwrap();
    let (_engine, rx) = start(
        r#"
import fs from "fs/promises";
(async () => {
  let read = false;
  try { await fs.readFile("over-read-limit"); } catch (e) { read = e.constructor === Error && e.message.includes("67108864"); }
  let write = false;
  try { fs.writeFile("not-created", "x".repeat(8 * 1024 * 1024 + 1)); } catch (e) { write = e instanceof RangeError && e.message.includes("8388608-byte"); }
  // A buffer past the limit is refused by its length, before it is copied.
  try { fs.writeFile("not-created", new Uint8Array(64 * 1024 * 1024)); write = false; } catch (e) { write = write && e instanceof RangeError && e.message.includes("67108864 bytes"); }
  const bytes = await fs.readFile("above-native-text-limit");
  report(read && write && Object.getPrototypeOf(bytes) === Uint8Array.prototype && bytes.length === 16 * 1024 * 1024 + 1 ? "ok" : "bad");
})().catch((e) => report(String(e)));
"#,
        DATA_GRANT,
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(shown(&rx, "done"), "done ok");
    assert!(!app.join("not-created").exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn data_in_flight_is_bounded_per_vm() {
    let (root, app) = data_dir("in-flight");
    for name in ["first", "second"] {
        let file = std::fs::File::create(app.join(name)).unwrap();
        file.set_len(40 * 1024 * 1024).unwrap();
    }
    let (_engine, rx) = start(
        r#"
import fs from "fs/promises";
(async () => {
  // Writes hold their data from the call; nothing settles within one turn.
  const data = "x".repeat(8 * 1024 * 1024);
  const writes = [];
  let refused = false;
  try { for (let i = 0; i < 9; i++) writes.push(fs.writeFile("w" + i, data)); }
  catch (e) { refused = e instanceof RangeError && e.message.includes("in flight"); }
  await Promise.all(writes);
  // Both reads are under way at once: the second does not fit.
  const reads = (await Promise.allSettled([fs.readFile("first"), fs.readFile("second")]))
    .map((r) => r.status === "fulfilled" ? r.value.length : r.reason.message);
  const one = reads.includes(40 * 1024 * 1024) && reads.some((r) => String(r).includes("in flight"));
  // Settled data returns to the budget.
  const again = (await fs.readFile("second")).length === 40 * 1024 * 1024;
  report(`${writes.length} ${refused} ${one} ${again}`);
})().catch((e) => report(String(e)));
"#,
        DATA_GRANT,
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(shown(&rx, "done"), "done 8 true true true");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn explicit_absolute_roots_work_without_an_app_data_directory() {
    let (_engine, rx) = start(
        r#"
import fs from "fs/promises";
try { fs.readdir("/home"); report("listed"); }
catch (e) { report(`${e instanceof TypeError} ${e.message}`); }
"#,
        "{}",
        None,
        Default::default(),
    );
    assert_eq!(
        shown(&rx, "done"),
        "done true filesystem read is not granted by capabilities.fs.read"
    );
    let dir = scratch("absolute").canonicalize().unwrap();
    let file = serde_json::to_string(&dir.join("plain")).unwrap();
    let grant = serde_json::json!({"fs": {"read": [dir], "write": [dir]}}).to_string();
    let (_engine, rx) = start(
        &format!(
            r#"
import fs from "fs/promises";
(async () => {{
  await fs.writeFile({file}, "plain");
  report(await fs.readFile({file}, "utf8"));
}})().catch((e) => report(String(e)));
"#
        ),
        &grant,
        None,
        Default::default(),
    );
    assert_eq!(shown(&rx, "done"), "done plain");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn trusted_plugin_home_and_relative_roots_are_resolved_by_host_anchors() {
    let (root, app) = data_dir("anchors");
    let (plugin, home) = (root.join("plugin"), root.join("home"));
    for path in [
        plugin.join("resources"),
        plugin.join("relative"),
        home.join("exports"),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    let (plugin, home) = (plugin.canonicalize().unwrap(), home.canonicalize().unwrap());
    let mut anchors = nsh_core::access::TrustedPaths::default();
    anchors.plugin_dir = Some(plugin.clone());
    anchors.home_dir = Some(home.clone());
    let grant = r#"{"fs":{"read":["${pluginDir}/resources","relative","${homeDir}/exports"],"write":["${pluginDir}/resources","relative","${homeDir}/exports"]}}"#;
    let relative = serde_json::to_string(&plugin.join("relative/second.txt")).unwrap();
    let (_engine, rx) = start(
        &format!(
            r#"
import fs from "fs/promises";
(async () => {{
  await fs.writeFile("first.txt", "first");
  await fs.writeFile({relative}, "second");
  await fs.writeFile("${{homeDir}}/exports/home.txt", "home");
  await fs.writeFile("${{pluginDir}}/resources/native.txt", "native");
  const back = await fs.readFile("${{pluginDir}}/resources/native.txt", "utf8");
  report((await fs.readFile("first.txt", "utf8")) === "first" && (await fs.readFile({relative}, "utf8")) === "second" && back === "native" ? "ok" : "bad");
}})().catch((e) => report(String(e)));
"#
        ),
        grant,
        Some(root.clone()),
        anchors,
    );
    assert_eq!(shown(&rx, "done"), "done ok");
    assert_eq!(
        std::fs::read_to_string(home.join("exports/home.txt")).unwrap(),
        "home"
    );
    assert!(app.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn named_and_default_exports_enforce_grants() {
    let (root, app) = data_dir("denied");
    let p = serde_json::to_string(&app.join("denied")).unwrap();
    let (_engine, rx) = start(
        &format!(
            r#"
import fs, {{ writeFile, readFile, exists }} from "fs/promises";
(async () => {{
  let rejected = 0;
  for (const operation of [() => fs.writeFile({p}, "x"), () => writeFile({p}, "x"), () => fs.readFile({p}), () => readFile({p}), () => exists({p})]) {{
    try {{ await operation(); }} catch (e) {{ if (e instanceof TypeError && e.message.includes("capabilities.fs")) rejected++; }}
  }}
  report(rejected === 5 ? "ok" : `bad ${{rejected}}`);
}})().catch((e) => report(String(e)));
"#
        ),
        "{}",
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(shown(&rx, "done"), "done ok");
    assert!(!app.join("denied").exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_symlink_cannot_escape_its_root() {
    let (root, app) = data_dir("escape");
    let outside = root.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret"), "untouched").unwrap();
    symlink(&outside, app.join("escape")).unwrap();
    let p = serde_json::to_string(&app.join("escape/secret")).unwrap();
    let (_engine, rx) = start(
        &format!(
            r#"
import fs, {{ readFile }} from "fs/promises";
(async () => {{
  let denied = 0;
  for (const op of [() => readFile({p}), () => fs.writeFile({p}, "changed"), () => fs.unlink({p}), () => fs.stat({p}), () => fs.readFile("escape/secret")]) {{
    try {{ await op(); }} catch {{ denied++; }}
  }}
  report(denied === 5 ? "ok" : `bad ${{denied}}`);
}})().catch((e) => report(String(e)));
"#
        ),
        DATA_GRANT,
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(shown(&rx, "done"), "done ok");
    assert_eq!(
        std::fs::read_to_string(outside.join("secret")).unwrap(),
        "untouched"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_fifo_is_refused_without_blocking() {
    let (root, app) = data_dir("fifo");
    let fifo = std::ffi::CString::new(app.join("pipe").to_str().unwrap()).unwrap();
    // SAFETY: a NUL-terminated path.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let (_engine, rx) = start(
        r#"
import fs from "fs/promises";
fs.readFile("pipe").then(() => report("read"), (e) => report(e.message));
"#,
        DATA_GRANT,
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(
        shown(&rx, "done"),
        "done cannot read `pipe`: not a regular file"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn files_are_unavailable_on_a_mobile_surface() {
    let (root, _app) = data_dir("mobile");
    let dir = scratch("mobile-app");
    let entry = dir.join("App.tsx");
    std::fs::write(
        &entry,
        r#"import { mount, Text } from "nsh";
import fs from "fs/promises";
let shown = "";
try { fs.readFile("x"); } catch (e) { shown = `done ${e instanceof TypeError} ${e.message}`; }
mount(() => <Text>{shown}</Text>);
"#,
    )
    .unwrap();
    let bundled = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
    })
    .unwrap();
    let bundle = Bundle::source(bundled.code)
        .with_app_id(Some(APP_ID))
        .with_capabilities_json(Some(DATA_GRANT))
        .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(bundle),
        viewport: Size::new(nsh_core::geometry::px(400.0), nsh_core::geometry::px(300.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Environment {
            os: Os::Ios,
            ..Default::default()
        },
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: Some(root.clone()),
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    let _engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    assert_eq!(
        shown(&rx, "done"),
        "done true native filesystem unavailable on this platform"
    );
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn failures_carry_node_s_codes() {
    let (root, app) = data_dir("codes");
    std::fs::create_dir_all(app.join("full/inner")).unwrap();
    std::fs::write(app.join("invalid"), [0xff]).unwrap();
    symlink("loop", app.join("loop")).unwrap();
    let (_engine, rx) = start(
        r#"
import fs from "fs/promises";
const failure = (p) => p.then(() => "none", (e) => `${e.constructor.name}:${e.code}:${e.syscall}:${e.path}`);
(async () => {
  let denied = "";
  try { fs.readFile("/outside-every-root"); } catch (e) { denied = `${e.constructor.name}:${e.code}:${e.path}`; }
  const codes = [
    denied,
    await failure(fs.stat("nowhere")),
    await failure(fs.readFile("nowhere")),
    await failure(fs.mkdir("full")),
    await failure(fs.rmdir("full")),
    await failure(fs.readFile("full")),
    await failure(fs.readdir("invalid")),
    await failure(fs.readFile("invalid", "utf8")),
    await failure(fs.stat("loop")),
  ];
  report(codes.join("|"));
})().catch((e) => report(String(e)));
"#,
        DATA_GRANT,
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(
        shown(&rx, "done"),
        "done TypeError:EACCES:/outside-every-root\
         |Error:ENOENT:stat:nowhere\
         |Error:ENOENT:open:nowhere\
         |Error:EEXIST:mkdir:full\
         |Error:ENOTEMPTY:rmdir:full\
         |Error:EISDIR:open:full\
         |Error:ENOTDIR:scandir:invalid\
         |Error:EILSEQ:undefined:invalid\
         |Error:ELOOP:stat:loop"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_read_root_that_does_not_exist_yet_has_no_entries() {
    // A fresh install: the data root exists, the app's directory does not.
    let root = scratch("fresh");
    let (_engine, rx) = start(
        r#"
import fs from "fs/promises";
const code = (p) => p.then(() => "none", (e) => `${e.constructor.name}:${e.code}`);
(async () => {
  const before = [await fs.exists("notes.txt"), await code(fs.readFile("notes.txt", "utf8")), await code(fs.readdir("."))];
  await fs.writeFile("notes.txt", "kept");
  report([...before, await fs.readFile("notes.txt", "utf8")].join("|"));
})().catch((e) => report(String(e)));
"#,
        DATA_GRANT,
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(
        shown(&rx, "done"),
        "done false|Error:ENOENT|Error:ENOENT|kept"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[test]
fn a_file_longer_than_its_size_says_is_read_whole() {
    // `/proc` files say they are empty; the read holds more as it goes.
    let (_engine, rx) = start(
        r#"
import fs from "fs/promises";
(async () => {
  const size = (await fs.stat("status")).size;
  const text = await fs.readFile("status", "utf8");
  report(`${size} ${text.startsWith("Name:")} ${text.length > 100}`);
})().catch((e) => report(String(e)));
"#,
        r#"{"fs":{"read":["/proc/self"]}}"#,
        None,
        Default::default(),
    );
    assert_eq!(shown(&rx, "done"), "done 0 true true");
}

#[cfg(target_os = "linux")]
#[test]
fn a_root_under_a_directory_it_may_only_pass_through_opens() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("pass-through").canonicalize().unwrap();
    let inner = dir.join("locked/inner");
    std::fs::create_dir_all(&inner).unwrap();
    std::fs::write(inner.join("note.txt"), "through").unwrap();
    // Search permission only, as a home directory of 0711 gives others.
    std::fs::set_permissions(dir.join("locked"), std::fs::Permissions::from_mode(0o311)).unwrap();
    let file = serde_json::to_string(&inner.join("note.txt")).unwrap();
    let grant = serde_json::json!({ "fs": { "read": [inner] } }).to_string();
    let (_engine, rx) = start(
        &format!(
            r#"
import fs from "fs/promises";
fs.readFile({file}, "utf8").then(report, (e) => report(String(e)));
"#
        ),
        &grant,
        None,
        Default::default(),
    );
    let shown = shown(&rx, "done");
    std::fs::set_permissions(dir.join("locked"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(shown, "done through");
}

#[test]
fn a_root_named_through_a_link_is_reached_by_either_name() {
    // As `/var` and `/private/var` on macOS: the grant names the link.
    let dir = scratch("linked-root").canonicalize().unwrap();
    std::fs::create_dir(dir.join("real")).unwrap();
    std::fs::write(dir.join("real/note.txt"), "either").unwrap();
    symlink(dir.join("real"), dir.join("alias")).unwrap();
    let grant = serde_json::json!({ "fs": { "read": [dir.join("alias")] } }).to_string();
    let (by_link, by_target) = (
        serde_json::to_string(&dir.join("alias/note.txt")).unwrap(),
        serde_json::to_string(&dir.join("real/note.txt")).unwrap(),
    );
    let (_engine, rx) = start(
        &format!(
            r#"
import fs from "fs/promises";
(async () => {{
  report([await fs.readFile({by_link}, "utf8"), await fs.readFile({by_target}, "utf8")].join("|"));
}})().catch((e) => report(String(e)));
"#
        ),
        &grant,
        None,
        Default::default(),
    );
    assert_eq!(shown(&rx, "done"), "done either|either");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_directory_past_the_readdir_limit_is_refused_with_a_code() {
    let (root, app) = data_dir("many");
    std::fs::create_dir(app.join("many")).unwrap();
    for i in 0..10_001 {
        std::fs::write(app.join(format!("many/{i:05}")), "").unwrap();
    }
    std::fs::create_dir(app.join("some")).unwrap();
    for i in 0..3_000 {
        std::fs::write(app.join(format!("some/{i:05}-{}", "n".repeat(40))), "").unwrap();
    }
    let (_engine, rx) = start(
        r#"
import fs from "fs/promises";
(async () => {
  const many = await fs.readdir("many").then(() => "listed", (e) => `${e.constructor.name}:${e.code}`);
  // About 140 KB of names: listed in batches held ahead.
  const some = await fs.readdir("some");
  report(`${many} ${some.length} ${some[0].startsWith("00000-")}`);
})().catch((e) => report(String(e)));
"#,
        DATA_GRANT,
        Some(root.clone()),
        Default::default(),
    );
    assert_eq!(
        shown(&rx, "done"),
        "done RangeError:ERR_OUT_OF_RANGE 3000 true"
    );
    let _ = std::fs::remove_dir_all(root);
}
