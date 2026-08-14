#[cfg(not(windows))]
compile_error!("maka-windows-sandbox-spike is Windows-only");

mod protocol;
#[cfg(test)]
mod protocol_tests;
mod windows_launcher;

use std::env;
use std::fs;
use std::process::ExitCode;

use protocol::{BrokerLaunchOutcome, BrokerLaunchRequest, BrokerLaunchResponse, LaunchRequest};

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
    let first = args.next().ok_or_else(|| {
        "usage: maka-windows-sandbox-spike [--atomic|--broker-validate] <request.json>".to_owned()
    })?;
    if first == "--self-probe" {
        if args.next().is_some() {
            return Err("--self-probe does not accept arguments".to_owned());
        }
        return windows_launcher::self_probe();
    }
    let (mode, request_path) = if first == "--atomic" {
        let path = args
            .next()
            .ok_or_else(|| "--atomic requires exactly one request path".to_owned())?;
        ("atomic", path)
    } else if first == "--broker-validate" {
        let path = args
            .next()
            .ok_or_else(|| "--broker-validate requires exactly one request path".to_owned())?;
        ("broker-validate", path)
    } else {
        ("legacy", first)
    };
    if args.next().is_some() {
        return Err("expected exactly one request path".to_owned());
    }

    let source = fs::read_to_string(request_path).map_err(|error| error.to_string())?;
    match mode {
        "broker-validate" => validate_broker_request(&source),
        "atomic" | "legacy" => {
            let request: LaunchRequest =
                serde_json::from_str(&source).map_err(|error| error.to_string())?;
            request.validate()?;
            if mode == "atomic" {
                windows_launcher::launch_atomic(&request)
            } else {
                windows_launcher::launch(&request)
            }
        }
        _ => unreachable!(),
    }
}

fn validate_broker_request(source: &str) -> Result<u8, String> {
    let request: BrokerLaunchRequest = serde_json::from_str(source)
        .map_err(|error| format!("broker request rejected: {error}"))?;
    let response = match request.validate() {
        Ok(()) => BrokerLaunchResponse {
            version: 1,
            request_id: request.request_id,
            outcome: BrokerLaunchOutcome::Rejected {
                code: "broker_not_connected".to_owned(),
                message: "request is valid but no broker service is connected".to_owned(),
            },
        },
        Err(error) => BrokerLaunchResponse {
            version: 1,
            request_id: request.request_id,
            outcome: BrokerLaunchOutcome::Rejected {
                code: "invalid_request".to_owned(),
                message: error,
            },
        },
    };
    println!(
        "{}",
        serde_json::to_string(&response).map_err(|error| error.to_string())?
    );
    Ok(0)
}
