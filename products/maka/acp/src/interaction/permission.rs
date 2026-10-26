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
            let params = acp::RequestPermissionRequest::new(
                acp::SessionId::new(snapshot.session_id.as_str()),
                format!(
                    "Allow {} / {} for this session",
                    target.server_id, target.tool_name
                ),
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
}
