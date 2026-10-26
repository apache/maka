//! `nsh test`'s runner on a test file of a small TSX app
//! (`todo/App.test.tsx`).

use std::path::Path;

use nsh_testing::{TestResult, TestRun, compiler, run_file};

fn todo() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/todo")
}

fn test_run(filter: Option<&str>) -> TestRun {
    TestRun {
        ui_sets: Vec::new(),
        compile: compiler(Vec::new()),
        work_dir: std::env::temp_dir().join(format!("nsh-testing-{}", std::process::id())),
        filter: filter.map(str::to_owned),
        trace: None,
        host: None,
        page_host: None,
    }
}

#[test]
fn a_test_file_runs_its_tests_in_order_with_what_they_set_up() {
    let mut reported = Vec::new();
    let results = run_file(
        &test_run(None),
        &todo().join("App.test.tsx"),
        &mut |r: &TestResult| reported.push(r.name.clone()),
    )
    .unwrap();
    assert_eq!(
        reported,
        [
            "adds a todo",
            "is offline without the network",
            "fails with what is on screen"
        ]
    );
    assert_eq!(results[0].failure, None, "{:?}", results[0]);
    assert_eq!(results[1].failure, None, "{:?}", results[1]);
    let failure = results[2].failure.as_ref().unwrap();
    assert_eq!(
        failure.message,
        r#"expected ["offline","Add","0 left"] to contain "Nope""#
    );
    // Where it failed, in the test file.
    let stack = failure.stack.as_deref().unwrap();
    assert!(
        stack.contains("(tests/testing/todo/App.test.tsx:30:23)"),
        "{stack}"
    );
    assert_eq!(
        failure.screen.as_deref(),
        Some(&["offline".to_owned(), "Add".into(), "0 left".into()][..])
    );
}

#[test]
fn a_filter_runs_the_tests_it_names() {
    let results = run_file(
        &test_run(Some("offline")),
        &todo().join("App.test.tsx"),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].name, "is offline without the network");
}

#[test]
fn a_file_that_throws_as_it_loads_fails() {
    let error = run_file(&test_run(None), &todo().join("Broken.test.ts"), &mut |_| {}).unwrap_err();
    assert!(error.contains("the file is broken"), "{error}");
}

#[test]
fn headless_preserves_environment_and_data_and_stops_on_process_exit() {
    use std::time::{Duration, Instant};

    use nsh_engine::{Bundle, EngineConfig, Os};
    use nsh_testing::Headless;

    let root = std::env::temp_dir().join(format!("nsh-trace-exit-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let expected = root.join("com.example.trace-exit");
    let source = format!(
        "import process from 'process'; import {{platform}} from 'nsh';\n\
         if (platform.os !== 'macos') throw new Error('trace OS was lost');\n\
         if (process.dataDir !== {}) throw new Error('trace data directory was lost: ' + process.dataDir);\n\
         process.exit(0);",
        serde_json::to_string(&expected.to_string_lossy()).unwrap(),
    );
    let bundle = Bundle::source(source)
        .with_app_id(Some("com.example.trace-exit"))
        .with_capabilities_json(Some(r#"{"process":{"exit":true}}"#))
        .unwrap();
    let mut config = EngineConfig::new(bundle);
    config.environment.os = Os::MacOs;
    config.data_dir = Some(root.clone());
    let started = Instant::now();
    let mut app = Headless::start(config).unwrap();
    let result = app.wait(Duration::from_secs(10));
    let elapsed = started.elapsed();
    let exited = app.screen().sent(&nsh_core::Command::ExitApp);
    drop(app);
    let _ = std::fs::remove_dir_all(root);
    result.unwrap();
    assert!(
        elapsed < Duration::from_secs(5),
        "headless ignored exit: {elapsed:?}"
    );
    assert!(exited, "process.exit did not reach the headless platform");
}

#[test]
fn headless_runs_play_the_platform_s_part() {
    let run = TestRun {
        ui_sets: vec![nsh_base::registry()],
        compile: compiler(vec![nsh_base::registry()]),
        ..test_run(None)
    };
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/platform");
    let results = run_file(&run, &dir.join("App.test.tsx"), &mut |_| {}).unwrap();
    let failed: Vec<_> = results.iter().filter(|r| r.failure.is_some()).collect();
    assert!(failed.is_empty(), "{failed:#?}");
    assert_eq!(results.len(), 8);
}

#[test]
fn selectors_find_one_view_and_steps_act_on_it() {
    let run = TestRun {
        ui_sets: vec![nsh_base::registry()],
        compile: compiler(vec![nsh_base::registry()]),
        ..test_run(None)
    };
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/queries");
    let results = run_file(&run, &dir.join("App.test.tsx"), &mut |_| {}).unwrap();
    let failed: Vec<_> = results.iter().filter(|r| r.failure.is_some()).collect();
    assert!(failed.is_empty(), "{failed:#?}");
    assert_eq!(results.len(), 7);
}

#[test]
fn open_sets_the_environment_and_routes_answer_requests() {
    let run = TestRun {
        ui_sets: vec![nsh_base::registry()],
        compile: compiler(vec![nsh_base::registry()]),
        ..test_run(None)
    };
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/environment");
    let results = run_file(&run, &dir.join("App.test.tsx"), &mut |_| {}).unwrap();
    let failed: Vec<_> = results.iter().filter(|r| r.failure.is_some()).collect();
    assert!(failed.is_empty(), "{failed:#?}");
    assert_eq!(results.len(), 7);
}

#[test]
fn describe_hooks_skip_only_todo_and_timeouts_behave_as_jest_s() {
    use nsh_testing::TestStatus::{Failed, Passed, Skipped, Todo};

    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/suites");
    let results = run_file(&test_run(None), &dir.join("Suites.test.ts"), &mut |_| {}).unwrap();
    let ended: Vec<_> = results
        .iter()
        .map(|r| (r.name.as_str(), r.status))
        .collect();
    assert_eq!(
        ended,
        [
            ("cart › adds", Passed),
            ("cart › again › keeps what the first test added", Passed),
            ("ran the hooks in order", Passed),
            ("is skipped", Skipped),
            ("is still to write", Todo),
            ("skipped block › is skipped too", Skipped),
            ("fails after its timeout", Failed),
            ("a failing beforeEach › fails", Failed),
            ("a failing beforeEach › still ran its afterEach", Failed),
            ("a failing beforeAll › fails", Failed),
            ("a failing beforeAll › inner › fails too", Failed),
            ("a failing afterAll › passes", Passed),
            ("a failing afterAll › afterAll", Failed),
            ("cannot declare tests", Passed),
        ],
        "{results:#?}"
    );
    let message = |name: &str| {
        let result = results.iter().find(|r| r.name == name).unwrap();
        result.failure.as_ref().unwrap().message.clone()
    };
    assert_eq!(
        message("fails after its timeout"),
        "the test did not end in 100 ms"
    );
    assert_eq!(
        message("a failing beforeEach › fails"),
        "beforeEach: no fixture"
    );
    assert_eq!(
        message("a failing beforeAll › inner › fails too"),
        "beforeAll: no server"
    );
    assert_eq!(
        message("a failing afterAll › afterAll"),
        "afterAll: left a mess"
    );

    let results = run_file(&test_run(None), &dir.join("Only.test.ts"), &mut |_| {}).unwrap();
    let ended: Vec<_> = results
        .iter()
        .map(|r| (r.name.as_str(), r.status))
        .collect();
    assert_eq!(
        ended,
        [
            ("is skipped while another is only", Skipped),
            ("runs", Passed),
            ("focused block › runs too", Passed),
            ("other block › is skipped", Skipped),
        ]
    );
}

#[test]
fn a_manual_clock_moves_as_the_test_says() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/clock");
    let results = run_file(&test_run(None), &dir.join("App.test.tsx"), &mut |_| {}).unwrap();
    let failed: Vec<_> = results.iter().filter(|r| r.failure.is_some()).collect();
    assert!(failed.is_empty(), "{failed:#?}");
    assert_eq!(results.len(), 7);
}

#[test]
fn the_page_s_host_answers_the_apps_tests_open() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/host");
    let run = |module: Option<&str>, file: &str| {
        let run = TestRun {
            page_host: module.map(|m| dir.join(m)),
            ..test_run(None)
        };
        let results = run_file(&run, &dir.join(file), &mut |_| {}).unwrap();
        let failed: Vec<_> = results.iter().filter(|r| r.failure.is_some()).collect();
        assert!(failed.is_empty(), "{file}: {failed:#?}");
        results.len()
    };
    assert_eq!(run(Some("host.js"), "Host.test.tsx"), 7);
    assert_eq!(run(None, "NoHost.test.tsx"), 1);
    assert_eq!(run(Some("none.js"), "Broken.test.tsx"), 1);
}

#[test]
fn apps_run_under_the_capabilities_their_nsh_json_declares() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/capabilities");
    let results = run_file(&test_run(None), &dir.join("App.test.tsx"), &mut |_| {}).unwrap();
    let failed: Vec<_> = results.iter().filter(|r| r.failure.is_some()).collect();
    assert!(failed.is_empty(), "{failed:#?}");
    assert_eq!(results.len(), 1);
}

#[test]
fn a_test_plays_the_embedding_app() {
    let run = TestRun {
        ui_sets: vec![nsh_base::registry()],
        compile: compiler(vec![nsh_base::registry()]),
        ..test_run(None)
    };
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/embedding");
    let results = run_file(&run, &dir.join("App.test.tsx"), &mut |_| {}).unwrap();
    let failed: Vec<_> = results.iter().filter(|r| r.failure.is_some()).collect();
    assert!(failed.is_empty(), "{failed:#?}");
    assert_eq!(results.len(), 4);
}

#[test]
fn span_styles_follow_id_updates_and_reject_empty_spans() {
    let file = todo().parent().unwrap().join("queries/Spans.test.tsx");
    let results = run_file(&test_run(None), &file, &mut |_| {}).unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].failure.is_none(), "{:?}", results[0]);
}
