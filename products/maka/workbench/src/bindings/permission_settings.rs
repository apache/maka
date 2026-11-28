/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use maka_agent_api::contract::HostPermissions;
use maka_app_client::Client;
use serde_json::{Value, json};
use std::path::PathBuf;

pub(super) async fn host(client: &Client, grant: Option<&str>) -> Result<HostPermissions, String> {
    super::require_contract(
        super::AGENT,
        "hostPermissions",
        &client.describe(super::AGENT).await?.contract,
    )?;
    serde_json::from_value(
        client
            .query(super::AGENT, "hostPermissions", json!({"grant":grant}))
            .await?,
    )
    .map_err(|error| error.to_string())
}

pub(super) async fn local(client: &Client, root: &Client, snapshot: &HostPermissions) -> bool {
    local_subject(
        &snapshot.state_domain,
        &client.source().state_domain,
        &root.source().state_domain,
        client.is_local_owner().await,
    )
}
fn local_subject(subject: &str, source: &str, root: &str, owner: bool) -> bool {
    owner && subject == source && source == root
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn maka_microphone_status() -> i32;
    fn maka_request_microphone() -> bool;
    fn maka_request_accessibility();
    fn AXIsProcessTrusted() -> bool;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(any(target_os = "macos", test))]
fn microphone_state(status: i32) -> &'static str {
    match status {
        0 => "notDetermined",
        1 => "restricted",
        2 => "denied",
        3 => "granted",
        _ => "unknown",
    }
}

#[cfg(target_os = "macos")]
pub(super) fn desktop_app() -> (String, Option<PathBuf>) {
    let app = objc2_app_kit::NSRunningApplication::currentApplication();
    let path = app
        .bundleURL()
        .and_then(|url| url.path())
        .map(|p| PathBuf::from(p.to_string()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "app"));
    (
        app.localizedName()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "Maka".into()),
        path,
    )
}

#[cfg(not(target_os = "macos"))]
pub(super) fn desktop_app() -> (String, Option<PathBuf>) {
    (String::new(), None)
}

pub(super) fn desktop_grant(grant: &str) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    // SAFETY: preflight only; these functions have no arguments.
    unsafe {
        match grant {
            "accessibility" => Ok(AXIsProcessTrusted()),
            "screen_recording" => Ok(CGPreflightScreenCaptureAccess()),
            _ => Err("Unsupported permission".into()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = grant;
        Err("Requires macOS".into())
    }
}

pub(super) fn desktop() -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let (application, path) = desktop_app();
        // SAFETY: these argument-free preflight calls only observe the calling process.
        let (mic, screen, ax) = unsafe {
            (
                maka_microphone_status(),
                CGPreflightScreenCaptureAccess(),
                AXIsProcessTrusted(),
            )
        };
        Ok(
            json!({"supported":true,"application":application,"canReveal":path.is_some(),
            "microphone": microphone_state(mic), "screen_recording": screen, "accessibility": ax}),
        )
    }
    #[cfg(not(target_os = "macos"))]
    Ok(json!({"supported":false}))
}

pub(super) fn panel_url(grant: &str) -> Result<String, String> {
    let pane = match grant {
        "microphone" => "Privacy_Microphone",
        "accessibility" => "Privacy_Accessibility",
        "screen_recording" => "Privacy_ScreenCapture",
        "files" => "Privacy_FilesAndFolders",
        "disk" => "Privacy_AllFiles",
        _ => return Err("Unknown privacy panel".into()),
    };
    Ok(format!(
        "x-apple.systempreferences:com.apple.preference.security?{pane}"
    ))
}

async fn open(grant: &str) -> Result<(), String> {
    launch(vec![panel_url(grant)?]).await
}

async fn reveal(path: Option<PathBuf>) -> Result<(), String> {
    let path = path.ok_or("Application bundle unavailable")?;
    launch(vec![
        "-R".into(),
        path.into_os_string()
            .into_string()
            .map_err(|_| "Invalid application path")?,
    ])
    .await
}

async fn launch(args: Vec<String>) -> Result<(), String> {
    let status = tokio::process::Command::new("/usr/bin/open")
        .args(args)
        .status()
        .await
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open: {status}"))
    }
}

pub(super) async fn desktop_action(action: &str, grant: &str) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (action, grant);
        Err("Requires macOS".into())
    }
    #[cfg(target_os = "macos")]
    match action {
        "open" => open(grant).await,
        "reveal" => reveal(desktop_app().1).await,
        "request" => {
            let grant = grant.to_owned();
            // SAFETY: these APIs take no borrowed arguments. Authorization is requested only on explicit action.
            tokio::task::spawn_blocking(move || unsafe {
                match grant.as_str() {
                    "microphone" if !maka_request_microphone() => {
                        Err("Missing microphone usage description".into())
                    }
                    "microphone" => Ok(()),
                    "screen_recording" => {
                        CGRequestScreenCaptureAccess();
                        Ok(())
                    }
                    "accessibility" => {
                        maka_request_accessibility();
                        Ok(())
                    }
                    _ => Err("Unknown desktop grant".into()),
                }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        _ => Err("Unknown permission action".into()),
    }
}

pub(super) async fn host_action(
    client: &Client,
    snapshot: HostPermissions,
    action: &str,
    grant: &str,
) -> Result<(), String> {
    use maka_host_runtime::application::host::protocol::{Request, Response};
    if !cfg!(target_os = "macos") {
        return Err("Requires macOS".into());
    }
    if !matches!(grant, "accessibility" | "screen_recording") {
        return Err("Unknown Host grant".into());
    }
    match action {
        "open" => open(grant).await,
        "reveal" => reveal(snapshot.bundle_path.map(PathBuf::from)).await,
        "request" => {
            let grant = serde_json::from_value(json!(grant)).map_err(|e| e.to_string())?;
            match client
                .local_owner_control(Request::RequestComputerPermission { grant })
                .await?
            {
                Response::ComputerPermissionRequested(result) => result,
                _ => Err("Unexpected Host permission response".into()),
            }
        }
        _ => Err("Unknown permission action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guide_requires_local_transport_and_the_admitted_state_domain() {
        assert!(local_subject("a", "a", "a", true));
        assert!(!local_subject("a", "a", "a", false));
        assert!(!local_subject("b", "b", "a", true));
        assert!(!local_subject("a", "b", "a", true));
    }
    #[test]
    fn microphone_preserves_decisions() {
        assert_eq!(
            [0, 1, 2, 3, 99].map(microphone_state),
            [
                "notDetermined",
                "restricted",
                "denied",
                "granted",
                "unknown"
            ]
        );
    }
    #[test]
    fn file_panels_are_fixed() {
        assert_eq!(
            panel_url("files").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
        );
        assert_eq!(
            panel_url("disk").unwrap(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        );
        assert!(panel_url("file:///tmp").is_err());
    }
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn unsupported_desktop() {
        assert_eq!(desktop().unwrap(), json!({"supported":false}));
        assert!(desktop_grant("accessibility").is_err());
        assert!(desktop_app().1.is_none());
    }
}
