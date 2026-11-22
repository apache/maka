//! A request to exit made before the run starts. Its own test binary: the request is a
//! process-wide flag, which tests running beside it in one process would also set and clear.

use clap::Parser;
use nsh_platform_tui::AppOptions;
use nsh_tui_host::{Args, main_with_args, request_exit};

#[test]
fn a_request_before_the_run_ends_it_cleanly_without_touching_the_terminal() {
    let log = std::env::temp_dir().join(format!("nsh-exit-before-run-{}.log", std::process::id()));
    let args = Args::try_parse_from(["nsh-tui-host", "--log-file", log.to_str().unwrap()]).unwrap();
    request_exit();
    let result = main_with_args(AppOptions::default(), args);
    let _ = std::fs::remove_file(&log);
    assert!(result.is_ok(), "the run ends with Ok, not {result:?}");
}
