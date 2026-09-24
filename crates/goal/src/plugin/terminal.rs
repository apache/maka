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
    goal::{Arm, Goal, ReportKind, Status},
    owner::Owner,
};
use futures_util::future::BoxFuture;
use maka_plugins::{
    authorization::{Capability, Request as Authorization, Target},
    contributions::Staged,
    remote::{Caller, Endpoint, Error, Handler, Method, key},
    terminal_ui::{
        Context, Descriptor, Placement, Text,
        app::{self, App, Cx, Submission, Words},
        view::{self, Action, Confirm, Reply, Role, Tone, View, build::*},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use uuid::Uuid;

fn title() -> Text {
    Text::localized("Goal", "目标", "目標")
}
fn invalid(message: impl ToString) -> Error {
    Error::Invalid(message.to_string())
}

/// The Goal beside its session: a panel that holds the whole of it, and a
/// status line with its progress. Both follow every durable Goal write.
pub(super) fn publish(owner: Arc<Owner>, staged: &mut Staged) -> Result<(), String> {
    let describe = |placement: Placement| {
        Descriptor::new(title(), Context::Session)
            .placement(placement)
            .icon("◎", "G")
            .changes("changes")
    };
    let revisions = owner.revisions.clone();
    let endpoints = [
        (
            "terminal",
            app::endpoint(
                Goals {
                    owner: owner.clone(),
                    place: Place::Panel,
                },
                describe(Placement::Panel),
            )
            .map_err(|error| error.to_string())?,
        ),
        (
            "status",
            app::endpoint(
                Goals {
                    owner,
                    place: Place::Status,
                },
                describe(Placement::Status),
            )
            .map_err(|error| error.to_string())?,
        ),
        (
            "changes",
            Endpoint::standalone(Handler::Stream(app::changes(move |_| {
                revisions.subscribe()
            }))),
        ),
    ];
    for (method, endpoint) in endpoints {
        staged
            .insert(
                key(ID, method).map_err(|error| error.to_string())?,
                endpoint,
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Place {
    Panel,
    Status,
}
struct Goals {
    owner: Arc<Owner>,
    place: Place,
}
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

/// What a submission was offered against: the Goal's sequence, its id, a
/// fresh arming identity for retries, and whether authority was blocked.
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
fn stamp(current: Option<&Current>) -> String {
    format!(
        "{}:{}:{}:{}",
        current.map_or(0, |item| item.revision),
        current.map_or_else(|| "none".into(), |item| item.goal.id.to_string()),
        Uuid::new_v4(),
        if current.is_some_and(|item| {
            item.goal.authority_blocked || item.goal.status == Status::Blocked
        }) {
            "blocked"
        } else {
            "ready"
        }
    )
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

/// How a status reads, and in what tone.
fn status(cx: &Words, status: Status) -> (String, Tone) {
    let (en, zh_cn, zh_tw, tone) = match status {
        Status::Armed => ("Ready to start", "待启动", "待啟動", Tone::Muted),
        Status::Active => ("Working", "进行中", "進行中", Tone::Accent),
        Status::Paused => ("Paused", "已暂停", "已暫停", Tone::Warning),
        Status::Waiting => (
            "Waiting for you",
            "等待你的回复",
            "等待你的回覆",
            Tone::Warning,
        ),
        Status::Achieved => ("Achieved", "已达成", "已達成", Tone::Success),
        Status::Impossible => ("Not possible", "无法达成", "無法達成", Tone::Error),
        Status::Cancelled => ("Cancelled", "已取消", "已取消", Tone::Muted),
        Status::CancellationUnknown => (
            "Cancellation unconfirmed",
            "取消未确认",
            "取消未確認",
            Tone::Warning,
        ),
        Status::MaxIterations => (
            "Reached its iterations",
            "已达轮数上限",
            "已達輪數上限",
            Tone::Muted,
        ),
        Status::BudgetLimited => (
            "Reached its token limit",
            "已达 token 上限",
            "已達 token 上限",
            Tone::Muted,
        ),
        Status::BudgetUnknown => (
            "Token use unknown",
            "token 用量未知",
            "token 用量未知",
            Tone::Warning,
        ),
        Status::Blocked => ("Needs permission", "需要授权", "需要授權", Tone::Error),
    };
    (cx.t(en, zh_cn, zh_tw), tone)
}

/// One line: the objective, how it stands, and how far it has come.
fn line(current: Option<&Current>, cx: &Words) -> View {
    let mut children = vec![];
    if let Some(item) = current.filter(|item| !item.goal.status.terminal()) {
        let goal = &item.goal;
        let (label, tone) = status(cx, goal.status);
        children = vec![
            text("objective", clean(&goal.arm.objective, false), Tone::Normal),
            text("status", label, tone),
            text(
                "count",
                format!("{}/{}", goal.iterations, goal.arm.max_iterations),
                Tone::Muted,
            ),
        ];
    }
    View {
        version: maka_plugins::terminal_ui::VERSION,
        title: title().resolve(&cx.locale).into(),
        revision: stamp(current),
        fields: vec![],
        actions: vec![],
        root: row("root", children),
    }
}

/// The whole Goal: what it pursues, how it stands, what it said last, and
/// the decisions it allows; or a form to give the session one.
fn panel(current: Option<&Current>, cx: &Words) -> View {
    let revision = stamp(current);
    let operation = self::revision(&revision).expect("generated revision").2;
    let mut children = vec![];
    let mut actions = vec![];
    let mut fields = vec![];
    if let Some(item) = current {
        let goal = &item.goal;
        let (label, tone) = status(cx, goal.status);
        children.push(heading("objective", clean(&goal.arm.objective, true)));
        children.push(spans(
            "state",
            vec![
                ("● ".into(), tone),
                (label, tone),
                (
                    format!(
                        "  ·  {}",
                        cx.t(
                            &format!(
                                "Iteration {} of {}",
                                goal.iterations, goal.arm.max_iterations
                            ),
                            &format!(
                                "第 {} 轮，共 {} 轮",
                                goal.iterations, goal.arm.max_iterations
                            ),
                            &format!(
                                "第 {} 輪，共 {} 輪",
                                goal.iterations, goal.arm.max_iterations
                            ),
                        )
                    ),
                    Tone::Muted,
                ),
            ],
        ));
        children.push(progress(
            "iterations",
            u64::from(goal.iterations),
            u64::from(goal.arm.max_iterations),
            cx.t("Iterations", "轮数", "輪數"),
        ));
        if let Some(budget) = goal.arm.token_budget {
            let used = goal.consumed.known.saturating_sub(goal.baseline.known);
            children.push(progress(
                "tokens",
                used.min(budget),
                budget,
                cx.t("Tokens", "Token", "Token"),
            ));
        }
        if let Some(report) = &goal.report {
            let (en, zh_cn, zh_tw) = match report.status {
                ReportKind::Progress => ("Progress", "进展", "進展"),
                ReportKind::Achieved => ("Achieved", "已达成", "已達成"),
                ReportKind::Waiting => ("Waiting", "等待", "等待"),
                ReportKind::Impossible => ("Not possible", "无法达成", "無法達成"),
            };
            children.push(stack(
                "report",
                vec![
                    text("label", cx.t(en, zh_cn, zh_tw), Tone::Subtle),
                    markdown("note", clean(&report.note, true)),
                ],
            ));
        } else if !goal.note.is_empty() {
            children.push(text("note", clean(&goal.note, true), Tone::Muted));
        }
        if goal.pending.is_some() {
            children.push(text(
                "pending",
                cx.t(
                    "The current iteration is still settling. Pausing stops later ones.",
                    "当前一轮尚未结束。暂停会停止之后的轮次。",
                    "目前一輪尚未結束。暫停會停止之後的輪次。",
                ),
                Tone::Warning,
            ));
        }
        let mut buttons = vec![];
        if !goal.status.terminal() {
            let resumable = matches!(
                goal.status,
                Status::Armed | Status::Paused | Status::Waiting | Status::Blocked
            );
            let start = if goal.status == Status::Armed {
                cx.t("Start", "启动", "啟動")
            } else {
                cx.t("Resume", "继续", "繼續")
            };
            for (id, label, enabled, role) in [
                ("resume", start, resumable, Role::Primary),
                (
                    "pause",
                    cx.t("Pause", "暂停", "暫停"),
                    goal.status != Status::Paused && goal.status != Status::Armed,
                    Role::Normal,
                ),
                (
                    "complete",
                    cx.t("Mark complete", "标记完成", "標記完成"),
                    goal.pending.is_none(),
                    Role::Normal,
                ),
                (
                    "cancel",
                    cx.t("Cancel", "取消", "取消"),
                    true,
                    Role::Destructive,
                ),
            ] {
                if !enabled {
                    continue;
                }
                buttons.push(button(id, id, role));
                actions.push(Action {
                    confirm: (id == "cancel").then(|| Confirm {
                        title: cx.t("Cancel this Goal?", "取消这个目标？", "取消這個目標？"),
                        message: cx.t(
                            "No new iteration starts. Work already accepted may still finish.",
                            "不会再开始新的一轮。已接受的工作仍可能完成。",
                            "不會再開始新的一輪。已接受的工作仍可能完成。",
                        ),
                        destructive: true,
                    }),
                    ..view::build::action(id, label)
                });
            }
        } else if matches!(goal.status, Status::Cancelled | Status::CancellationUnknown)
            && goal.pending.is_some()
        {
            buttons.push(button("cancel", "cancel", Role::Normal));
            actions.push(view::build::action(
                "cancel",
                cx.t("Check cancellation", "核对取消状态", "核對取消狀態"),
            ));
        }
        if !buttons.is_empty() {
            children.push(row("controls", buttons));
        }
    }
    if current.is_none_or(|item| item.goal.status.terminal() && item.goal.pending.is_none()) {
        if current.is_some() {
            children.push(rule("divider"));
        }
        children.push(text(
            "intro",
            cx.t(
                "Give this session an objective to pursue across turns.",
                "给这个会话一个跨多轮持续推进的目标。",
                "給這個工作階段一個跨多輪持續推進的目標。",
            ),
            Tone::Muted,
        ));
        fields = vec![
            area("objective", "", 8192),
            line_field("iterations", "10", 3),
            view::Field {
                control: view::Control::Text {
                    value: String::new(),
                    max_bytes: 10,
                    multiline: false,
                    placeholder: cx.t("Optional", "可选", "可選"),
                    secret: false,
                },
                ..line_field("budget", "", 10)
            },
        ];
        children.push(stack(
            "form",
            vec![
                input("objective", "objective", cx.t("Objective", "目标", "目標")),
                input(
                    "iterations",
                    "iterations",
                    cx.t("Iterations", "轮数", "輪數"),
                ),
                input(
                    "budget",
                    "budget",
                    cx.t("Token limit", "Token 上限", "Token 上限"),
                ),
            ],
        ));
        children.push(text(
            "budget-note",
            cx.t(
                "The token limit counts this session's use after the Goal starts.",
                "Token 上限按目标开始后本会话的用量计算。",
                "Token 上限按目標開始後本工作階段的用量計算。",
            ),
            Tone::Subtle,
        ));
        let form = vec!["objective".into(), "iterations".into(), "budget".into()];
        let recovery = Some(json!({"kind":"arm","operationId":operation}));
        for (id, label) in [
            (
                "save",
                cx.t("Save for later", "保存，稍后启动", "儲存，稍後啟動"),
            ),
            ("start", cx.t("Start", "启动", "啟動")),
        ] {
            actions.push(Action {
                fields: form.clone(),
                recovery: recovery.clone(),
                ..view::build::action(id, label)
            });
        }
        children.push(row(
            "create",
            vec![
                button("save", "save", Role::Normal),
                button("start", "start", Role::Primary),
            ],
        ));
    }
    View {
        version: maka_plugins::terminal_ui::VERSION,
        title: title().resolve(&cx.locale).into(),
        revision,
        fields,
        actions,
        root: column("root", children),
    }
}

fn line_field(id: &str, value: &str, max: usize) -> view::Field {
    view::build::line(id, value, max)
}
fn clean(value: &str, multiline: bool) -> String {
    view::build::clean(value, multiline)
}

impl App for Goals {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let (owner, place) = (self.owner.clone(), self.place);
        Box::pin(async move {
            if !route.is_null() {
                return Err(invalid("Invalid Goal route"));
            }
            let current = manage(owner, cx.caller.clone(), json!({"kind":"read"})).await?;
            Ok(match place {
                Place::Panel => panel(current.as_ref(), &cx.words),
                Place::Status => line(current.as_ref(), &cx.words),
            })
        })
    }

    fn recover(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let owner = self.owner.clone();
        Box::pin(async move {
            let operation = route
                .get("operationId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("Invalid Goal recovery"))?;
            let operation = Uuid::parse_str(operation).map_err(invalid)?;
            if route.get("kind").and_then(Value::as_str) != Some("arm") {
                return Err(invalid("Invalid Goal recovery"));
            }
            let current = manage(owner, cx.caller, json!({"kind":"read"})).await?;
            Ok(
                if current
                    .as_ref()
                    .is_some_and(|item| item.goal.id == operation)
                {
                    Reply::Applied { route: Value::Null }
                } else {
                    Reply::Unrecorded
                },
            )
        })
    }

    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let owner = self.owner.clone();
        let place = self.place;
        Box::pin(async move {
            if !matches!(place, Place::Panel) || !submission.route.is_null() {
                return Err(invalid("Invalid Goal route"));
            }
            let session = cx.session()?.to_owned();
            let (revision, goal_id, operation, blocked) = revision(&submission.revision)?;
            let action = submission.action.as_str();
            let input = if action == "save" || action == "start" {
                if submission.fields.len() != 3 {
                    return Err(invalid("Invalid Goal form"));
                }
                let objective = submission.text("objective")?.trim().to_owned();
                let max_iterations = submission
                    .text("iterations")?
                    .trim()
                    .parse()
                    .map_err(invalid)?;
                let token_budget = match submission.text("budget")?.trim() {
                    "" => None,
                    value => Some(value.parse().map_err(invalid)?),
                };
                if objective.is_empty()
                    || !(1..=100).contains(&max_iterations)
                    || token_budget.is_some_and(|value| value == 0 || value > 1_000_000_000)
                {
                    return Ok(Reply::Rejected {
                        message: cx.t(
                            "Enter an objective, 1–100 iterations and a valid token limit.",
                            "请填写目标、1–100 的轮数和有效的 token 上限。",
                            "請填寫目標、1–100 的輪數和有效的 token 上限。",
                        ),
                    });
                }
                let Some(grant) = submission.grant else {
                    return Ok(consent(&session, operation));
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
                if !submission.fields.is_empty() {
                    return Err(invalid("Unexpected Goal fields"));
                }
                if !matches!(action, "pause" | "resume" | "cancel" | "complete") {
                    return Err(invalid("Unknown Goal action"));
                }
                if matches!(action, "resume" | "cancel") && blocked && submission.grant.is_none() {
                    return Ok(consent(&session, operation));
                }
                if submission.grant.is_some() && action != "resume" && action != "cancel" {
                    return Err(invalid("Unexpected Goal authorization"));
                }
                let id = goal_id.ok_or_else(|| invalid("No Goal"))?;
                json!({"kind":"control","id":id,"revision":revision,"action":action,"grant":submission.grant})
            };
            manage(owner, cx.caller, input).await?;
            Ok(Reply::Applied { route: Value::Null })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cx() -> Words {
        Words::new("en")
    }
    fn goal(status: Status) -> Current {
        let arm = Arm {
            operation_id: Uuid::new_v4(),
            objective: "Improve tests".into(),
            grant: maka_plugins::authorization::Id(Uuid::new_v4()),
            max_iterations: 4,
            token_budget: Some(1000),
            start: true,
        };
        Current {
            revision: 7,
            goal: Goal {
                id: arm.operation_id,
                session_id: "session".into(),
                arm,
                status,
                iterations: 1,
                baseline: Default::default(),
                consumed: Default::default(),
                pending: None,
                last_operation_id: None,
                report: None,
                note: "working".into(),
                authority_blocked: false,
            },
        }
    }

    #[test]
    fn a_new_goal_is_a_small_form_with_one_arming_identity_for_retries() {
        let view = panel(None, &cx());
        view.validate().unwrap();
        assert_eq!(view.fields.len(), 3);
        let (_, goal, operation, blocked) = revision(&view.revision).unwrap();
        assert!(goal.is_none() && !blocked);
        for action in &view.actions {
            assert_eq!(
                action.recovery,
                Some(json!({"kind":"arm","operationId":operation}))
            );
        }
        assert!(
            line(None, &cx()).root.children().is_empty(),
            "no Goal, no status"
        );
    }

    #[test]
    fn an_active_goal_offers_its_decisions_and_asks_before_cancelling() {
        let current = goal(Status::Active);
        let view = panel(Some(&current), &cx());
        view.validate().unwrap();
        assert!(view.fields.is_empty());
        let ids: Vec<_> = view
            .actions
            .iter()
            .map(|action| action.id.as_str())
            .collect();
        assert_eq!(ids, ["pause", "complete", "cancel"]);
        assert!(
            view.action("cancel")
                .unwrap()
                .confirm
                .as_ref()
                .unwrap()
                .destructive
        );
        assert_eq!(revision(&view.revision).unwrap().0, 7);
        let status = line(Some(&current), &cx());
        status.validate().unwrap();
        assert_eq!(status.root.children().len(), 3);
        // A finished Goal shows how it ended above a form for the next one.
        let view = panel(Some(&goal(Status::Achieved)), &cx());
        view.validate().unwrap();
        assert_eq!(view.fields.len(), 3);
        assert!(
            line(Some(&goal(Status::Achieved)), &cx())
                .root
                .children()
                .is_empty()
        );
    }
}
