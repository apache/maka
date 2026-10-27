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

use super::{Callback, acp};
use maka_agent_facts::interaction::Decision;
use maka_agent_facts::interaction::InteractionAnswer;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use maka_agent_facts::interaction::{
    ComputerAppDecision, ComputerAppRisk, GrantCapability, GrantScope,
};
use maka_sandbox::grant;

pub(super) fn request(snapshot: &InteractionRecord) -> Result<Callback, crate::Error> {
    match &snapshot.request {
        InteractionRequest::ServiceApproval {
            tool_use_id,
            tool_name,
            service,
            method,
            ..
        } => Ok(Callback::Permission(
            acp::RequestPermissionRequest::new(
                acp::SessionId::new(snapshot.session_id.as_str()),
                format!("Allow {tool_name}: {service} / {method}"),
                vec![
                    acp::PermissionOption::new(
                        "allow_once",
                        "Allow once",
                        acp::PermissionOptionKind::AllowOnce,
                    ),
                    acp::PermissionOption::new(
                        "reject_once",
                        "Reject",
                        acp::PermissionOptionKind::RejectOnce,
                    ),
                ],
            )
            .subject(acp::RequestPermissionSubject::from(
                acp::ToolCallUpdate::new(tool_use_id.clone())
                    .raw_input(serde_json::to_value(&snapshot.request)?),
            )),
        )),
        InteractionRequest::Permissions {
            tool_use_id,
            request,
            ..
        } => {
            let baseline = tool_use_id.is_none();
            let title = if baseline {
                format!("{} (permission for this turn)", request.reason)
            } else {
                request.reason.clone()
            };
            let subject = if let Some(command) = &request.command {
                Some(acp::RequestPermissionSubject::from(
                    acp::CommandPermissionSubject::new(
                        command.command.clone(),
                        acp::AbsolutePath::new(command.cwd.clone()),
                    )
                    .tool_call_id(tool_use_id.as_deref().map(acp::ToolCallId::new)),
                ))
            } else if let Some(tool_use_id) = tool_use_id {
                Some(acp::RequestPermissionSubject::from(
                    acp::ToolCallUpdate::new(acp::ToolCallId::new(tool_use_id.as_str()))
                        .raw_input(serde_json::to_value(request)?),
                ))
            } else {
                None
            };
            let params = acp::RequestPermissionRequest::new(
                acp::SessionId::new(snapshot.session_id.as_str()),
                title,
                vec![
                    acp::PermissionOption::new(
                        "allow_once",
                        if baseline {
                            "Allow for this turn"
                        } else {
                            "Allow once"
                        },
                        acp::PermissionOptionKind::AllowOnce,
                    ),
                    acp::PermissionOption::new(
                        "reject_once",
                        "Reject",
                        acp::PermissionOptionKind::RejectOnce,
                    ),
                ],
            )
            .description(serde_json::to_string_pretty(request)?)
            .subject(subject);
            Ok(Callback::Permission(params))
        }
        InteractionRequest::ClientCapability {
            tool_use_id,
            target,
            ..
        } => {
            let tool_call = acp::ToolCallUpdate::new(acp::ToolCallId::new(tool_use_id.as_str()))
                .raw_input(serde_json::to_value(target)?);
            let title = if target.capability == GrantCapability::ComputerAudio {
                "Allow computer output audio for this session".to_owned()
            } else if let (GrantCapability::BrowserDownload, GrantScope::BrowserOrigin { origin }) =
                (target.capability, &target.scope)
            {
                format!("Allow browser file downloads from {origin} for this session")
            } else {
                format!(
                    "Allow {} / {} for this session",
                    target.server_id, target.tool_name
                )
            };
            let params = acp::RequestPermissionRequest::new(
                acp::SessionId::new(snapshot.session_id.as_str()),
                title,
                vec![
                    acp::PermissionOption::new(
                        "allow_session",
                        "Allow for this session",
                        acp::PermissionOptionKind::AllowAlways,
                    ),
                    acp::PermissionOption::new(
                        "reject_once",
                        "Reject",
                        acp::PermissionOptionKind::RejectOnce,
                    ),
                ],
            )
            .description(serde_json::to_string_pretty(target)?)
            .subject(acp::RequestPermissionSubject::from(tool_call));
            Ok(Callback::Permission(params))
        }
        InteractionRequest::ComputerApp {
            tool_use_id,
            target,
            display,
            allow_always,
            ..
        } => {
            let GrantScope::ComputerApp { application_id, .. } = &target.scope else {
                return Err(
                    "Computer application permission requires an application target".into(),
                );
            };
            let risk = match display.risk {
                Some(ComputerAppRisk::Low) => "Low",
                Some(ComputerAppRisk::High) => "High",
                None => "Unknown; risk information is unavailable for this application.",
            };
            let mut description = format!(
                "Application: {}\nPath: {}\nBundle ID: {}\nRisk: {}",
                display.name, display.app_path, application_id, risk
            );
            if let Some(warning) = &display.warning {
                description.push('\n');
                description.push_str(warning);
            }
            let mut options = vec![
                acp::PermissionOption::new(
                    "allow_once",
                    "Allow once",
                    acp::PermissionOptionKind::AllowOnce,
                ),
                acp::PermissionOption::new(
                    "allow_session",
                    "Allow for this session",
                    acp::PermissionOptionKind::AllowAlways,
                ),
            ];
            if *allow_always {
                options.push(acp::PermissionOption::new(
                    "allow_always",
                    "Always allow",
                    acp::PermissionOptionKind::AllowAlways,
                ));
            }
            options.push(acp::PermissionOption::new(
                "reject_once",
                "Deny",
                acp::PermissionOptionKind::RejectOnce,
            ));
            Ok(Callback::Permission(
                acp::RequestPermissionRequest::new(
                    acp::SessionId::new(snapshot.session_id.as_str()),
                    format!("Allow computer access to {}", display.name),
                    options,
                )
                .description(description)
                .subject(acp::RequestPermissionSubject::from(
                    acp::ToolCallUpdate::new(acp::ToolCallId::new(tool_use_id.as_str()))
                        .raw_input(serde_json::to_value(&snapshot.request)?),
                )),
            ))
        }
        _ => Err("Expected a permission interaction".into()),
    }
}
pub(super) fn answer(
    snapshot: &InteractionRecord,
    response: acp::RequestPermissionResponse,
) -> Result<InteractionAnswer, crate::Error> {
    Ok(match &snapshot.request {
        InteractionRequest::ServiceApproval { .. } => {
            let decision = match response.outcome {
                acp::RequestPermissionOutcome::Cancelled => Decision::Deny,
                acp::RequestPermissionOutcome::Selected(selected) => {
                    match selected.option_id.0.as_ref() {
                        "allow_once" => Decision::Allow,
                        "reject_once" => Decision::Deny,
                        _ => {
                            return Err(
                                "Client selected an unoffered service permission option".into()
                            );
                        }
                    }
                }
                _ => return Err("Unsupported ACP permission outcome".into()),
            };
            InteractionAnswer::ServiceApproval { decision }
        }
        InteractionRequest::Permissions {
            tool_use_id,
            request,
            ..
        } => {
            let allow = match response.outcome {
                acp::RequestPermissionOutcome::Cancelled => false,
                acp::RequestPermissionOutcome::Selected(selected) => {
                    match selected.option_id.0.as_ref() {
                        "allow_once" => true,
                        "reject_once" => false,
                        _ => return Err("Client selected an unoffered permission option".into()),
                    }
                }
                _ => return Err("Unsupported ACP permission outcome".into()),
            };
            InteractionAnswer::Permissions {
                decision: if allow {
                    grant::Decision::Allow {
                        permissions: request.permissions.clone(),
                        // Executor baseline approval is necessarily turn-scoped;
                        // request() discloses this in both title and option label.
                        scope: if tool_use_id.is_some() {
                            grant::Scope::Once
                        } else {
                            grant::Scope::Turn
                        },
                    }
                } else {
                    grant::Decision::Deny
                },
            }
        }
        InteractionRequest::ClientCapability { .. } => {
            let decision = match response.outcome {
                acp::RequestPermissionOutcome::Cancelled => Decision::Deny,
                acp::RequestPermissionOutcome::Selected(selected) => {
                    match selected.option_id.0.as_ref() {
                        "allow_session" => Decision::Allow,
                        "reject_once" => Decision::Deny,
                        _ => {
                            return Err(
                                "Client selected an unoffered capability permission option".into(),
                            );
                        }
                    }
                }
                _ => return Err("Unsupported ACP permission outcome".into()),
            };
            InteractionAnswer::ClientCapability { decision }
        }
        InteractionRequest::ComputerApp { allow_always, .. } => {
            let decision = match response.outcome {
                acp::RequestPermissionOutcome::Cancelled => {
                    return Ok(InteractionAnswer::ComputerAppCancel {});
                }
                acp::RequestPermissionOutcome::Selected(selected) => {
                    match selected.option_id.0.as_ref() {
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
                    }
                }
                _ => return Err("Unsupported ACP permission outcome".into()),
            };
            InteractionAnswer::ComputerApp { decision }
        }
        _ => return Err("Expected a permission interaction".into()),
    })
}
#[cfg(test)]
mod tests {
    use super::super::{request, tests::snapshot};
    use super::*;
    use maka_agent_facts::interaction::PermissionRequest;
    use maka_sandbox::Network;
    use serde_json::json;
    fn answer(
        snapshot: &InteractionRecord,
        value: serde_json::Value,
    ) -> Result<InteractionAnswer, crate::Error> {
        let response = super::super::Response::Permission(serde_json::from_value(value)?);
        super::super::answer(snapshot, response)
    }

    fn permission(tool: Option<&str>) -> InteractionRecord {
        snapshot(InteractionRequest::Permissions {
            tool_use_id: tool.map(str::to_owned),
            basis: maka_agent_facts::workspace::PermissionBasis {
                boundary_revision: 0,
                binding: maka_agent_facts::workspace::BindingStamp {
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
        let response = super::super::Response::Elicitation(
            serde_json::from_value(json!({"action":"cancel"})).unwrap(),
        );
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
                    decision: grant::Decision::Deny
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
        for (tool, scope) in [
            (None, grant::Scope::Turn),
            (Some("tool"), grant::Scope::Once),
        ] {
            let snapshot = permission(tool);
            let callback = request(&snapshot, &acp::ClientCapabilities::default()).unwrap();
            let Callback::Permission(typed) = callback else {
                panic!("Expected permission callback")
            };
            if tool.is_none() {
                assert_eq!(typed.options[0].name, "Allow for this turn");
                assert!(typed.subject.is_none());
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
                    decision: grant::Decision::Allow {
                        permissions: request.permissions.clone(),
                        scope
                    }
                }
            );
        }
    }

    #[test]
    fn command_permission_uses_v2_command_subject() {
        use maka_agent_facts::interaction::PermissionCommand;
        let InteractionRequest::Permissions {
            basis, mut request, ..
        } = permission(None).request.clone()
        else {
            panic!()
        };
        request.command = Some(PermissionCommand {
            command: "curl https://example.com".into(),
            cwd: "/tmp".into(),
        });
        let snapshot = snapshot(InteractionRequest::Permissions {
            tool_use_id: Some("tool".into()),
            basis,
            request,
        });
        let callback =
            super::super::request(&snapshot, &acp::ClientCapabilities::default()).unwrap();
        let Callback::Permission(callback) = callback else {
            panic!("Expected permission callback")
        };
        let Some(acp::RequestPermissionSubject::Command(command)) = callback.subject else {
            panic!("Expected command subject")
        };
        assert_eq!(command.cwd.0, std::path::Path::new("/tmp"));
        assert_eq!(command.tool_call_id.unwrap().to_string(), "tool");
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
