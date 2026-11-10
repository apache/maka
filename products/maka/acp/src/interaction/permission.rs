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

use super::{Callback, Permission, PermissionChoice, PermissionKind};
use maka_agent_facts::interaction::Decision;
use maka_agent_facts::interaction::InteractionAnswer;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use maka_agent_facts::interaction::{
    ComputerAppDecision, ComputerAppPlatform, ComputerAppRisk, GrantCapability, GrantScope,
    PermissionDecision, PermissionScope, SystemPermissionGrant,
};

pub(super) fn request(snapshot: &InteractionRecord) -> Result<Callback, crate::Error> {
    use PermissionKind::{AllowAlways, AllowOnce, RejectOnce};
    let choice = |id, name, kind| PermissionChoice { id, name, kind };
    let mut offer = Permission {
        session: snapshot.execution.session_id.clone(),
        request_id: snapshot.request_id.clone(),
        title: String::new(),
        description: None,
        tool_id: None,
        command: None,
        input: serde_json::to_value(&snapshot.request)?,
        options: Vec::new(),
    };
    match &snapshot.request {
        InteractionRequest::ServiceApproval {
            tool_use_id,
            tool_name,
            service,
            method,
            ..
        } => {
            offer.title = format!("Allow {tool_name}: {service} / {method}");
            offer.tool_id = Some(tool_use_id.clone());
            offer.options = vec![
                choice("allow_once", "Allow once", AllowOnce),
                choice("reject_once", "Reject", RejectOnce),
            ];
        }
        InteractionRequest::Permissions {
            tool_use_id,
            request,
            ..
        } => {
            snapshot.validate()?;
            offer.title = if tool_use_id.is_none() {
                format!("{} (permission for this Run)", request.reason)
            } else {
                request.reason.clone()
            };
            offer.description = Some(serde_json::to_string_pretty(request)?);
            offer.tool_id = tool_use_id.clone();
            offer.command = request
                .command
                .as_ref()
                .map(|command| (command.command.clone(), command.cwd.clone().into()));
            offer.input = serde_json::to_value(request)?;
            offer.options = vec![
                choice(
                    "allow_once",
                    if tool_use_id.is_none() {
                        "Allow for this Run"
                    } else {
                        "Allow once"
                    },
                    AllowOnce,
                ),
                choice("reject_once", "Reject", RejectOnce),
            ];
        }
        InteractionRequest::ClientCapability {
            tool_use_id,
            target,
            ..
        } => {
            offer.title = if target.capability == GrantCapability::ComputerAudio {
                "Allow computer output audio for this session".into()
            } else if let (
                GrantCapability::BrowserHistory,
                GrantScope::BrowserProfile { browser_id, .. },
            ) = (target.capability, &target.scope)
            {
                format!("Allow browsing history for browser {browser_id} for this session")
            } else if let (GrantCapability::BrowserDownload, GrantScope::BrowserOrigin { origin }) =
                (target.capability, &target.scope)
            {
                format!("Allow browser file downloads from {origin} for this session")
            } else if let (GrantCapability::BrowserUpload, GrantScope::BrowserOrigin { origin }) =
                (target.capability, &target.scope)
            {
                format!("Allow browser file uploads to {origin} for this session")
            } else {
                format!(
                    "Allow {} / {} for this session",
                    target.server_id, target.tool_name
                )
            };
            offer.tool_id = Some(tool_use_id.clone());
            offer.input = serde_json::to_value(target)?;
            offer.description = Some(serde_json::to_string_pretty(target)?);
            offer.options = vec![
                choice("allow_session", "Allow for this session", AllowAlways),
                choice("reject_once", "Reject", RejectOnce),
            ];
        }
        InteractionRequest::ComputerApp {
            tool_use_id,
            target,
            display,
            allow_always,
            ..
        } => {
            let GrantScope::ComputerApp {
                platform,
                application_id,
            } = &target.scope
            else {
                return Err(
                    "Computer application permission requires an application target".into(),
                );
            };
            let risk = match display.risk {
                Some(ComputerAppRisk::Low) => "Low",
                Some(ComputerAppRisk::High) => "High",
                None => "Unknown; risk information is unavailable for this application.",
            };
            let identity_label = match platform {
                ComputerAppPlatform::Macos => "Bundle ID",
                ComputerAppPlatform::Windows => "Executable path",
            };
            let mut description = format!(
                "Application: {}\nPath: {}\n{identity_label}: {}\nRisk: {}",
                display.name, display.app_path, application_id, risk
            );
            if let Some(warning) = &display.warning {
                description.push('\n');
                description.push_str(warning);
            }
            offer.title = format!("Allow computer access to {}", display.name);
            offer.description = Some(description);
            offer.tool_id = Some(tool_use_id.clone());
            offer.options = vec![
                choice("allow_once", "Allow once", AllowOnce),
                choice("allow_session", "Allow for this session", AllowAlways),
            ];
            if *allow_always {
                offer
                    .options
                    .push(choice("allow_always", "Always allow", AllowAlways));
            }
            offer
                .options
                .push(choice("reject_once", "Deny", RejectOnce));
        }
        InteractionRequest::SystemPermission {
            tool_use_id,
            application,
            grants,
            ..
        } => {
            let names = grants
                .iter()
                .map(|permission| match permission {
                    SystemPermissionGrant::ScreenRecording => "Screen Recording",
                    SystemPermissionGrant::Accessibility => "Accessibility",
                })
                .collect::<Vec<_>>()
                .join(" and ");
            offer.title = format!("{application} needs {names}");
            offer.description = Some(format!(
                "Grant {names} to {application} in System Settings > Privacy & Security. The tool call continues automatically once the access is granted."
            ));
            offer.tool_id = Some(tool_use_id.clone());
            offer.options = vec![choice("reject_once", "Cancel", RejectOnce)];
        }
        _ => return Err("Expected a permission interaction".into()),
    }
    Ok(Callback::Permission(offer))
}
pub(super) fn answer(
    snapshot: &InteractionRecord,
    response: Option<String>,
) -> Result<InteractionAnswer, crate::Error> {
    Ok(match &snapshot.request {
        InteractionRequest::ServiceApproval { .. } => {
            let decision = match response {
                None => Decision::Deny,
                Some(selected) => match selected.as_str() {
                    "allow_once" => Decision::Allow,
                    "reject_once" => Decision::Deny,
                    _ => {
                        return Err("Client selected an unoffered service permission option".into());
                    }
                },
            };
            InteractionAnswer::ServiceApproval { decision }
        }
        InteractionRequest::Permissions {
            tool_use_id,
            request,
            ..
        } => {
            snapshot.validate()?;
            let allow = match response {
                None => false,
                Some(selected) => match selected.as_str() {
                    "allow_once" => true,
                    "reject_once" => false,
                    _ => return Err("Client selected an unoffered permission option".into()),
                },
            };
            InteractionAnswer::Permissions {
                decision: if allow {
                    PermissionDecision::Allow {
                        permissions: request.permissions.clone(),
                        // Executor baseline approval is necessarily Run-scoped;
                        // request() discloses this in both title and option label.
                        scope: if tool_use_id.is_some() {
                            PermissionScope::Once
                        } else {
                            PermissionScope::Run
                        },
                    }
                } else {
                    PermissionDecision::Deny
                },
            }
        }
        InteractionRequest::ClientCapability { .. } => {
            let decision = match response {
                None => Decision::Deny,
                Some(selected) => match selected.as_str() {
                    "allow_session" => Decision::Allow,
                    "reject_once" => Decision::Deny,
                    _ => {
                        return Err(
                            "Client selected an unoffered capability permission option".into()
                        );
                    }
                },
            };
            InteractionAnswer::ClientCapability { decision }
        }
        InteractionRequest::ComputerApp { allow_always, .. } => {
            let decision = match response {
                None => {
                    return Ok(InteractionAnswer::ComputerAppCancel {});
                }
                Some(selected) => match selected.as_str() {
                    "allow_once" => ComputerAppDecision::Once,
                    "allow_session" => ComputerAppDecision::Session,
                    "allow_always" if *allow_always => ComputerAppDecision::Always,
                    "reject_once" => ComputerAppDecision::Deny,
                    _ => {
                        return Err(
                            "Client selected an unoffered computer application permission option"
                                .into(),
                        );
                    }
                },
            };
            InteractionAnswer::ComputerApp { decision }
        }
        InteractionRequest::SystemPermission { .. } => match response {
            None => InteractionAnswer::SystemPermissionCancel {},
            Some(selected) if selected.as_str() == "reject_once" => {
                InteractionAnswer::SystemPermissionCancel {}
            }
            Some(_) => {
                return Err("Client selected an unoffered system permission option".into());
            }
        },
        _ => return Err("Expected a permission interaction".into()),
    })
}
