//! The headless runner of an app with Rust crates of its own: `nsh test`
//! cannot link the app's crates, so it builds a runner that does (`nsh-cli`
//! `rust_app.rs`), whose `main` is [`runner`], and runs the test files in
//! it. The runner bundles nothing (this crate without its feature
//! `bundle`): `nsh` builds the entries it asks for.
//!
//! `nsh` starts the runner with a [`TestRequest`] (JSON) as its one
//! argument. The runner writes [`RunnerMessage`]s on its standard error,
//! one JSON line each (other lines, a panic's, are shown as they are), and
//! the batches of `--trace` on its standard output. For each
//! [`RunnerMessage::Build`] it reads one [`Reply`] line on its standard
//! input.

use std::{
    io::{BufRead as _, Write as _},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::{Arc, Mutex},
};

use nsh_core::element::{Registry, Root};
use nsh_engine::Bundle;
use serde::{Deserialize, Serialize};

use crate::run::{Built, Entry, TestResult, TestRun, run_file};

/// The version of the [`TestRequest`], [`RunnerMessage`] and [`Reply`]
/// formats: `nsh` and the runner it built speak the same.
pub const PROTOCOL: u32 = 4;

/// What `nsh` asks of a runner: the test files to run and how.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TestRequest {
    /// [`PROTOCOL`].
    pub protocol: u32,
    /// The QuickJS build `nsh` compiles for (`nsh_js::BYTECODE_VERSION`),
    /// which must be the runner's.
    pub bytecode_version: String,
    /// The test files, in order.
    pub files: Vec<PathBuf>,
    /// Where the entries made for test files go ([`TestRun::work_dir`]).
    pub work_dir: PathBuf,
    /// Runs only the tests whose name contains this.
    pub filter: Option<String>,
    /// Prints the batches of the apps the tests open (`--trace`).
    pub trace: bool,
    /// Forwards debug lines (`nsh -v`).
    pub verbose: bool,
    /// The web page's host module ([`TestRun::page_host`]).
    pub page_host: Option<PathBuf>,
}

/// A line a runner writes on its standard error for `nsh`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "nsh_test", rename_all = "snake_case")]
pub enum RunnerMessage {
    /// A log record of the run (an app's `console.*`, `nsh::perf`).
    Log {
        /// Its level (`INFO`).
        level: String,
        /// Its target (`js`, `nsh::perf`).
        target: String,
        /// The message.
        message: String,
    },
    /// Build `entry` as `kind` says: `nsh` answers with a [`Reply`] on the
    /// runner's standard input.
    Build {
        /// The entry (an app's may be its directory).
        entry: PathBuf,
        /// What it is.
        kind: Entry,
    },
    /// A test of `file` ended.
    Result {
        /// The test file.
        file: PathBuf,
        /// How the test ended.
        result: TestResult,
    },
    /// The test file `file` could not run (it does not build, it throws as
    /// it loads).
    Failed {
        /// The test file.
        file: PathBuf,
        /// Why.
        message: String,
    },
}

impl RunnerMessage {
    /// The message as one line (no newline).
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// The message `line` holds, if it is one.
    pub fn parse(line: &str) -> Option<RunnerMessage> {
        line.starts_with('{')
            .then(|| serde_json::from_str(line).ok())
            .flatten()
    }
}

/// `nsh`'s answer to [`RunnerMessage::Build`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "built", rename_all = "snake_case")]
pub enum Reply {
    /// The bytecode `nsh` compiled for the runner, and its source map.
    Js {
        /// The bytecode's file.
        bytecode: PathBuf,
        /// The source map's file.
        source_map: Option<PathBuf>,
        /// The capabilities the app declares (JSON), which it runs under.
        #[serde(default)]
        capabilities: Option<String>,
    },
    /// The entry is the app's Rust root, which the runner makes.
    Root,
    /// It did not build.
    Failed {
        /// Why.
        message: String,
    },
}

/// Writes `message` on standard error.
fn send(message: &RunnerMessage) {
    let _ = writeln!(std::io::stderr().lock(), "{}", message.to_line());
}

/// Forwards log records to standard error as [`RunnerMessage::Log`].
struct ForwardLogger;

impl log::Log for ForwardLogger {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }

    fn log(&self, record: &log::Record<'_>) {
        send(&RunnerMessage::Log {
            level: record.level().as_str().to_owned(),
            target: record.target().to_owned(),
            message: record.args().to_string(),
        });
    }

    fn flush(&self) {}
}

/// The `main` of an app's headless runner: runs the [`TestRequest`] its
/// argument holds with `ui_sets` (the mobile UI and the app's sets) and,
/// for an app of Rust only, its `root`, reporting on standard error as the
/// module docs say.
pub fn runner(ui_sets: Vec<Registry>, root: Option<fn() -> Root>) -> ExitCode {
    let fail = |message: String| {
        send(&RunnerMessage::Failed {
            file: PathBuf::new(),
            message,
        });
        ExitCode::FAILURE
    };
    let Some(arg) = std::env::args().nth(1) else {
        return fail("the runner takes nsh's request as its argument".into());
    };
    let request: TestRequest = match serde_json::from_str(&arg) {
        Ok(request) => request,
        Err(e) => return fail(format!("not a request of this runner's nsh: {e}")),
    };
    if request.protocol != PROTOCOL {
        return fail(format!(
            "a request of protocol {}, and this runner speaks {PROTOCOL}: run the nsh it was built for",
            request.protocol
        ));
    }
    if request.bytecode_version != nsh_engine::BYTECODE_VERSION {
        return fail(format!(
            "nsh compiles for {}, and this runner's QuickJS is {}",
            request.bytecode_version,
            nsh_engine::BYTECODE_VERSION
        ));
    }
    static LOGGER: ForwardLogger = ForwardLogger;
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(if request.verbose {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    });
    // One build at a time: a request and its reply are a pair.
    let input = Mutex::new(std::io::BufReader::new(std::io::stdin()));
    let compile = move |entry: &Path, kind: Entry| -> Result<Built, String> {
        let mut input = input.lock().unwrap_or_else(|e| e.into_inner());
        send(&RunnerMessage::Build {
            entry: entry.to_owned(),
            kind,
        });
        let mut line = String::new();
        input
            .read_line(&mut line)
            .map_err(|e| format!("nsh's reply: {e}"))?;
        match serde_json::from_str(&line).map_err(|e| format!("nsh's reply: {e}"))? {
            Reply::Js {
                bytecode,
                source_map,
                capabilities,
            } => {
                let bytes = std::fs::read(&bytecode)
                    .map_err(|e| format!("read {}: {e}", bytecode.display()))?;
                let map = match source_map {
                    Some(map) => Some(
                        std::fs::read_to_string(&map)
                            .map_err(|e| format!("read {}: {e}", map.display()))?,
                    ),
                    None => None,
                };
                // SAFETY: nsh compiled it for this runner just now, for the
                // QuickJS build it links (the request's version, checked).
                let bundle = unsafe { Bundle::bytecode(bytes) }
                    .with_capabilities_json(capabilities.as_deref())?;
                Ok(Built::Js(Box::new(bundle), map))
            }
            Reply::Root => root
                .map(|root| Built::Rust(root()))
                .ok_or_else(|| "this app has no Rust root".to_owned()),
            Reply::Failed { message } => Err(message),
        }
    };
    let run = TestRun {
        ui_sets,
        compile: Arc::new(compile),
        work_dir: request.work_dir,
        filter: request.filter,
        trace: request
            .trace
            .then(|| Arc::new(Mutex::new(Box::new(std::io::stdout()) as _))),
        // On a real platform, `nsh` runs the test files itself: the apps run
        // in hosts built with the app's crates.
        host: None,
        page_host: request.page_host,
    };
    for file in &request.files {
        let mut report = |result: &TestResult| {
            send(&RunnerMessage::Result {
                file: file.clone(),
                result: result.clone(),
            });
        };
        if let Err(message) = run_file(&run, file, &mut report) {
            send(&RunnerMessage::Failed {
                file: file.clone(),
                message,
            });
        }
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::run::Failure;

    #[test]
    fn messages_and_replies_survive_their_lines() {
        for message in [
            RunnerMessage::Log {
                level: "INFO".into(),
                target: "js".into(),
                message: "line one\nline two".into(),
            },
            RunnerMessage::Build {
                entry: PathBuf::from("C:\\app\\App.tsx"),
                kind: Entry::App,
            },
            RunnerMessage::Result {
                file: PathBuf::from("/app/App.test.tsx"),
                result: TestResult {
                    name: "adds".into(),
                    elapsed: Duration::from_millis(84),
                    status: crate::TestStatus::Failed,
                    failure: Some(Failure {
                        message: "expected 1 to be 2".into(),
                        stack: Some("    at <anonymous> (App.test.tsx:3:5)".into()),
                        screen: Some(vec!["1".into()]),
                    }),
                },
            },
        ] {
            let line = message.to_line();
            assert!(!line.contains('\n'), "{line}");
            assert_eq!(RunnerMessage::parse(&line), Some(message));
        }
        assert_eq!(RunnerMessage::parse("thread 'main' panicked"), None);
        assert_eq!(RunnerMessage::parse("{\"other\": 1}"), None);
        let reply = Reply::Js {
            bytecode: "/app/.nsh/test/build/1.nshc".into(),
            source_map: None,
            capabilities: Some(r#"{"network":{"hosts":["api.test"]}}"#.into()),
        };
        let line = serde_json::to_string(&reply).unwrap();
        assert_eq!(serde_json::from_str::<Reply>(&line).unwrap(), reply);
    }
}
