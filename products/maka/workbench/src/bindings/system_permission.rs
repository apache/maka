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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use maka_agent_facts::interaction::InteractionOutcome;
    fn record() -> InteractionRecord {
        serde_json::from_value(serde_json::json!({
            "sessionId":"session", "turnId":"turn", "runId":"run", "requestId":"request",
            "createdAt":1, "outcome":null,
            "request":{"kind":"system_permission","toolUseId":"tool",
                "grants":["accessibility","screen_recording"],"application":"Maka Host",
                "applicationLocation":{"fileUrl":"file:///Applications/Maka%20Host.app",
                    "stateDomain":"a".repeat(64)}}
        }))
        .unwrap()
    }

    #[test]
    fn permission_actions_reveal_the_host_bundle_instead_of_launching_it() {
        let record = record();
        let reveal = command(&record, &"a".repeat(64), "reveal_application").unwrap();
        assert_eq!(reveal.as_std().get_program(), "/usr/bin/open");
        assert_eq!(
            reveal.as_std().get_args().collect::<Vec<_>>(),
            ["-R", "/Applications/Maka Host.app"]
        );
        for (grant, pane) in [
            ("accessibility", "Privacy_Accessibility"),
            ("screen_recording", "Privacy_ScreenCapture"),
        ] {
            let command = command(&record, &"a".repeat(64), grant).unwrap();
            let arguments: Vec<_> = command.as_std().get_args().collect();
            assert_eq!(
                arguments,
                [
                    format!("x-apple.systempreferences:com.apple.preference.security?{pane}")
                        .as_str()
                ]
            );
        }
    }

    #[test]
    fn permission_actions_refuse_remote_old_settled_and_unrequested_actions() {
        let mut record = record();
        assert!(actions(&record, &"b".repeat(64)).is_empty());
        assert!(command(&record, &"b".repeat(64), "reveal_application").is_err());
        assert!(command(&record, &"a".repeat(64), "/Applications/Other.app").is_err());
        if let InteractionRequest::SystemPermission { grants, .. } = &mut record.request {
            *grants = vec![SystemPermissionGrant::Accessibility];
        }
        assert!(command(&record, &"a".repeat(64), "screen_recording").is_err());
        record.outcome = Some(InteractionOutcome::SystemPermissionGranted { committed_at: 2 });
        assert!(actions(&record, &"a".repeat(64)).is_empty());
        record.outcome = None;
        if let InteractionRequest::SystemPermission {
            application_location,
            ..
        } = &mut record.request
        {
            *application_location = None;
        }
        assert!(actions(&record, &"a".repeat(64)).is_empty());
        assert!(command(&record, &"a".repeat(64), "accessibility").is_err());
    }
}
