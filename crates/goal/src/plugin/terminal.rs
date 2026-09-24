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

use super::{ID, remote::Service};
use crate::{
    goal::{Arm, Goal, Status},
    owner::Owner,
};
use futures_util::future::BoxFuture;
use maka_plugins::{
    authorization::{Capability, Request as Authorization, Target},
    contributions::Staged,
    remote::{Caller, Endpoint, Error, Handler, Method, key},
    terminal_ui::{
        Context, Descriptor, Text,
        page::{Action, Field, Page},
        view::{Control, Reply, Request},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use uuid::Uuid;

fn title() -> Text {
    Text::localized("Goal", "目标", "目標")
}
fn label(en: &str, zh_cn: &str, zh_tw: &str) -> Text {
    Text::localized(en, zh_cn, zh_tw)
}
fn invalid(message: impl ToString) -> Error {
    Error::Invalid(message.to_string())
}

pub(super) fn publish(owner: Arc<Owner>, staged: &mut Staged) -> Result<(), String> {
    let endpoint = Endpoint::standalone(Handler::Method(Arc::new(View(owner))))
        .with_terminal_view(Descriptor::new(title(), Context::Session))
        .map_err(|error| error.to_string())?;
    staged
        .insert(
            key(ID, "terminal").map_err(|error| error.to_string())?,
            endpoint,
        )
        .map_err(|error| error.to_string())
}

struct View(Arc<Owner>);
#[derive(Deserialize)]
struct Current {
    revision: u64,
    goal: Goal,
}
#[derive(Deserialize)]
struct Response {
    current: Option<Current>,
}

async fn manage(owner: Arc<Owner>, caller: Caller, input: Value) -> Result<Option<Current>, Error> {
    let value = Service(owner).call(input, caller).await?;
    Ok(serde_json::from_value::<Response>(value)
        .map_err(invalid)?
        .current)
}

fn revision(value: &str) -> Result<(u64, Option<Uuid>, Uuid, bool), Error> {
    let mut parts = value.split(':');
    let sequence = parts
        .next()
        .ok_or_else(|| invalid("Invalid Goal revision"))?
        .parse()
        .map_err(invalid)?;
    let goal = match parts.next() {
        Some("none") => None,
        Some(id) => Some(Uuid::parse_str(id).map_err(invalid)?),
        None => return Err(invalid("Invalid Goal revision")),
    };
    let operation = Uuid::parse_str(
        parts
            .next()
            .ok_or_else(|| invalid("Invalid Goal revision"))?,
    )
    .map_err(invalid)?;
    let blocked = match parts.next() {
        Some("blocked") => true,
        Some("ready") => false,
        _ => return Err(invalid("Invalid Goal revision")),
    };
    if parts.next().is_some() {
        return Err(invalid("Invalid Goal revision"));
    }
    Ok((sequence, goal, operation, blocked))
}
fn text(fields: &BTreeMap<String, Value>, key: &str) -> Result<String, Error> {
    fields
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| invalid("Invalid Goal field"))
}
fn consent(session: &str, operation: Uuid) -> Reply {
    Reply::Consent {
        request: Authorization {
            operation_id: operation,
            title: "Allow this Goal to continue in this Session".into(),
            target: Target::Session {
                session_id: session.into(),
            },
            capabilities: BTreeSet::from([Capability::Executions, Capability::ReadUsage]),
        },
    }
}
fn clean(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if (ch.is_control() && ch != '\n' && ch != '\t')
                || matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                ' '
            } else {
                ch
            }
        })
        .collect()
}
fn page(current: Option<Current>) -> Page {
    let mut page = Page {
        title: title(),
        revision: format!(
            "{}:{}:{}:{}",
            current.as_ref().map_or(0, |item| item.revision),
            current
                .as_ref()
                .map_or_else(|| "none".into(), |item| item.goal.id.to_string()),
            Uuid::new_v4(),
            if current.as_ref().is_some_and(
                |item| item.goal.authority_blocked || item.goal.status == Status::Blocked
            ) {
                "blocked"
            } else {
                "ready"
            }
        ),
        body: String::new(),
        rows: vec![],
        fields: vec![],
        actions: vec![],
    };
    if let Some(item) = &current {
        let goal = &item.goal;
        page.body = format!(
            "{}\n\n{:?} · {}/{}\n{}",
            clean(&goal.arm.objective),
            goal.status,
            goal.iterations,
            goal.arm.max_iterations,
            clean(&goal.note)
        );
        if goal.pending.is_some() {
            page.body
                .push_str("\n\nCurrent iteration is unsettled. Pause stops later iterations.");
        }
        if !goal.status.terminal() {
            for (id, label, enabled) in [
                (
                    "pause",
                    label("Pause", "暂停", "暫停"),
                    goal.status != Status::Paused,
                ),
                (
                    "resume",
                    label("Start / resume", "启动／继续", "啟動／繼續"),
                    matches!(
                        goal.status,
                        Status::Armed | Status::Paused | Status::Waiting | Status::Blocked
                    ),
                ),
                ("cancel", label("Cancel Goal", "取消目标", "取消目標"), true),
                (
                    "complete",
                    label("Mark complete", "标记完成", "標記完成"),
                    goal.pending.is_none(),
                ),
            ] {
                page.actions.push(Action {
                    id: id.into(),
                    label,
                    enabled,
                    fields: vec![],
                    recovery: None,
                });
            }
        } else if matches!(goal.status, Status::Cancelled | Status::CancellationUnknown)
            && goal.pending.is_some()
        {
            page.actions.push(Action {
                id: "cancel".into(),
                label: label("Check cancellation", "核对取消状态", "核對取消狀態"),
                enabled: true,
                fields: vec![],
                recovery: None,
            });
        }
    }
    if current
        .as_ref()
        .is_none_or(|item| item.goal.status.terminal() && item.goal.pending.is_none())
    {
        page.fields = vec![
            Field {
                id: "objective".into(),
                label: label("Objective", "目标", "目標"),
                enabled: true,
                control: Control::Text {
                    value: String::new(),
                    max_bytes: 8192,
                    multiline: true,
                    placeholder: String::new(),
                },
            },
            Field {
                id: "iterations".into(),
                label: label(
                    "Maximum iterations (1–100)",
                    "最多续跑轮数（1–100）",
                    "最多續跑輪數（1–100）",
                ),
                enabled: true,
                control: Control::Text {
                    value: "10".into(),
                    max_bytes: 3,
                    multiline: false,
                    placeholder: String::new(),
                },
            },
            Field {
                id: "budget".into(),
                label: label(
                    "Additional token threshold (optional)",
                    "新增 token 阈值（可选）",
                    "新增 token 閾值（可選）",
                ),
                enabled: true,
                control: Control::Text {
                    value: String::new(),
                    max_bytes: 10,
                    multiline: false,
                    placeholder: String::new(),
                },
            },
        ];
        page.body.push_str("\n\nThe token threshold counts observed Session usage after Goal creation; it is not a per-request limit.");
        for (id, label) in [
            (
                "save",
                label("Save for later", "保存，稍后启动", "儲存，稍後啟動"),
            ),
            (
                "start",
                label("Authorize and start", "授权并启动", "授權並啟動"),
            ),
        ] {
            page.actions.push(Action { id: id.into(), label, enabled: true,
                fields: vec!["objective".into(), "iterations".into(), "budget".into()],
                recovery: Some(json!({"kind":"arm","operationId":revision(&page.revision).expect("generated revision").2})) });
        }
    }
    page
}

impl Method for View {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let owner = self.0.clone();
        Box::pin(async move {
            let request: Request = serde_json::from_value(input).map_err(invalid)?;
            request.validate().map_err(invalid)?;
            let locale = request.locale().to_owned();
            let session = caller
                .session_id
                .clone()
                .ok_or_else(|| invalid("Bind Goal to a Session"))?;
            let reply = match request {
                Request::Read { route, .. } if route.is_null() => Reply::View {
                    view: page(manage(owner, caller, json!({"kind":"read"})).await?).view(&locale),
                },
                Request::Recover { route, .. } => {
                    let operation = route
                        .get("operationId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("Invalid Goal recovery"))?;
                    let operation = Uuid::parse_str(operation).map_err(invalid)?;
                    if route.get("kind").and_then(Value::as_str) != Some("arm") {
                        return Err(invalid("Invalid Goal recovery"));
                    }
                    let current = manage(owner, caller, json!({"kind":"read"})).await?;
                    if current
                        .as_ref()
                        .is_some_and(|item| item.goal.id == operation)
                    {
                        Reply::Applied { route: Value::Null }
                    } else {
                        Reply::Unrecorded
                    }
                }
                Request::Submit {
                    route,
                    revision: basis,
                    action,
                    fields,
                    grant,
                    ..
                } if route.is_null() => {
                    let (revision, goal_id, operation, blocked) = revision(&basis)?;
                    let input = if action == "save" || action == "start" {
                        if fields.len() != 3 {
                            return Err(invalid("Invalid Goal form"));
                        }
                        let objective = text(&fields, "objective")?.trim().to_owned();
                        let max_iterations =
                            text(&fields, "iterations")?.parse().map_err(invalid)?;
                        let token_budget = match text(&fields, "budget")?.trim() {
                            "" => None,
                            value => Some(value.parse().map_err(invalid)?),
                        };
                        if objective.is_empty()
                            || !(1..=100).contains(&max_iterations)
                            || token_budget.is_some_and(|value| value == 0 || value > 1_000_000_000)
                        {
                            return Err(invalid(
                                "Enter an objective, 1–100 iterations and a valid token threshold",
                            ));
                        }
                        let Some(grant) = grant else {
                            return serde_json::to_value(consent(&session, operation))
                                .map_err(invalid);
                        };
                        let arm = Arm {
                            operation_id: operation,
                            objective,
                            grant,
                            max_iterations,
                            token_budget,
                            start: action == "start",
                        };
                        arm.validate().map_err(invalid)?;
                        json!({"kind":"arm","arm":arm})
                    } else {
                        if !fields.is_empty() {
                            return Err(invalid("Unexpected Goal fields"));
                        }
                        let action = match action.as_str() {
                            "pause" | "resume" | "cancel" | "complete" => action,
                            _ => return Err(invalid("Unknown Goal action")),
                        };
                        if matches!(action.as_str(), "resume" | "cancel")
                            && blocked
                            && grant.is_none()
                        {
                            return serde_json::to_value(consent(&session, operation))
                                .map_err(invalid);
                        }
                        if grant.is_some() && action != "resume" && action != "cancel" {
                            return Err(invalid("Unexpected Goal authorization"));
                        }
                        let id = goal_id.ok_or_else(|| invalid("No Goal"))?;
                        json!({"kind":"control","id":id,"revision":revision,"action":action,"grant":grant})
                    };
                    manage(owner, caller, input).await?;
                    Reply::Applied { route: Value::Null }
                }
                _ => return Err(invalid("Invalid Goal route")),
            };
            reply.validate().map_err(invalid)?;
            serde_json::to_value(reply).map_err(invalid)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_page_exposes_small_form_and_stable_arm_recovery_identity() {
        let page = page(None);
        page.clone().view("en").validate().unwrap();
        assert_eq!(page.fields.len(), 3);
        assert_eq!(page.actions.len(), 2);
        let (_, goal, operation, blocked) = revision(&page.revision).unwrap();
        assert!(goal.is_none());
        assert!(!blocked);
        for action in &page.actions {
            assert_eq!(
                action.recovery,
                Some(json!({"kind":"arm","operationId":operation}))
            );
        }
        assert!(matches!(
            &page.fields[0].control,
            Control::Text {
                multiline: true,
                ..
            }
        ));
    }

    #[test]
    fn active_goal_offers_controls_but_no_new_goal_form() {
        let arm = Arm {
            operation_id: Uuid::new_v4(),
            objective: "Improve tests".into(),
            grant: maka_plugins::authorization::Id(Uuid::new_v4()),
            max_iterations: 4,
            token_budget: None,
            start: true,
        };
        let goal = Goal {
            id: arm.operation_id,
            session_id: "session".into(),
            arm,
            status: Status::Active,
            iterations: 1,
            baseline: Default::default(),
            consumed: Default::default(),
            pending: None,
            last_operation_id: None,
            report: None,
            note: "working".into(),
            authority_blocked: false,
        };
        let page = page(Some(Current { revision: 7, goal }));
        page.clone().view("en").validate().unwrap();
        assert!(page.fields.is_empty());
        assert!(page.actions.iter().any(|action| action.id == "pause"));
        assert!(page.actions.iter().any(|action| action.id == "cancel"));
        assert_eq!(revision(&page.revision).unwrap().0, 7);
    }
}
