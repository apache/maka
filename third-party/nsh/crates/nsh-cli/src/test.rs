//! `nsh test`: runs an app's test files (`*.test.tsx`, `*.test.ts`, which
//! import `nsh/test`) headless, each on an engine of its own, and says how
//! each test ended (`nsh-testing` runs them). Given an app's entry instead,
//! it opens the app as a test would and takes the steps standard input
//! gives (`await app.press("Add")`); `--trace` prints the mount batches of
//! the apps under their steps.
//!
//! An app this command line serves runs in its process. An app with Rust
//! crates of its own runs in the headless runner built with them
//! (`rust_app.rs`, `nsh_testing::runner`), which asks this process to build
//! each entry ([`RunnerMessage::Build`]): the runner links no bundler. On a
//! real platform (`--target`) the apps run in its hosts, built with the
//! app's crates (`test_host.rs`), and the test files in this process.
//!
//! Given a directory of an app with Rust crates of its own (`nsh.json`
//! `"rust"`), the crates in it are tested first with `cargo test`, each in
//! its own directory ([`cargo_test`]): their results are shown and counted
//! with the TypeScript tests', so a Rust app without test files is tested
//! too. Their tests run on this machine: with `--target` only the test
//! files run.

use std::{
    collections::HashMap,
    io::{BufRead as _, BufReader, IsTerminal as _, Read as _, Write as _},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::Instant,
};

use anyhow::{Context as _, bail};
use nsh_bundler::BundleOptions;
use nsh_core::element::description::SetDescription;
use nsh_engine::Bundle;
use nsh_testing::{
    Built, Entry, Reply, RunnerMessage, TestRequest, TestResult, TestRun, TestStatus,
};

use crate::{
    build::BuildError,
    logger,
    rust_app::{AppCrate, RustApp},
    ui,
};

/// How long the app runs after it opened before the steps of standard
/// input: long enough for the engine's idle collection (every second at
/// most), so what the app keeps alive shows in a trace.
const IDLE_MS: u32 = 1200;

/// Runs the tests `path` names, of the app whose entry is `entry`: a test
/// file, the test files in a directory (an app's), or an app's entry with
/// the steps standard input gives.
#[allow(
    clippy::too_many_arguments,
    reason = "the flags of `nsh test`, one each"
)]
pub(crate) fn test(
    path: &Path,
    entry: &Path,
    filter: Option<String>,
    trace: bool,
    fps: bool,
    junit: Option<&Path>,
    target: Option<crate::run::Target>,
    browser: Option<&Path>,
    web_host: Option<PathBuf>,
    display: Option<usize>,
) -> anyhow::Result<()> {
    let app_dir = entry.parent().unwrap_or(Path::new(".")).to_path_buf();
    let work_dir = app_dir.join(".nsh/test");
    // The app's crates in the directory, which `cargo test` tests.
    let crates: Vec<AppCrate> = match crate::rust_app::current() {
        Some(app) if path.is_dir() => app
            .crates()
            .iter()
            .filter(|c| c.dir().starts_with(path))
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    let files = if is_test_file(path) {
        vec![path.to_owned()]
    } else if path.is_dir() {
        let mut files = Vec::new();
        find_tests(path, &mut files);
        files.sort();
        if files.is_empty() && (crates.is_empty() || target.is_some()) {
            bail!(
                "no test files in {}: tests are `*.test.tsx` / `*.test.ts` files importing nsh/test{}",
                ui::path(path),
                if crates.is_empty() {
                    ""
                } else {
                    ", and the crates' Rust tests run without --target"
                }
            );
        }
        files
    } else {
        vec![steps_file(&work_dir, path)?]
    };
    // How the files are shown: an entry's steps by the entry.
    let shown = |file: &Path| {
        if file.starts_with(&work_dir) {
            ui::path(path)
        } else {
            ui::path(file)
        }
    };
    let start = Instant::now();
    let mut tally = Tally::default();
    if browser.is_some() && target.is_none() {
        bail!("--browser goes with --target web");
    }
    if display.is_some() && target != Some(crate::run::Target::Macos) {
        bail!("--display goes with --target macos");
    }
    if web_host.is_some() && target.is_some() {
        bail!(
            "--web-host goes with headless runs: --target web takes nsh.json's web.host, the other targets have no page host"
        );
    }
    // The page's host of headless runs: `--web-host`, else nsh.json's.
    // Absolute: an app's headless runner opens it too.
    let page_host = match web_host {
        Some(module) => Some(
            dunce::canonicalize(&module)
                .with_context(|| format!("the web host module {}", ui::path(&module)))?,
        ),
        None if target.is_none() => crate::package::read_config(entry)?
            .web
            .host
            .map(|host| crate::package::web_host_module(entry, &host))
            .transpose()?,
        None => None,
    };
    if !crates.is_empty() {
        if target.is_some() {
            ui::note("the crates' Rust tests (`cargo test`) run without --target");
        } else {
            for krate in &crates {
                cargo_test(krate, filter.as_deref(), &mut tally);
            }
        }
    }
    let host = target
        .filter(|_| !files.is_empty())
        .map(|target| crate::test_host::starter(target, browser, &work_dir, fps, display))
        .transpose()?;
    // On a real platform the apps run in hosts built with the app's crates:
    // the test files run here, whatever the app is.
    match crate::rust_app::current().filter(|_| host.is_none()) {
        _ if files.is_empty() => {}
        Some(app) => {
            let request = TestRequest {
                protocol: nsh_testing::PROTOCOL,
                bytecode_version: nsh_js::BYTECODE_VERSION.to_owned(),
                files,
                work_dir: work_dir.clone(),
                filter,
                trace,
                verbose: ui::verbose(),
                page_host,
            };
            in_runner(&app, &request, &shown, &mut tally)?;
        }
        None => {
            let run = TestRun {
                ui_sets: crate::own_sets().to_vec(),
                compile: compiler(),
                work_dir: work_dir.clone(),
                filter,
                trace: trace.then(|| Arc::new(Mutex::new(Box::new(std::io::stdout()) as _))),
                host,
                page_host,
            };
            for file in &files {
                let shown = shown(file);
                let ran = nsh_testing::run_file(&run, file, &mut |result| {
                    tally.show(&shown, result);
                });
                if let Err(e) = ran {
                    tally.failed(&shown, &e);
                }
            }
        }
    }
    if let Some(report) = junit {
        std::fs::write(report, tally.junit(start.elapsed()))
            .with_context(|| format!("write {}", ui::path(report)))?;
    }
    let total = tally.passed + tally.failed + tally.skipped + tally.todo;
    let mut counts = format!("{} passed, {} failed", tally.passed, tally.failed);
    if tally.skipped > 0 {
        counts.push_str(&format!(", {} skipped", tally.skipped));
    }
    if tally.todo > 0 {
        counts.push_str(&format!(", {} todo", tally.todo));
    }
    let summary = format!(
        "{total} {}: {counts} {}",
        if total == 1 { "test" } else { "tests" },
        ui::dim(format!("({})", ui::duration(start.elapsed())))
    );
    if tally.failed > 0 {
        bail!(summary);
    }
    ui::done(summary);
    Ok(())
}

/// How the tests ended so far, by file.
#[derive(Default)]
struct Tally {
    passed: usize,
    failed: usize,
    skipped: usize,
    todo: usize,
    /// The files shown, in order, with their results, or why one could not
    /// run.
    files: Vec<(String, Vec<TestResult>, Option<String>)>,
}

impl Tally {
    /// Shows how a test of the file shown as `file` ended, and counts it.
    fn show(&mut self, file: &str, result: &TestResult) {
        show(file, result);
        self.count(file, result);
    }

    /// Counts how a test of the file shown as `file` ended, without showing
    /// it.
    fn count(&mut self, file: &str, result: &TestResult) {
        match result.status {
            TestStatus::Passed => self.passed += 1,
            TestStatus::Skipped => self.skipped += 1,
            TestStatus::Todo => self.todo += 1,
            TestStatus::Failed => self.failed += 1,
        }
        self.file(file).1.push(result.clone());
    }

    /// The test file shown as `file` could not run: it counts as a failure.
    fn failed(&mut self, file: &str, message: &str) {
        self.failed += 1;
        ui::error(format!("{file}: {message}"));
        self.file(file).2 = Some(message.to_owned());
    }

    fn file(&mut self, file: &str) -> &mut (String, Vec<TestResult>, Option<String>) {
        let at = match self.files.iter().position(|(f, ..)| f == file) {
            Some(at) => at,
            None => {
                self.files.push((file.to_owned(), Vec::new(), None));
                self.files.len() - 1
            }
        };
        &mut self.files[at]
    }

    /// The results as a JUnit XML report: a `testsuite` per file, a
    /// `testcase` per test, a file that could not run as an `error`.
    fn junit(&self, elapsed: std::time::Duration) -> String {
        use std::fmt::Write as _;
        let seconds = |d: std::time::Duration| format!("{:.3}", d.as_secs_f64());
        let mut suites = String::new();
        let (mut tests, mut failures, mut errors, mut skipped) = (0, 0, 0, 0);
        for (file, results, error) in &self.files {
            let failed = results
                .iter()
                .filter(|r| r.status == TestStatus::Failed)
                .count();
            let skips = results
                .iter()
                .filter(|r| matches!(r.status, TestStatus::Skipped | TestStatus::Todo))
                .count();
            let errs = usize::from(error.is_some());
            let time: std::time::Duration = results.iter().map(|r| r.elapsed).sum();
            tests += results.len() + errs;
            failures += failed;
            errors += errs;
            skipped += skips;
            let file = xml(file);
            let _ = writeln!(
                suites,
                "  <testsuite name=\"{file}\" tests=\"{}\" failures=\"{failed}\" errors=\"{errs}\" \
                 skipped=\"{skips}\" time=\"{}\">",
                results.len() + errs,
                seconds(time)
            );
            for result in results {
                let _ = write!(
                    suites,
                    "    <testcase classname=\"{file}\" name=\"{}\" time=\"{}\"",
                    xml(&result.name),
                    seconds(result.elapsed)
                );
                match (&result.status, &result.failure) {
                    (TestStatus::Skipped, _) => {
                        suites.push_str(">\n      <skipped/>\n    </testcase>\n")
                    }
                    (TestStatus::Todo, _) => {
                        suites.push_str(">\n      <skipped message=\"todo\"/>\n    </testcase>\n");
                    }
                    (_, Some(failure)) => {
                        let mut text = failure.message.clone();
                        if let Some(stack) = &failure.stack {
                            text.push('\n');
                            text.push_str(stack);
                        }
                        if let Some(screen) = &failure.screen {
                            let texts: Vec<String> =
                                screen.iter().map(|t| format!("{t:?}")).collect();
                            text.push_str(&format!("\non screen: {}", texts.join(", ")));
                        }
                        let message = failure.message.lines().next().unwrap_or_default();
                        let _ = write!(
                            suites,
                            ">\n      <failure message=\"{}\">{}</failure>\n    </testcase>\n",
                            xml(message),
                            xml(&text)
                        );
                    }
                    _ => suites.push_str("/>\n"),
                }
            }
            if let Some(error) = error {
                let _ = write!(
                    suites,
                    "    <testcase classname=\"{file}\" name=\"{file}\" time=\"0.000\">\n      \
                     <error message=\"{}\">{}</error>\n    </testcase>\n",
                    xml(error.lines().next().unwrap_or_default()),
                    xml(error)
                );
            }
            suites.push_str("  </testsuite>\n");
        }
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <testsuites name=\"nsh test\" tests=\"{tests}\" failures=\"{failures}\" errors=\"{errors}\" \
             skipped=\"{skipped}\" time=\"{}\">\n{suites}</testsuites>\n",
            seconds(elapsed)
        )
    }
}

/// `text` as XML text or an attribute's value: escaped, without the
/// control characters XML 1.0 refuses.
fn xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\n' => out.push_str("&#10;"),
            '\t' | '\r' => out.push(c),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

/// Runs `request` in the headless runner of the app with Rust crates
/// `app`: builds the entries it asks for, shows its results and its log.
fn in_runner(
    app: &RustApp,
    request: &TestRequest,
    shown: &dyn Fn(&Path) -> String,
    tally: &mut Tally,
) -> anyhow::Result<()> {
    let runner = app.test_runner()?;
    let mut child = Command::new(&runner)
        .arg(serde_json::to_string(request)?)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("run {}", runner.display()))?;
    let mut input = child.stdin.take().context("the runner's standard input")?;
    let stderr = child.stderr.take().context("the runner's standard error")?;
    let mut builds = 0;
    for line in BufReader::new(stderr).lines() {
        let line = line?;
        match RunnerMessage::parse(&line) {
            Some(RunnerMessage::Log {
                level,
                target,
                message,
            }) => {
                let level = level.parse().unwrap_or(log::Level::Info);
                logger::forward(level, &target, &message);
            }
            Some(RunnerMessage::Build { entry, kind }) => {
                builds += 1;
                let reply = build_for_runner(&entry, kind, &request.work_dir, builds);
                writeln!(input, "{}", serde_json::to_string(&reply)?)
                    .context("answer the runner")?;
            }
            Some(RunnerMessage::Result { file, result }) => tally.show(&shown(&file), &result),
            Some(RunnerMessage::Failed { file, message }) => {
                tally.failed(&shown(&file), &message);
            }
            None => ui::plain(line),
        }
    }
    let status = child.wait()?;
    if !status.success() {
        bail!(
            "the headless runner {} exited with {status}",
            ui::path(&runner)
        );
    }
    Ok(())
}

/// Builds `entry` for the app's runner, the `n`th build of the run: its
/// files in `work_dir`, or the app's root.
fn build_for_runner(entry: &Path, kind: Entry, work_dir: &Path, n: usize) -> Reply {
    let built = (|| -> anyhow::Result<Reply> {
        let (bytecode, map, capabilities) = match kind {
            Entry::TestFile => test_file_bytecode(entry)?,
            Entry::App => {
                let entry = crate::entry::resolve(entry)?;
                if crate::rust_app::is_root(&entry) {
                    return Ok(Reply::Root);
                }
                bytecode_of(&entry, &crate::ui_sets(), true)?
            }
        };
        let dir = work_dir.join("build");
        std::fs::create_dir_all(&dir).with_context(|| format!("{}", dir.display()))?;
        let file = dir.join(format!("{n}.nshc"));
        std::fs::write(&file, bytecode).with_context(|| format!("write {}", file.display()))?;
        let source_map = match map {
            Some(map) => {
                let path = dir.join(format!("{n}.js.map"));
                std::fs::write(&path, map).with_context(|| format!("write {}", path.display()))?;
                Some(path)
            }
            None => None,
        };
        Ok(Reply::Js {
            bytecode: file,
            source_map,
            capabilities,
        })
    })();
    built.unwrap_or_else(|e| Reply::Failed {
        message: crate::ui::with_details(&e),
    })
}

/// The entry made for a test file, bundled against the app's sets and
/// `nsh/test`, and compiled.
fn test_file_bytecode(entry: &Path) -> anyhow::Result<Compiled> {
    let mut sets = crate::ui_sets().to_vec();
    sets.extend(
        nsh_testing::test_sets()
            .iter()
            .flat_map(nsh_core::element::Registry::sets)
            .map(SetDescription::from),
    );
    bytecode_of(entry, &sets, false)
}

/// A compiled entry: its bytecode, its source map and the capabilities its
/// `nsh.json` declares (JSON), which the app runs under, as on a device.
type Compiled = (Vec<u8>, Option<String>, Option<String>);

/// `entry` bundled against `sets` and compiled to bytecode, with its
/// source map and declared capabilities; `announce`: saying so.
fn bytecode_of(entry: &Path, sets: &[SetDescription], announce: bool) -> anyhow::Result<Compiled> {
    let bundle = nsh_bundler::bundle(&BundleOptions {
        entry: entry.to_path_buf(),
        minify: false,
        split: false,
        ui_sets: sets.to_vec(),
    })
    .map_err(|e| BuildError::from(e).into_error(entry))?;
    if announce {
        ui::done(format!(
            "bundled {} {}",
            ui::path(entry),
            ui::dim(format!(
                "({} B in {:.1} ms)",
                bundle.code.len(),
                bundle.elapsed_ms
            ))
        ));
    }
    let bytecode = nsh_js::compile_bytecode_with(&bundle.code, false, sets)?;
    let capabilities = bundle.capabilities.map(|c| c.to_json().to_string());
    Ok((bytecode, bundle.source_map, capabilities))
}

/// Prints how a test of the file shown as `file` ended: a line, and for a
/// failure what was thrown, where, and what was on screen.
fn show(file: &str, result: &TestResult) {
    // `cargo test` does not time its tests: theirs show no time.
    let line = if result.elapsed.is_zero() {
        format!("{file} › {}", result.name)
    } else {
        format!(
            "{file} › {} {}",
            result.name,
            ui::dim(format!("({})", ui::duration(result.elapsed)))
        )
    };
    let failure = match (result.status, &result.failure) {
        (TestStatus::Skipped, _) => {
            ui::plain(format!("{} {line} {}", ui::dim("○"), ui::dim("skipped")));
            return;
        }
        (TestStatus::Todo, _) => {
            ui::plain(format!(
                "{} {file} › {} {}",
                ui::yellow("✎"),
                result.name,
                ui::yellow("todo")
            ));
            return;
        }
        (_, Some(failure)) => failure,
        (_, None) => {
            ui::done(line);
            return;
        }
    };
    ui::plain(format!("{} {line}", ui::red("✗")));
    for text in failure.message.lines() {
        ui::detail(format!("  {text}"));
    }
    if let Some(stack) = &failure.stack {
        // The frames in the test file: the runtime's own say nothing.
        for frame in stack.lines().filter(|l| !l.contains("(native)")) {
            ui::detail(ui::dim(format!("  {}", frame.trim_start())));
        }
    }
    // A step's error says what is on screen already.
    if let Some(screen) = failure
        .screen
        .as_ref()
        .filter(|_| !failure.message.contains("on screen: "))
    {
        let texts: Vec<String> = screen.iter().map(|t| format!("{t:?}")).collect();
        ui::detail(format!("  on screen: {}", texts.join(", ")));
    }
}

/// Tests the app's crate `krate` with `cargo test --no-fail-fast` (only the
/// tests whose name contains `filter`, if given) in its directory, and
/// shows and counts each test it ran, under the file of its test target.
/// A run that fails with no test failing (the tests do not build, a test
/// binary crashed) counts as a failure of the crate, with cargo's output.
fn cargo_test(krate: &AppCrate, filter: Option<&str>, tally: &mut Tally) {
    let step = ui::Step::start(format!("testing {}", krate.package()));
    let mut cmd = krate.cargo("test");
    cmd.arg("--no-fail-fast").env("CARGO_TERM_COLOR", "never");
    if let Some(filter) = filter {
        cmd.arg(filter);
    }
    let ran = ui::capture_all(&mut cmd, |line| {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix("Compiling ") {
            step.status(rest.split(' ').next().unwrap_or(rest));
        } else if let Some(rest) = line.strip_prefix("Running ") {
            step.status(rest.split(" (").next().unwrap_or(rest));
        }
    });
    step.finish();
    let shown = ui::path(krate.dir());
    let (status, output) = match ran {
        Ok(ran) => ran,
        Err(e) => {
            tally.failed(&shown, &format!("run cargo test: {e}"));
            return;
        }
    };
    let targets = cargo_test_results(&output, &|source| match source {
        Some(source) => ui::path(&krate.dir().join(source)),
        None => format!("{shown} (doc tests)"),
    });
    let mut any_failed = false;
    for (file, results) in &targets {
        for result in results {
            any_failed |= result.status == TestStatus::Failed;
            tally.show(file, result);
        }
    }
    if !status.success() && !any_failed {
        tally.failed(
            &shown,
            &format!("cargo test failed ({status})\n{}", output.trim_end()),
        );
    }
}

/// The tests `cargo test`'s `output` reports, by test target in order:
/// each target's name (`file` of its source, `src/lib.rs` or
/// `tests/app/main.rs`; of `None` for the doc tests) and its tests, a
/// failed one with what it printed (its panic).
fn cargo_test_results(
    output: &str,
    file: &dyn Fn(Option<&str>) -> String,
) -> Vec<(String, Vec<TestResult>)> {
    let mut targets: Vec<(String, Vec<TestResult>)> = Vec::new();
    // The failed test whose output is being read, and the output.
    let mut failure: Option<(String, Vec<&str>)> = None;
    let attach = |targets: &mut Vec<(String, Vec<TestResult>)>,
                  failure: &mut Option<(String, Vec<&str>)>| {
        let Some((name, lines)) = failure.take() else {
            return;
        };
        let Some(result) = targets
            .last_mut()
            .and_then(|(_, results)| results.iter_mut().find(|r| r.name == name))
        else {
            return;
        };
        let message = lines.join("\n").trim().to_owned();
        if let Some(failure) = &mut result.failure
            && !message.is_empty()
        {
            failure.message = message;
        }
    };
    for line in output.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("Running ") {
            attach(&mut targets, &mut failure);
            let source = rest.strip_prefix("unittests ").unwrap_or(rest);
            let source = source.split(" (").next().unwrap_or(source);
            targets.push((file(Some(source)), Vec::new()));
        } else if trimmed.starts_with("Doc-tests ") {
            attach(&mut targets, &mut failure);
            targets.push((file(None), Vec::new()));
        } else if let Some(name) = line
            .strip_prefix("---- ")
            .and_then(|l| l.strip_suffix(" stdout ----"))
        {
            attach(&mut targets, &mut failure);
            failure = Some((name.to_owned(), Vec::new()));
        } else if line == "failures:" || line.starts_with("test result: ") {
            attach(&mut targets, &mut failure);
        } else if let Some((_, lines)) = &mut failure {
            lines.push(line);
        } else if let Some((name, outcome)) = line
            .strip_prefix("test ")
            .and_then(|l| l.rsplit_once(" ... "))
            && let Some((_, results)) = targets.last_mut()
        {
            let status = match outcome {
                "ok" => TestStatus::Passed,
                "FAILED" => TestStatus::Failed,
                o if o.starts_with("ignored") => TestStatus::Skipped,
                _ => continue,
            };
            let failure = (status == TestStatus::Failed).then(|| nsh_testing::Failure {
                message: "failed".to_owned(),
                stack: None,
                screen: None,
            });
            results.push(TestResult::new(
                name,
                std::time::Duration::ZERO,
                status,
                failure,
            ));
        }
    }
    attach(&mut targets, &mut failure);
    targets.retain(|(_, results)| !results.is_empty());
    targets
}

/// The entry of the app `path` is part of: a directory's, a test file's
/// (the nearest directory up with an app), or `path` itself.
pub(crate) fn app_entry(path: &Path) -> anyhow::Result<PathBuf> {
    if path.is_dir() {
        return crate::entry::resolve(path);
    }
    if !is_test_file(path) {
        return Ok(path.to_owned());
    }
    let mut dir = path.parent();
    while let Some(d) = dir {
        if d.join("nsh.json").is_file() || crate::entry::resolve(d).is_ok() {
            return crate::entry::resolve(d);
        }
        dir = d.parent();
    }
    bail!(
        "{}: no app around it (an App.tsx or nsh.json)",
        ui::path(path)
    )
}

fn is_test_file(path: &Path) -> bool {
    path.is_file()
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(".test.tsx") || n.ends_with(".test.ts"))
}

/// Adds the test files under `dir` to `out`, outside hidden directories
/// (`.nsh`), `node_modules` and `target`.
fn find_tests(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if !name.starts_with('.') && name != "node_modules" && name != "target" {
                find_tests(&path, out);
            }
        } else if is_test_file(&path) {
            out.push(path);
        }
    }
}

/// A test file that opens the app at `entry` on the network, lets it run
/// for a while, then takes the steps standard input gives (none from a
/// terminal), with `app` the app.
fn steps_file(work_dir: &Path, entry: &Path) -> anyhow::Result<PathBuf> {
    let mut steps = String::new();
    let stdin = std::io::stdin();
    if !stdin.is_terminal() {
        stdin
            .lock()
            .read_to_string(&mut steps)
            .context("read the steps from standard input")?;
    }
    let name = entry
        .file_name()
        .map_or("app".into(), |n| n.to_string_lossy().into_owned());
    let entry_js = serde_json::to_string(&entry.to_string_lossy().replace('\\', "/"))?;
    let code = format!(
        "// Made by `nsh test {name}`: the steps of standard input.\n\
         import {{ expect, open, test }} from \"nsh/test\";\n\n\
         test(\"steps\", async () => {{\n\
         const app = await open({entry_js}, {{ network: \"live\" }});\n\
         await app.wait({IDLE_MS});\n\
         {steps}\n\
         }});\n"
    );
    std::fs::create_dir_all(work_dir).with_context(|| format!("{}", work_dir.display()))?;
    let file = work_dir.join(format!("{name}.steps.test.ts"));
    std::fs::write(&file, code).with_context(|| format!("write {}", file.display()))?;
    Ok(file)
}

/// Builds the apps tests open against the UI sets this command line
/// serves (each entry once), and the entries made for test files against
/// them and `nsh/test`, in this process.
fn compiler() -> nsh_testing::Compile {
    let built: Mutex<HashMap<PathBuf, Compiled>> = Mutex::new(HashMap::new());
    Arc::new(move |entry: &Path, kind: Entry| {
        let (bytecode, map, capabilities) = match kind {
            Entry::App => {
                let entry =
                    crate::entry::resolve(entry).map_err(|e| crate::ui::with_details(&e))?;
                let cached = built
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&entry)
                    .cloned();
                match cached {
                    Some(built) => built,
                    None => {
                        let out = bytecode_of(&entry, &crate::ui_sets(), true)
                            .map_err(|e| crate::ui::with_details(&e))?;
                        built
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(entry, out.clone());
                        out
                    }
                }
            }
            Entry::TestFile => {
                test_file_bytecode(entry).map_err(|e| crate::ui::with_details(&e))?
            }
        };
        // SAFETY: compiled just now by this runtime.
        let bundle = unsafe { Bundle::bytecode(bytecode) }
            .with_capabilities_json(capabilities.as_deref())?;
        Ok(Built::Js(Box::new(bundle), map))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_tests_are_read_by_target_with_their_failures() {
        let output = "   Compiling app v0.1.0 (/app)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.00s
     Running unittests src/lib.rs (target/debug/deps/app-0123)

running 3 tests
test tests::later ... ignored, slow
test tests::adds ... ok
test tests::fails ... FAILED

failures:

---- tests::fails stdout ----
thread 'tests::fails' panicked at src/lib.rs:9:9:
math is broken

failures:
    tests::fails

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out

     Running unittests src/main.rs (target/debug/deps/app-4567)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

     Running tests/app/main.rs (target/debug/deps/app-89ab)

running 1 test
test opens ... ok

   Doc-tests app

running 1 test
test src/lib.rs - App (line 3) ... ok
";
        let targets = cargo_test_results(output, &|source| {
            source.map_or("app (doc tests)".to_owned(), |s| format!("app/{s}"))
        });
        let names: Vec<(&str, Vec<(&str, TestStatus)>)> = targets
            .iter()
            .map(|(file, results)| {
                (
                    file.as_str(),
                    results
                        .iter()
                        .map(|r| (r.name.as_str(), r.status))
                        .collect(),
                )
            })
            .collect();
        assert_eq!(
            names,
            [
                (
                    "app/src/lib.rs",
                    vec![
                        ("tests::later", TestStatus::Skipped),
                        ("tests::adds", TestStatus::Passed),
                        ("tests::fails", TestStatus::Failed),
                    ]
                ),
                ("app/tests/app/main.rs", vec![("opens", TestStatus::Passed)]),
                (
                    "app (doc tests)",
                    vec![("src/lib.rs - App (line 3)", TestStatus::Passed)]
                ),
            ]
        );
        let failed = &targets[0].1[2];
        assert_eq!(
            failed.failure.as_ref().unwrap().message,
            "thread 'tests::fails' panicked at src/lib.rs:9:9:\nmath is broken"
        );
        assert!(targets[0].1[1].failure.is_none());
    }

    #[test]
    fn test_files_are_found_where_the_app_keeps_them_and_know_their_app() {
        let dir = std::env::temp_dir().join(format!("nsh-test-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for file in [
            "App.tsx",
            "App.test.tsx",
            "src/cart/Cart.test.ts",
            "src/cart/Cart.tsx",
            ".nsh/test/App.test.tsx.run.js",
            ".nsh/test/Old.test.ts",
            "node_modules/x/x.test.ts",
        ] {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "").unwrap();
        }
        let dir = dunce::canonicalize(&dir).unwrap();
        let mut found = Vec::new();
        find_tests(&dir, &mut found);
        found.sort();
        assert_eq!(
            found,
            [dir.join("App.test.tsx"), dir.join("src/cart/Cart.test.ts")]
        );
        // A test file's app is the nearest one up; a directory's is its own;
        // any other file is an entry.
        let entry = dir.join("App.tsx");
        assert_eq!(
            app_entry(&dir.join("src/cart/Cart.test.ts")).unwrap(),
            entry
        );
        assert_eq!(app_entry(&dir).unwrap(), entry);
        assert_eq!(
            app_entry(&dir.join("src/cart/Cart.tsx")).unwrap(),
            dir.join("src/cart/Cart.tsx")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_junit_report_has_a_suite_per_file_and_says_how_each_test_ended() {
        let result =
            |json: serde_json::Value| -> TestResult { serde_json::from_value(json).unwrap() };
        let elapsed = serde_json::json!({ "secs": 0, "nanos": 250_000_000 });
        let mut tally = Tally::default();
        tally.show(
            "App.test.tsx",
            &result(serde_json::json!({ "name": "cart › adds", "elapsed": elapsed, "status": "Passed", "failure": null })),
        );
        tally.show(
            "App.test.tsx",
            &result(serde_json::json!({
                "name": "shows <b>",
                "elapsed": elapsed,
                "status": "Failed",
                "failure": { "message": "expected \"a\" to be \"b\"\nmore", "stack": "at (App.test.tsx:3:5)", "screen": ["a"] },
            })),
        );
        tally.show(
            "App.test.tsx",
            &result(serde_json::json!({ "name": "later", "elapsed": elapsed, "status": "Skipped", "failure": null })),
        );
        tally.show(
            "App.test.tsx",
            &result(serde_json::json!({ "name": "someday", "elapsed": elapsed, "status": "Todo", "failure": null })),
        );
        tally.failed("Broken.test.ts", "the file is broken");
        assert_eq!(
            (tally.passed, tally.failed, tally.skipped, tally.todo),
            (1, 2, 1, 1)
        );
        let report = tally.junit(std::time::Duration::from_secs(2));
        assert_eq!(
            report,
            r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nsh test" tests="5" failures="1" errors="1" skipped="2" time="2.000">
  <testsuite name="App.test.tsx" tests="4" failures="1" errors="0" skipped="2" time="1.000">
    <testcase classname="App.test.tsx" name="cart › adds" time="0.250"/>
    <testcase classname="App.test.tsx" name="shows &lt;b&gt;" time="0.250">
      <failure message="expected &quot;a&quot; to be &quot;b&quot;">expected &quot;a&quot; to be &quot;b&quot;&#10;more&#10;at (App.test.tsx:3:5)&#10;on screen: &quot;a&quot;</failure>
    </testcase>
    <testcase classname="App.test.tsx" name="later" time="0.250">
      <skipped/>
    </testcase>
    <testcase classname="App.test.tsx" name="someday" time="0.250">
      <skipped message="todo"/>
    </testcase>
  </testsuite>
  <testsuite name="Broken.test.ts" tests="1" failures="0" errors="1" skipped="0" time="0.000">
    <testcase classname="Broken.test.ts" name="Broken.test.ts" time="0.000">
      <error message="the file is broken">the file is broken</error>
    </testcase>
  </testsuite>
</testsuites>
"#
        );
    }
}
