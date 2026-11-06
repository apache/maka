//! AppKit integration tests run on the process main thread, never a libtest worker.
#[cfg(target_os = "macos")]
mod cases;

fn main() -> std::process::ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    #[cfg(target_os = "macos")]
    let cases: &[(&str, fn())] = &[
        (
            "native_focus_survives_updates_and_revokes_removed_and_modal_editors",
            cases::focus_admission,
        ),
        (
            "delayed_native_image_invalidates_idle_capture_without_input_or_js",
            cases::delayed_image,
        ),
    ];
    #[cfg(not(target_os = "macos"))]
    let cases: &[(&str, fn())] = &[];
    let mut filter = None;
    let mut skips = Vec::new();
    let mut arguments = args.iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--format" | "--color" | "--test-threads" => {
                arguments.next();
            }
            "--skip" => {
                if let Some(skip) = arguments.next() {
                    skips.push(skip);
                }
            }
            value if !value.starts_with('-') => filter = Some(value),
            _ => {}
        }
    }
    let selected: Vec<_> = cases
        .iter()
        .filter(|(name, _)| {
            !args.iter().any(|arg| arg == "--ignored")
                && filter.is_none_or(|filter| {
                    if args.iter().any(|arg| arg == "--exact") {
                        *name == filter
                    } else {
                        name.contains(filter)
                    }
                })
                && !skips.iter().any(|skip| name.contains(skip.as_str()))
        })
        .collect();
    if args.iter().any(|arg| arg == "--list") {
        for (name, _) in selected {
            println!("{name}: test");
        }
        return std::process::ExitCode::SUCCESS;
    }
    let mut failed = false;
    for (name, run) in selected {
        print!("test {name} ... ");
        if std::panic::catch_unwind(*run).is_ok() {
            println!("ok");
        } else {
            println!("FAILED");
            failed = true;
        }
    }
    if failed {
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}
