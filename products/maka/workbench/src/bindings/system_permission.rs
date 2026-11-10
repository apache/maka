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

use maka_agent_facts::interaction::{InteractionRecord, InteractionRequest, SystemPermissionGrant};
use maka_app_client::Client;

pub(super) async fn read(
    client: &Client,
    session: &str,
    request: &str,
) -> Result<InteractionRecord, String> {
    let value = client
        .query(
            super::AGENT,
            "interaction",
            serde_json::json!({
                "sessionId": session, "requestId": request,
            }),
        )
        .await?;
    let record: InteractionRecord =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    if record.execution.session_id != session || record.request_id != request {
        return Err("The Host returned a different permission request".into());
    }
    Ok(record)
}

pub(super) fn actions(record: &InteractionRecord, local_domain: &str) -> Vec<String> {
    if !cfg!(target_os = "macos") || record.outcome.is_some() {
        return Vec::new();
    }
    let InteractionRequest::SystemPermission {
        grants,
        application_location: Some(location),
        ..
    } = &record.request
    else {
        return Vec::new();
    };
    if location.state_domain != local_domain {
        return Vec::new();
    }
    grants
        .iter()
        .map(|grant| match grant {
            SystemPermissionGrant::Accessibility => "accessibility".into(),
            SystemPermissionGrant::ScreenRecording => "screen_recording".into(),
        })
        .chain(std::iter::once("reveal_application".into()))
        .collect()
}

fn command(
    record: &InteractionRecord,
    local_domain: &str,
    action: &str,
) -> Result<tokio::process::Command, String> {
    if !actions(record, local_domain)
        .iter()
        .any(|available| available == action)
    {
        return Err(
            "This action requires a pending permission request from this Mac's Host".into(),
        );
    }
    let mut command = tokio::process::Command::new("/usr/bin/open");
    match action {
        "accessibility" => {
            command.arg(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            );
        }
        "screen_recording" => {
            command.arg(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            );
        }
        "reveal_application" => {
            let InteractionRequest::SystemPermission {
                application_location: Some(location),
                ..
            } = &record.request
            else {
                unreachable!()
            };
            command.arg("-R").arg(
                location
                    .bundle_url()
                    .map_err(str::to_owned)?
                    .to_file_path()
                    .map_err(|_| "Invalid local permission application path".to_owned())?,
            );
        }
        _ => unreachable!(),
    }
    Ok(command)
}

pub(super) async fn perform(
    record: &InteractionRecord,
    local_domain: &str,
    action: &str,
) -> Result<(), String> {
    let status = command(record, local_domain, action)?
        .status()
        .await
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "The permission action could not be opened: {status}"
        ))
    }
}
