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
#[cfg(test)]
mod tests {
    use super::super::tests::{Callback, request, snapshot};
    use super::*;
    use agent_client_protocol::v2::schema as acp;
    use maka_agent_facts::durable::{
        AuthorizationObligation, ExternalTaskId, ModelAttemptId, ToolKey,
    };
    use maka_agent_facts::interaction::PermissionRequest;
    use maka_sandbox::{
        Network, grant,
        workspace::{BindingStamp, PermissionBasis},
    };
    use serde_json::json;
    fn answer(
        snapshot: &InteractionRecord,
        value: serde_json::Value,
    ) -> Result<InteractionAnswer, crate::Error> {
        let response = super::super::Response::Permission(crate::transport::v2::permission_answer(
            serde_json::from_value(value)?,
        )?);
        super::super::answer(snapshot, response)
    }

    fn permission(tool: Option<&str>) -> InteractionRecord {
        let (target, tool_use_id) = match tool {
            Some(call) => {
                let tool = ToolKey {
                    attempt: ModelAttemptId::new(),
                    call: call.into(),
                };
                let display_id = format!("{}:{}", tool.attempt, tool.call);
                (AuthorizationObligation::Tool { tool }, Some(display_id))
            }
            None => (
                AuthorizationObligation::External {
                    task: ExternalTaskId::new(),
                    operation: "00000000-0000-4000-8000-000000000002".parse().unwrap(),
                },
                None,
            ),
        };
        snapshot(InteractionRequest::Permissions {
            target,
            tool_use_id,
            basis: PermissionBasis {
                boundary_revision: 0,
                binding: BindingStamp {
                    id: "00000000-0000-4000-8000-000000000001".parse().unwrap(),
                    permission_epoch: 0,
                },
            },
            request: PermissionRequest {
                reason: "Access network".into(),
                command: None,
                permissions: grant::Permissions {
                    filesystem: vec![],
                    network: Network::Allowed,
                },
            },
        })
    }

    fn computer_app(allow_always: bool, risk: Option<ComputerAppRisk>) -> InteractionRecord {
        use maka_agent_facts::interaction::{
            ComputerAppDisplay, ComputerAppPlatform, GrantCapability, GrantTarget,
        };
        let InteractionRequest::Permissions { basis, .. } = permission(Some("tool")).request else {
            panic!("permission basis");
        };
        snapshot(InteractionRequest::ComputerApp {
            tool_use_id: "tool_application".into(),
            native_operation_id: "native_operation".into(),
            target: GrantTarget {
                provider_id: "computer".into(),
                contract_id: "desktop".into(),
                server_id: "workspace_computer".into(),
                tool_name: "cua".into(),
                capability: GrantCapability::ComputerUse,
                scope: GrantScope::ComputerApp {
                    platform: ComputerAppPlatform::Macos,
                    application_id: "org.example.Editor".into(),
                },
            },
            basis,
            display: ComputerAppDisplay {
                name: "Example Editor".into(),
                app_path: "/Volumes/Work/Example Editor.app".into(),
                risk,
                warning: Some("This application can read private documents.".into()),
            },
            allow_always,
            authority_revision: 0,
        })
    }

    #[test]
    fn computer_app_prompt_discloses_trusted_identity_risk_and_offered_lifetimes() {
        let record = computer_app(true, Some(ComputerAppRisk::High));
        let Callback::Permission(callback) =
            request(&record, &acp::ClientCapabilities::default()).unwrap()
        else {
            panic!("permission callback");
        };
        assert_eq!(callback.title, "Allow computer access to Example Editor");
        assert_eq!(
            callback.description.as_deref(),
            Some(
                "Application: Example Editor\nPath: /Volumes/Work/Example Editor.app\nBundle ID: org.example.Editor\nRisk: High\nThis application can read private documents."
            )
        );
        assert_eq!(
            serde_json::to_value(&callback.options).unwrap(),
            json!([
                {"optionId":"allow_once","name":"Allow once","kind":"allow_once"},
                {"optionId":"allow_session","name":"Allow for this session","kind":"allow_always"},
                {"optionId":"allow_always","name":"Always allow","kind":"allow_always"},
                {"optionId":"reject_once","name":"Deny","kind":"reject_once"}
            ])
        );
        let Some(acp::RequestPermissionSubject::ToolCall(subject)) = callback.subject else {
            panic!("tool subject");
        };
        let subject = serde_json::to_value(subject).unwrap();
        assert_eq!(subject["toolCall"]["toolCallId"], "tool_application");
        assert_eq!(
            subject["toolCall"]["rawInput"]["target"]["scope"],
            json!({"kind":"computer_app","platform":"macos","applicationId":"org.example.Editor"})
        );
    }

    #[test]
    fn computer_app_unknown_risk_is_explicit_and_persistence_is_never_invented() {
        let record = computer_app(false, None);
        let Callback::Permission(callback) =
            request(&record, &acp::ClientCapabilities::default()).unwrap()
        else {
            panic!("permission callback");
        };
        assert_eq!(
            callback.description.as_deref(),
            Some(
                "Application: Example Editor\nPath: /Volumes/Work/Example Editor.app\nBundle ID: org.example.Editor\nRisk: Unknown; risk information is unavailable for this application.\nThis application can read private documents."
            )
        );
        assert_eq!(
            callback
                .options
                .iter()
                .map(|option| option.option_id.to_string())
                .collect::<Vec<_>>(),
            ["allow_once", "allow_session", "reject_once"]
        );
        assert!(
            answer(
                &record,
                json!({"outcome":{"outcome":"selected","optionId":"allow_always"}})
            )
            .is_err()
        );
    }

    #[test]
    fn computer_app_answers_preserve_selected_scope_and_cancel_only_the_operation() {
        let record = computer_app(true, Some(ComputerAppRisk::Low));
        for (option, decision) in [
            ("allow_once", ComputerAppDecision::Once),
            ("allow_session", ComputerAppDecision::Session),
            ("allow_always", ComputerAppDecision::Always),
            ("reject_once", ComputerAppDecision::Deny),
        ] {
            assert_eq!(
                answer(
                    &record,
                    json!({"outcome":{"outcome":"selected","optionId":option}})
                )
                .unwrap(),
                InteractionAnswer::ComputerApp { decision }
            );
        }
        assert_eq!(
            answer(&record, json!({"outcome":{"outcome":"cancelled"}})).unwrap(),
            InteractionAnswer::ComputerAppCancel {}
        );
        for response in [
            json!({"outcome":{"outcome":"selected","optionId":"allow"}}),
            json!({"outcome":{"outcome":"_future_approval"}}),
        ] {
            assert!(answer(&record, response).is_err());
        }
    }

    fn system_permission() -> InteractionRecord {
        snapshot(InteractionRequest::SystemPermission {
            tool_use_id: "tool_system".into(),
            grants: vec![
                SystemPermissionGrant::Accessibility,
                SystemPermissionGrant::ScreenRecording,
            ],
            application: "Maka Host".into(),
            application_location: None,
        })
    }

    #[test]
    fn system_permission_prompt_names_grants_and_offers_only_cancel() {
        let record = system_permission();
        let Callback::Permission(callback) =
            request(&record, &acp::ClientCapabilities::default()).unwrap()
        else {
            panic!("permission callback");
        };
        assert_eq!(
            callback.title,
            "Maka Host needs Accessibility and Screen Recording"
        );
        assert_eq!(
            callback.description.as_deref(),
            Some(
                "Grant Accessibility and Screen Recording to Maka Host in System Settings > Privacy & Security. The tool call continues automatically once the access is granted."
            )
        );
        assert_eq!(
            serde_json::to_value(&callback.options).unwrap(),
            json!([{"optionId":"reject_once","name":"Cancel","kind":"reject_once"}])
        );
        let Some(acp::RequestPermissionSubject::ToolCall(subject)) = callback.subject else {
            panic!("tool subject");
        };
        let subject = serde_json::to_value(subject).unwrap();
        assert_eq!(subject["toolCall"]["toolCallId"], "tool_system");
        assert_eq!(
            subject["toolCall"]["rawInput"]["grants"],
            json!(["accessibility", "screen_recording"])
        );
    }

    #[test]
    fn system_permission_answers_can_only_cancel() {
        let record = system_permission();
        for response in [
            json!({"outcome":{"outcome":"cancelled"}}),
            json!({"outcome":{"outcome":"selected","optionId":"reject_once"}}),
        ] {
            assert_eq!(
                answer(&record, response).unwrap(),
                InteractionAnswer::SystemPermissionCancel {}
            );
        }
        for response in [
            json!({"outcome":{"outcome":"selected","optionId":"allow_once"}}),
            json!({"outcome":{"outcome":"_future_approval"}}),
        ] {
            assert!(answer(&record, response).is_err());
        }
    }

    #[test]
    fn computer_output_audio_is_named_and_remains_a_session_capability() {
        let InteractionRequest::ComputerApp {
            mut target, basis, ..
        } = computer_app(false, None).request
        else {
            panic!("application target");
        };
        target.capability = GrantCapability::ComputerAudio;
        target.scope = GrantScope::Capability {};
        let record = snapshot(InteractionRequest::ClientCapability {
            tool_use_id: "tool_audio".into(),
            target,
            basis: Some(basis),
        });
        let Callback::Permission(callback) =
            request(&record, &acp::ClientCapabilities::default()).unwrap()
        else {
            panic!("permission callback");
        };
        assert_eq!(
            callback.title,
            "Allow computer output audio for this session"
        );
        assert_eq!(
            callback
                .options
                .iter()
                .map(|option| option.option_id.to_string())
                .collect::<Vec<_>>(),
            ["allow_session", "reject_once"]
        );
        assert_eq!(
            answer(
                &record,
                json!({"outcome":{"outcome":"selected","optionId":"allow_session"}})
            )
            .unwrap(),
            InteractionAnswer::ClientCapability {
                decision: Decision::Allow
            }
        );
        assert!(
            answer(
                &record,
                json!({"outcome":{"outcome":"selected","optionId":"allow_always"}})
            )
            .is_err()
        );
    }

    #[test]
    fn permission_rejects_an_elicitation_response() {
        let response = super::super::Response::Elicitation(super::super::FormAnswer::Cancel);
        assert!(super::super::answer(&permission(Some("tool")), response).is_err());
    }

    #[test]
    fn permission_denial_and_cancellation_never_approve() {
        let snapshot = permission(Some("tool"));
        for response in [
            json!({"outcome":{"outcome":"cancelled"}}),
            json!({"outcome":{"outcome":"selected","optionId":"reject_once"}}),
        ] {
            assert_eq!(
                answer(&snapshot, response).unwrap(),
                InteractionAnswer::Permissions {
                    decision: PermissionDecision::Deny
                }
            );
        }
        assert!(
            answer(
                &snapshot,
                json!({"outcome":{"outcome":"selected","optionId":"allow_always"}})
            )
            .is_err()
        );
        assert!(answer(&snapshot, json!({"outcome":{"outcome":"_future_approval"}})).is_err());
    }

    #[test]
    fn baseline_and_tool_approval_preserve_exact_permissions_and_disclose_scope() {
        for tool in [None, Some("tool")] {
            let snapshot = permission(tool);
            let callback =
                super::super::tests::request(&snapshot, &acp::ClientCapabilities::default())
                    .unwrap();
            let Callback::Permission(typed) = callback else {
                panic!("Expected permission callback")
            };
            if tool.is_none() {
                assert_eq!(typed.options[0].name, "Allow for this Run");
                assert!(typed.subject.is_none());
                assert!(
                    answer(
                        &snapshot,
                        json!({"outcome":{"outcome":"selected","optionId":"allow_once"}})
                    )
                    .unwrap_err()
                    .to_string()
                    .contains(
                        "Permission display identity differs from its typed obligation or basis"
                    )
                );
                continue;
            } else {
                assert!(matches!(
                    typed.subject,
                    Some(acp::RequestPermissionSubject::ToolCall(_))
                ));
            }
            let InteractionRequest::Permissions { request, .. } = &snapshot.request else {
                panic!()
            };
            assert_eq!(
                answer(
                    &snapshot,
                    json!({"outcome":{"outcome":"selected","optionId":"allow_once"}})
                )
                .unwrap(),
                InteractionAnswer::Permissions {
                    decision: PermissionDecision::Allow {
                        permissions: request.permissions.clone(),
                        scope: PermissionScope::Once
                    }
                }
            );
            let mut foreign = snapshot.clone();
            let InteractionRequest::Permissions {
                target: AuthorizationObligation::Tool { tool },
                ..
            } = &mut foreign.request
            else {
                panic!("original tool obligation");
            };
            tool.attempt = ModelAttemptId::new();
            assert!(
                answer(
                    &foreign,
                    json!({"outcome":{"outcome":"selected","optionId":"allow_once"}})
                )
                .unwrap_err()
                .to_string()
                .contains("Permission display identity differs from its typed obligation or basis")
            );
        }
    }

    #[test]
    fn command_permission_uses_v2_command_subject() {
        use maka_agent_facts::interaction::PermissionCommand;
        let InteractionRequest::Permissions {
            target,
            tool_use_id,
            basis,
            mut request,
        } = permission(Some("tool")).request
        else {
            panic!()
        };
        request.command = Some(PermissionCommand {
            command: "curl https://example.com".into(),
            cwd: "/tmp".into(),
        });
        let snapshot = snapshot(InteractionRequest::Permissions {
            target,
            tool_use_id: tool_use_id.clone(),
            basis,
            request,
        });
        let callback =
            super::super::tests::request(&snapshot, &acp::ClientCapabilities::default()).unwrap();
        let Callback::Permission(callback) = callback else {
            panic!("Expected permission callback")
        };
        let Some(acp::RequestPermissionSubject::Command(command)) = callback.subject else {
            panic!("Expected command subject")
        };
        assert_eq!(command.cwd.0, std::path::Path::new("/tmp"));
        assert_eq!(
            command.tool_call_id.unwrap().to_string(),
            tool_use_id.unwrap()
        );
    }
    #[test]
    fn service_approval_names_the_exact_call_and_never_offers_persistent_authority() {
        let record = snapshot(InteractionRequest::ServiceApproval {
            tool_use_id: "original-call".into(),
            tool_name: "Run".into(),
            service: "maka.process.Process@1".into(),
            method: "execute".into(),
            binding: "binding".into(),
            through: 42,
        });
        let Callback::Permission(callback) =
            request(&record, &acp::ClientCapabilities::default()).unwrap()
        else {
            panic!("permission callback");
        };
        let encoded = serde_json::to_value(callback).unwrap();
        assert!(encoded.to_string().contains("maka.process.Process@1"));
        assert!(encoded.to_string().contains("original-call"));
        assert_eq!(
            answer(
                &record,
                json!({"outcome":{"outcome":"selected","optionId":"allow_once"}})
            )
            .unwrap(),
            InteractionAnswer::ServiceApproval {
                decision: Decision::Allow
            }
        );
        assert!(
            answer(
                &record,
                json!({"outcome":{"outcome":"selected","optionId":"allow_session"}})
            )
            .is_err()
        );
        assert_eq!(
            answer(&record, json!({"outcome":{"outcome":"cancelled"}})).unwrap(),
            InteractionAnswer::ServiceApproval {
                decision: Decision::Deny
            }
        );
    }

    #[test]
    fn browser_file_download_request_names_the_origin_and_keeps_its_exact_scope() {
        let InteractionRequest::ComputerApp {
            mut target, basis, ..
        } = computer_app(false, None).request
        else {
            panic!("application target");
        };
        target.capability = GrantCapability::BrowserDownload;
        target.scope = GrantScope::BrowserOrigin {
            origin: "https://download.example".into(),
        };
        let record = snapshot(InteractionRequest::ClientCapability {
            tool_use_id: "download_tool".into(),
            target: target.clone(),
            basis: Some(basis),
        });
        let Callback::Permission(callback) =
            request(&record, &acp::ClientCapabilities::default()).unwrap()
        else {
            panic!("permission callback");
        };
        assert_eq!(
            callback.title,
            "Allow browser file downloads from https://download.example for this session"
        );
        assert!(
            callback
                .description
                .as_deref()
                .unwrap()
                .contains("browser_download")
        );
        assert_eq!(
            answer(
                &record,
                json!({"outcome":{"outcome":"selected","optionId":"allow_session"}})
            )
            .unwrap(),
            InteractionAnswer::ClientCapability {
                decision: Decision::Allow
            }
        );
    }
}
