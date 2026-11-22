//! Runs Native Shell's development host in the terminal.

fn main() -> std::process::ExitCode {
    match nsh_tui_host::main() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("nsh-tui-host: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
