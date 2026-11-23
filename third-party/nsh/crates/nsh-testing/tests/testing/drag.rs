use std::path::Path;

#[test]
fn held_drags_keep_the_same_touch_and_validate_the_initial_hold() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/drag/App.test.tsx");
    let results = nsh_testing::run_file(&super::test_run(None), &file, &mut |_| {}).unwrap();
    assert_eq!(results.len(), 4);
    for result in results {
        assert_eq!(
            result.failure, None,
            "{}: {:?}",
            result.name, result.failure
        );
    }
}

#[test]
fn manual_time_keeps_the_held_long_press_deadline() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/drag/Clock.test.tsx");
    let results = nsh_testing::run_file(&super::test_run(None), &file, &mut |_| {}).unwrap();
    assert_eq!(results.len(), 2);
    for result in results {
        assert_eq!(result.failure, None, "{:?}", result);
    }
}

#[test]
fn a_long_press_deadline_can_precede_a_scrolls_press_delay() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/drag/Scroll.test.tsx");
    let results = nsh_testing::run_file(&super::test_run(None), &file, &mut |_| {}).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].failure, None, "{:?}", results[0]);
}

#[test]
fn custom_holds_keep_pointer_scroll_and_selection_behavior() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testing/drag/Pointer.test.tsx");
    let run = nsh_testing::TestRun {
        ui_sets: vec![nsh_base::registry()],
        compile: nsh_testing::compiler(vec![nsh_base::registry()]),
        ..super::test_run(None)
    };
    let results = nsh_testing::run_file(&run, &file, &mut |_| {}).unwrap();
    assert_eq!(results.len(), 4);
    for result in results {
        assert_eq!(result.failure, None, "{:?}", result);
    }
}
