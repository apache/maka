#[cfg(not(windows))]
compile_error!("maka-windows-sandbox-spike is Windows-only");

mod broker_authorization;
#[cfg(test)]
mod broker_authorization_tests;
mod broker_client;
mod broker_framing;
#[cfg(test)]
mod broker_framing_tests;
mod broker_pipe;
mod broker_pipe_security;
#[cfg(test)]
mod broker_pipe_security_tests;
mod protocol;
#[cfg(test)]
mod protocol_tests;
mod windows_launcher;

use std::env;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::process::ExitCode;
use std::time::Duration;

use broker_authorization::BrokerAuthorizer;
use broker_framing::{decode_frame, encode_frame};
use broker_pipe::serve_once;
use protocol::{
    BrokerLaunchOutcome, BrokerLaunchRequest, BrokerLaunchResponse, LaunchRequest, launch_digest,
};

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
    if first == "--appcontainer-sid" {
        if args.next().is_some() {
            return Err("--appcontainer-sid does not accept arguments".to_owned());
        }
        println!("{}", windows_launcher::appcontainer_sid_string()?);
        return Ok(0);
    }
    if first == "--boundary-probe" {
        let denied_path = args.next().ok_or_else(|| {
            "--boundary-probe requires resource paths and loopback port".to_owned()
        })?;
        let allowed_read_path = args.next().ok_or_else(|| {
            "--boundary-probe requires resource paths and loopback port".to_owned()
        })?;
        let allowed_write_path = args.next().ok_or_else(|| {
            "--boundary-probe requires resource paths and loopback port".to_owned()
        })?;
        let port = args
            .next()
            .ok_or_else(|| "--boundary-probe requires resource paths and loopback port".to_owned())?
            .to_string_lossy()
            .parse::<u16>()
            .map_err(|error| format!("invalid boundary-probe port: {error}"))?;
        if args.next().is_some() {
            return Err("--boundary-probe accepts exactly four arguments".to_owned());
        }
        return boundary_probe(
            &denied_path.to_string_lossy(),
            &allowed_read_path.to_string_lossy(),
            &allowed_write_path.to_string_lossy(),
            port,
        );
    }
    if first == "--launch-digest" {
        let request_path = args
            .next()
            .ok_or_else(|| "--launch-digest requires a request path".to_owned())?;
        if args.next().is_some() {
            return Err("--launch-digest accepts exactly one request path".to_owned());
        }
        let source = fs::read_to_string(request_path).map_err(|error| error.to_string())?;
        let request: LaunchRequest =
            serde_json::from_str(&source).map_err(|error| error.to_string())?;
        request.validate()?;
        println!("{}", launch_digest(&request)?);
        return Ok(0);
    }
    if first == "--broker-serve-once" {
        let pipe_name = args.next().ok_or_else(|| {
            "--broker-serve-once requires pipe name, account SID, and profile digest".to_owned()
        })?;
        let account_sid = args.next().ok_or_else(|| {
            "--broker-serve-once requires pipe name, account SID, and profile digest".to_owned()
        })?;
        let profile_digest = args.next().ok_or_else(|| {
            "--broker-serve-once requires pipe name, account SID, and profile digest".to_owned()
        })?;
        if args.next().is_some() {
            return Err("--broker-serve-once accepts exactly three arguments".to_owned());
        }
        serve_once(
            &pipe_name.to_string_lossy(),
            &account_sid.to_string_lossy(),
            &profile_digest.to_string_lossy(),
        )?;
        return Ok(0);
    }
    if first == "--broker-client" {
        let pipe_name = args
            .next()
            .ok_or_else(|| "--broker-client requires pipe name and manifest path".to_owned())?;
        let manifest_path = args
            .next()
            .ok_or_else(|| "--broker-client requires pipe name and manifest path".to_owned())?;
        if args.next().is_some() {
            return Err("--broker-client accepts exactly two arguments".to_owned());
        }
        return broker_client::run(
            &pipe_name.to_string_lossy(),
            &manifest_path.to_string_lossy(),
        );
    }
    if first == "--appcontainer" {
        let request_path = args
            .next()
            .ok_or_else(|| "--appcontainer requires a request path".to_owned())?;
        if args.next().is_some() {
            return Err("--appcontainer accepts exactly one request path".to_owned());
        }
        let source = fs::read_to_string(request_path).map_err(|error| error.to_string())?;
        let request: LaunchRequest =
            serde_json::from_str(&source).map_err(|error| error.to_string())?;
        request.validate()?;
        return windows_launcher::launch_appcontainer(&request);
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

fn boundary_probe(
    denied_path: &str,
    allowed_read_path: &str,
    allowed_write_path: &str,
    port: u16,
) -> Result<u8, String> {
    let file_denied = fs::read(denied_path).is_err();
    let allowed_read =
        matches!(fs::read_to_string(allowed_read_path), Ok(value) if value == "allowed-read");
    let allowed_write = fs::write(allowed_write_path, b"allowed-write").is_ok();
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let network_denied = TcpStream::connect_timeout(&address, Duration::from_secs(2)).is_err();
    println!(
        "{{\"fileDenied\":{file_denied},\"allowedRead\":{allowed_read},\"allowedWrite\":{allowed_write},\"networkDenied\":{network_denied}}}"
    );
    if !file_denied || !allowed_read || !allowed_write || !network_denied {
        return Err("AppContainer boundary did not enforce the requested resources".to_owned());
    }
    Ok(0)
}

fn validate_broker_request(source: &str) -> Result<u8, String> {
    let request: BrokerLaunchRequest = serde_json::from_str(source)
        .map_err(|error| format!("broker request rejected: {error}"))?;
    // Contract validation has no pipe peer yet. The service path will replace
    // these claimed values with the connected process PID and approved policy.
    let mut authorizer = BrokerAuthorizer::new([request.profile_digest.clone()]);
    let connected_client_pid = request.client_pid;
    let response = match authorizer.authorize(&request, connected_client_pid) {
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
                code: error.code().to_owned(),
                message: error.message(),
            },
        },
    };
    let payload = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    let frame =
        encode_frame(&payload).map_err(|error| format!("broker frame rejected: {error:?}"))?;
    let decoded =
        decode_frame(&frame).map_err(|error| format!("broker frame rejected: {error:?}"))?;
    println!("{}", String::from_utf8_lossy(decoded));
    Ok(0)
}
