//! `process` through an engine: the module is the runtime's Rust registry
//! (its JS face and declarations come from its spec); a child's events are
//! core tasks posting to its listeners, and the VM's children go with it.
#![cfg(target_os = "linux")]

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, MountBatch, Size, platform::Os};
use nsh_engine::{Bundle, Engine, EngineConfig, Environment};

use crate::{ChannelSink, rust_classes::shown};

static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// An app running `body` (after `report`, which shows `done <text>`, and
/// `show`, which shows any text) with `capabilities`, and the app's data
/// directory (the default `cwd`).
struct App {
    engine: Option<Engine>,
    rx: Receiver<MountBatch>,
    root: PathBuf,
    data: PathBuf,
}

impl App {
    fn start(body: &str, capabilities: serde_json::Value) -> Self {
        Self::start_with(body, capabilities, |_| {
            nsh_core::access::TrustedPaths::default()
        })
    }

    fn start_with(
        body: &str,
        capabilities: serde_json::Value,
        paths: impl FnOnce(&Path) -> nsh_core::access::TrustedPaths,
    ) -> Self {
        let root = crate::temporary_root().join(format!(
            "nsh-process-{}-{}",
            std::process::id(),
            APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let entry = root.join("App.tsx");
        std::fs::write(
            &entry,
            format!(
                r#"import {{ mount, signal, Text }} from "nsh";
import process from "process";
const shown = signal("waiting");
const show = (text) => shown.set(text);
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
        let bundle = Bundle::source(bundled.code)
            .with_app_id(Some("com.example.process"))
            .with_system_paths(paths(&root))
            .with_capabilities_json(Some(&capabilities.to_string()))
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
        let data = root.join("data/com.example.process");
        Self {
            engine: Some(engine),
            rx,
            root,
            data,
        }
    }

    /// The text shown once one starts with `prefix`.
    fn shown(&self, prefix: &str) -> String {
        shown(&self.rx, prefix)
    }

    fn drop_engine(&mut self) -> Duration {
        let start = Instant::now();
        drop(self.engine.take());
        start.elapsed()
    }
}

impl Drop for App {
    fn drop(&mut self) {
        drop(self.engine.take());
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn shell() -> serde_json::Value {
    serde_json::json!({ "process": { "execute": ["/bin/sh", "/usr/bin/env", "/nonexistent/nsh-fixture"] } })
}

/// The pid a fixture wrote to `file`, once it has.
fn pid_in(file: &Path) -> u32 {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(text) = std::fs::read_to_string(file)
            && let Ok(pid) = text.trim().parse()
        {
            return pid;
        }
        assert!(Instant::now() < until, "{} was not written", file.display());
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn assert_stopped(pid: u32) {
    // A killed orphan can remain a zombie until init reaps it.
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"));
        if stat.is_err() || stat.unwrap().split(") ").nth(1).unwrap().starts_with('Z') {
            return;
        }
        assert!(Instant::now() < until, "process {pid} survived");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn output_arrives_before_a_stdin_round_trip_and_the_exit_comes_last() {
    let app = App::start(
        r#"const events = [];
const child = process.spawn("/bin/sh", ["-c", 'printf ready; read line; printf "%s" "$line"; printf err >&2'], { stdin: "pipe" });
if (child.on("stdout", (text) => {
  events.push(["out", text]);
  if (text === "ready") { child.write("roundtrip\n"); child.end(); }
}) !== child) throw Error("on chains");
child.on("stderr", (text) => events.push(["err", text]));
child.on("exit", (r) => { events.push(["exit", r.code, r.signal]); report(JSON.stringify(events)); });"#,
        shell(),
    );
    let events: serde_json::Value =
        serde_json::from_str(app.shown("done").trim_start_matches("done ")).unwrap();
    let events = events.as_array().unwrap();
    assert_eq!(events[0], serde_json::json!(["out", "ready"]));
    assert!(events.contains(&serde_json::json!(["out", "roundtrip"])));
    assert!(events.contains(&serde_json::json!(["err", "err"])));
    assert_eq!(
        events.last().unwrap(),
        &serde_json::json!(["exit", 0, null])
    );
}

#[test]
fn run_keeps_split_utf8_and_captures_both_pipes() {
    let app = App::start(
        r#"process.run("/bin/sh", ["-c", "printf '\\342'; sleep 0.03; printf '\\202\\254'; printf warning >&2"])
  .then((r) => report(JSON.stringify(r)), (e) => report(String(e)));"#,
        shell(),
    );
    assert_eq!(
        app.shown("done"),
        r#"done {"code":0,"stdout":"€","stderr":"warning"}"#
    );
}

#[test]
fn a_refused_command_and_a_failed_launch_throw_and_run_rejects_a_failed_launch() {
    let app = App::start(
        r#"const lines = [];
const shape = (e) => `${e.constructor.name} ${e.code} ${e.syscall} ${e.path} ${e.message.includes("capability denied")}`;
for (const command of ["definitely-not-granted", "/nonexistent/nsh-fixture"]) {
  try { process.spawn(command); lines.push("spawned"); } catch (e) { lines.push(shape(e)); }
}
try { process.run("not-granted"); } catch (e) { lines.push(shape(e)); }
process.run("/nonexistent/nsh-fixture").then(() => report("ran"), (e) => report(`${lines.join("|")}|${shape(e)}`));"#,
        shell(),
    );
    assert_eq!(
        app.shown("done"),
        "done TypeError EACCES spawn definitely-not-granted definitely-not-granted true|\
         Error ENOENT spawn /nonexistent/nsh-fixture /nonexistent/nsh-fixture false|\
         TypeError EACCES spawn not-granted not-granted true|\
         Error ENOENT spawn /nonexistent/nsh-fixture /nonexistent/nsh-fixture false"
    );
}

#[test]
fn kill_ends_the_descendants_and_the_exit_comes_once_after_the_output() {
    let app = App::start(
        r#"const events = [];
const child = process.spawn("/bin/sh", ["-c", "sleep 30 & echo $! > descendant.pid; printf ready; wait"]);
child.on("stdout", (text) => { events.push(text); child.kill(); });
child.on("exit", (r) => { events.push(`${r.code} ${r.signal}`); setTimeout(() => report(events.join("|")), 50); });"#,
        shell(),
    );
    assert_eq!(app.shown("done"), "done ready|null SIGTERM");
    assert_stopped(pid_in(&app.data.join("descendant.pid")));
}

#[test]
fn dropping_the_engine_ends_the_tree_even_with_blocked_stdin() {
    let mut app = App::start(
        r#"const child = process.spawn("/bin/sh", ["-c", "echo $$ > vm-child.pid; sleep 30"], { stdin: "pipe" });
child.write("x".repeat(900000));"#,
        shell(),
    );
    let pid = pid_in(&app.data.join("vm-child.pid"));
    assert!(app.drop_engine() < Duration::from_secs(2));
    assert_stopped(pid);
}

#[test]
fn dropping_the_engine_kills_every_child_at_once_even_when_they_ignore_sigterm() {
    let mut app = App::start(
        r#"for (let i = 0; i < 32; i++) {
  process.spawn("/bin/sh", ["-c", `trap '' TERM; echo $$ > stubborn-${i}.pid; sleep 30; sleep 30`]);
}"#,
        shell(),
    );
    let pids: Vec<u32> = (0..32)
        .map(|i| pid_in(&app.data.join(format!("stubborn-{i}.pid"))))
        .collect();
    std::thread::sleep(Duration::from_millis(20));
    // Serially, a 250 ms grace per child would take 8 seconds.
    let took = app.drop_engine();
    assert!(took < Duration::from_secs(1), "teardown took {took:?}");
    for pid in pids {
        assert_stopped(pid);
    }
}

#[test]
fn run_rejects_a_timeout_and_output_past_its_limit() {
    let app = App::start(
        r#"Promise.all([
  process.run("/bin/sh", ["-c", "sleep 30"], { timeoutMs: 25 }).then(() => "ran", (e) => String(e)),
  // `head` is found on the child's PATH, which the host passes on.
  process.run("/bin/sh", ["-c", "head -c 9437184 /dev/zero"]).then(() => "ran", (e) => String(e)),
]).then((r) => report(r.join("|")));"#,
        shell(),
    );
    assert_eq!(
        app.shown("done"),
        "done Error: process timed out|Error: process output exceeded 8388608 bytes on one stream"
    );
}

#[test]
fn a_reactive_owners_cleanup_ends_its_child() {
    let app = App::start(
        r#"import { signal as s, effect } from "nsh";
const enabled = s(true);
effect(() => {
  if (!enabled()) return;
  const owned = process.spawn("/bin/sh", ["-c", "echo $$ > owner-child.pid; sleep 30"]);
  owned.on("exit", (r) => report(`${r.code} ${r.signal}`));
});
setTimeout(() => enabled.set(false), 200);"#,
        shell(),
    );
    let pid = pid_in(&app.data.join("owner-child.pid"));
    assert_eq!(app.shown("done"), "done null SIGTERM");
    assert_stopped(pid);
}

#[test]
fn detached_inherited_pipes_hold_back_neither_the_exit_nor_the_engine() {
    // The leader stays alive until its descendant has entered its own
    // session; a fixed sleep races the supervisor on loaded hosts.
    for drop_engine in [false, true] {
        let mut app = App::start(
            r#"const child = process.spawn("/bin/sh", ["-c", `setsid /bin/sh -c 'echo $$ > detached.pid; exec sleep 30' <&0 & while [ ! -s detached.pid ]; do sleep 0.01; done; printf ready`], { stdin: "pipe" });
child.write("x".repeat(900000));
const out = [];
child.on("stdout", (t) => out.push(t));
child.on("exit", (r) => report(`${out.join("")} ${r.code}`));"#,
            shell(),
        );
        let pid = pid_in(&app.data.join("detached.pid"));
        let start = Instant::now();
        if drop_engine {
            app.drop_engine();
        } else {
            assert_eq!(app.shown("done"), "done ready 0");
        }
        assert!(start.elapsed() < Duration::from_secs(2));
        // The detached fixture left the group: the test reaps it.
        // SAFETY: the pid the fixture wrote, in a session of its own.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
            libc::kill(pid as i32, libc::SIGKILL);
        }
        assert_stopped(pid);
    }
}

#[test]
fn lines_and_a_minimal_child_environment() {
    let app = App::start(
        r#"const output = [];
const child = process.spawn("/bin/sh", ["-c", "printf 'a\\r\\nb\\nlast'; printf err >&2"], { lines: true });
child.on("stdout", (line) => output.push(["out", line]));
child.on("stderr", (line) => output.push(["err", line]));
let denied = false;
try { child.write("x"); } catch (e) { denied = e instanceof TypeError; }
child.on("exit", async () => {
  const env = await process.run("/usr/bin/env");
  report(JSON.stringify([denied, output, env.code, env.stdout]));
});"#,
        shell(),
    );
    let result: serde_json::Value =
        serde_json::from_str(app.shown("done").trim_start_matches("done ")).unwrap();
    assert_eq!(result[0], true);
    let output = result[1].as_array().unwrap();
    for line in [["out", "a"], ["out", "b"], ["out", "last"], ["err", "err"]] {
        assert!(output.contains(&serde_json::json!(line)), "{output:?}");
    }
    assert_eq!(result[2], 0);
    let names = result[3]
        .as_str()
        .unwrap()
        .lines()
        .filter_map(|line| line.split_once('=').map(|(name, _)| name.to_owned()))
        .collect::<Vec<_>>();
    assert!(names.iter().any(|name| name == "PATH"), "{names:?}");
    for name in &names {
        assert!(
            ["PATH", "HOME", "TMPDIR", "LANG"].contains(&name.as_str()) || name.starts_with("LC_"),
            "{name} reached the child"
        );
    }
}

#[test]
fn granted_environment_names_reach_the_child() {
    // `USER` is not one every child gets; the manifest grants it here.
    let app = App::start(
        r#"process.run("/usr/bin/env").then((r) => report(r.stdout.split("\n").find((l) => l.startsWith("USER=")) ?? "none"));"#,
        serde_json::json!({ "process": { "execute": ["/usr/bin/env"], "env": ["USER"] } }),
    );
    let expected = std::env::var("USER").map_or("none".to_owned(), |user| format!("USER={user}"));
    assert_eq!(app.shown("done"), format!("done {expected}"));
}

#[test]
fn the_cwd_is_the_data_directory_or_one_within_a_write_grant() {
    let app = App::start_with(
        r#"(async () => {
  const pwd = (await process.run("/bin/sh", ["-c", "pwd"])).stdout.trim();
  const lines = [String(pwd === process.dataDir)];
  for (const cwd of ["${pluginDir}", "${homeDir}", "${pluginDir}/escape"]) {
    try { lines.push((await process.run("/bin/sh", ["-c", "pwd"], { cwd })).stdout.trim().split("/").pop()); }
    catch (e) { lines.push(e.message.includes("not granted") ? "refused" : e.message); }
  }
  report(lines.join("|"));
})().catch((e) => report(String(e)));"#,
        serde_json::json!({
            "process": { "execute": ["/bin/sh"] },
            "fs": { "write": ["${pluginDir}"], "read": ["${homeDir}"] }
        }),
        |root| {
            for dir in ["plugin", "home", "outside"] {
                std::fs::create_dir_all(root.join(dir)).unwrap();
            }
            std::os::unix::fs::symlink(root.join("outside"), root.join("plugin/escape")).unwrap();
            let mut paths = nsh_core::access::TrustedPaths::default();
            paths.plugin_dir = Some(root.join("plugin"));
            paths.home_dir = Some(root.join("home"));
            paths
        },
    );
    assert_eq!(app.shown("done"), "done true|plugin|refused|refused");
}

#[test]
fn timeouts_signals_and_exit_errors_have_their_shapes() {
    let app = App::start(
        r#"let thrown = false;
try { process.run("/bin/sh", [], { timeoutMs: -1 }); } catch (e) { thrown = e instanceof TypeError; }
const child = process.spawn("/bin/sh", ["-c", "sleep 20"], { timeoutMs: 20 });
child.on("exit", (r) => report(`${thrown} ${r.code} ${r.signal} ${r.error}`));"#,
        shell(),
    );
    assert_eq!(
        app.shown("done"),
        "done true null SIGTERM process timed out"
    );
}

#[test]
fn capture_is_per_stream_and_an_overlong_line_ends_the_child() {
    let app = App::start(
        r#"Promise.all([
  process.run("/bin/sh", ["-c", "head -c 5242880 /dev/zero; head -c 5242880 /dev/zero >&2"]).then((r) => `${r.code} ${r.stdout.length} ${r.stderr.length}`),
  new Promise((resolve) => process.spawn("/bin/sh", ["-c", "head -c 9437184 /dev/zero"], { lines: true }).on("exit", (r) => resolve(String(r.error)))),
]).then((r) => report(r.join("|")));"#,
        shell(),
    );
    assert_eq!(
        app.shown("done"),
        "done 0 5242880 5242880|a line of output exceeded 8 MiB without a newline"
    );
}

#[test]
fn a_late_exit_listener_hears_the_exit_and_children_free_their_place() {
    let app = App::start(
        r#"(async () => {
  // 40 children one after another: each frees its place in the VM's 32.
  for (let i = 0; i < 40; i++) {
    const child = process.spawn("/bin/sh", ["-c", "exit 17"]);
    await new Promise((resolve) => child.on("exit", resolve));
    let late;
    child.on("exit", (r) => { late = r.code; });
    if (late !== 17) throw Error(`late exit listener heard ${late}`);
  }
  report("ok");
})().catch((e) => report(String(e)));"#,
        shell(),
    );
    assert_eq!(app.shown("done"), "done ok");
}

#[test]
fn past_the_children_limit_spawn_throws_and_run_rejects_a_range_error() {
    let app = App::start(
        r#"(async () => {
  const children = [];
  for (let i = 0; i < 32; i++) children.push(process.spawn("/bin/sh", ["-c", "sleep 5"]));
  let thrown = "";
  try { process.spawn("/bin/sh", ["-c", "exit 0"]); } catch (e) { thrown = e.constructor.name; }
  const rejected = await process.run("/bin/sh", ["-c", "exit 0"]).then(() => "ran", (e) => e.constructor.name);
  for (const child of children) child.kill();
  report(`${thrown} ${rejected}`);
})().catch((e) => report(String(e)));"#,
        shell(),
    );
    assert_eq!(app.shown("done"), "done RangeError RangeError");
}

#[test]
fn a_child_runs_under_the_name_it_was_given() {
    // `/bin/sh` is often a link: the link's name, not its target's, is
    // the child's `argv[0]`.
    let app = App::start(
        r#"process.run("/bin/sh", ["-c", "tr '\\0' '\\n' < /proc/$$/cmdline | head -n 1"])
  .then((r) => report(r.stdout.trim()), (e) => report(String(e)));"#,
        shell(),
    );
    assert_eq!(app.shown("done"), "done /bin/sh");
}
