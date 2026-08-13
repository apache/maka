#[cfg(not(windows))]
compile_error!("maka-windows-sandbox-spike is Windows-only");

mod protocol;
mod windows_launcher;

use std::env;
use std::fs;
use std::process::ExitCode;

use protocol::LaunchRequest;

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("maka-windows-sandbox-spike: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<u8, String> {
    let mut args = env::args_os();
    let _program = args.next();
    let first = args
        .next()
        .ok_or_else(|| "usage: maka-windows-sandbox-spike <request.json>".to_owned())?;
    if first == "--self-probe" {
        if args.next().is_some() {
            return Err("--self-probe does not accept arguments".to_owned());
        }
        return windows_launcher::self_probe();
    }
    let request_path = first;
    if args.next().is_some() {
        return Err("expected exactly one request path".to_owned());
    }

    let source = fs::read_to_string(request_path).map_err(|error| error.to_string())?;
    let request: LaunchRequest =
        serde_json::from_str(&source).map_err(|error| error.to_string())?;
    request.validate()?;
    windows_launcher::launch(&request)
}
