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

use super::{Route, Source, Stamp, invalid, title};
use crate::plan::{Artifact, Phase, ProposalStatus, Snapshot, StepStatus};
use maka_plugins::{
    remote::Error,
    terminal_ui::{
        app::Words,
        view::{self, Action, Confirm, Node, Role, Tone, View, build::*},
    },
};
use serde_json::{Value, json};

fn base(snapshot: &Snapshot, cx: &Words, root: Node) -> View {
    View {
        version: maka_plugins::terminal_ui::VERSION,
        title: title().resolve(&cx.locale).into(),
        revision: serde_json::to_string(&Stamp::new(snapshot)).expect("serializable stamp"),
        fields: vec![],
        actions: vec![],
        root,
    }
}
fn short(value: &str, bytes: usize) -> String {
    let value = clean(value, false);
    if value.len() <= bytes {
        return value;
    }
    let mut end = bytes.saturating_sub(3);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}
fn artifact(snapshot: &Snapshot, source: Source) -> Option<&Artifact> {
    match source {
        Source::Proposal => snapshot.proposal.as_ref().map(|p| &p.artifact),
        Source::Execution => snapshot.execution.as_ref().map(|e| &e.artifact),
    }
}
fn label(snapshot: &Snapshot, source: Source, cx: &Words) -> (String, Tone) {
    let (en, cn, tw, tone) = match source {
        Source::Proposal => match snapshot.proposal.as_ref().map(|p| p.status) {
            Some(ProposalStatus::PendingApproval) => {
                ("Ready for review", "等待审阅", "等待審閱", Tone::Warning)
            }
            Some(ProposalStatus::RevisionRequested) => {
                ("Changes requested", "等待修改", "等待修改", Tone::Warning)
            }
            Some(ProposalStatus::Approved) => ("Approved", "已批准", "已批准", Tone::Success),
            Some(ProposalStatus::Abandoned) => ("Abandoned", "已放弃", "已放棄", Tone::Muted),
            None => ("No proposal yet", "尚无提案", "尚無提案", Tone::Subtle),
        },
        Source::Execution => match snapshot.execution.as_ref() {
            Some(e)
                if e.cancellation.is_some()
                    && matches!(e.phase, Phase::AwaitingAdmission | Phase::Active { .. }) =>
            {
                (
                    "Stopping; outcome pending",
                    "停止结果待确认",
                    "停止結果待確認",
                    Tone::Warning,
                )
            }
            Some(e) => match e.phase {
                Phase::AwaitingAdmission => (
                    "Confirming start",
                    "启动待确认",
                    "啟動待確認",
                    Tone::Warning,
                ),
                Phase::Active { .. } => ("In progress", "执行中", "執行中", Tone::Accent),
                Phase::Interrupted { .. } => ("Interrupted", "已中断", "已中斷", Tone::Warning),
                Phase::Completed { .. } => ("Completed", "已完成", "已完成", Tone::Success),
                Phase::Cancelled { .. } => ("Cancelled", "已取消", "已取消", Tone::Muted),
            },
            None => ("No execution yet", "尚未执行", "尚未執行", Tone::Subtle),
        },
    };
    (cx.t(en, cn, tw), tone)
}
fn step_label(status: StepStatus, cx: &Words) -> String {
    match status {
        StepStatus::Pending => cx.t("Pending", "待执行", "待執行"),
        StepStatus::InProgress => cx.t("In progress", "执行中", "執行中"),
        StepStatus::Completed => cx.t("Completed", "已完成", "已完成"),
        StepStatus::Skipped => cx.t("Skipped", "已跳过", "已略過"),
    }
}
fn navigation(snapshot: &Snapshot, current: &str, historical: bool, cx: &Words) -> Node {
    let target = |source| {
        if historical {
            json!(Route::Revision {
                revision: snapshot.revision,
                source
            })
        } else {
            json!(Route::Current { source })
        }
    };
    tabs(
        "tabs",
        current,
        vec![
            (
                "proposal".into(),
                cx.t("Proposal", "提案", "提案"),
                target(Source::Proposal),
            ),
            (
                "execution".into(),
                cx.t("Execution", "执行", "執行"),
                target(Source::Execution),
            ),
            (
                "history".into(),
                cx.t("History", "历史", "歷史"),
                json!(Route::History {
                    through: snapshot.revision,
                    before: snapshot.revision
                }),
            ),
        ],
    )
}
fn source_key(source: Source) -> &'static str {
    match source {
        Source::Proposal => "proposal",
        Source::Execution => "execution",
    }
}
pub(super) fn destination(action: &str) -> Value {
    json!(Route::Current {
        source: if matches!(action, "revise" | "abandon") {
            Source::Proposal
        } else {
            Source::Execution
        }
    })
}
pub(super) fn offered(snapshot: &Snapshot, source: Source, id: &str) -> bool {
    controls(snapshot, source).contains(&id)
}
fn controls(snapshot: &Snapshot, source: Source) -> Vec<&'static str> {
    match source {
        Source::Proposal => match snapshot.proposal.as_ref().map(|p| p.status) {
            Some(ProposalStatus::PendingApproval) => vec!["approve", "revise", "abandon"],
            Some(ProposalStatus::RevisionRequested) => vec!["abandon"],
            _ => vec![],
        },
        Source::Execution => match snapshot.execution.as_ref() {
            Some(e) => match e.phase {
                Phase::AwaitingAdmission | Phase::Active { .. } => vec!["reconcile", "cancel"],
                Phase::Interrupted { .. } => {
                    if snapshot.proposal.as_ref().is_some_and(|p| {
                        p.id != e.proposal_id && p.status != ProposalStatus::Abandoned
                    }) {
                        vec!["cancel"]
                    } else {
                        vec!["resume", "cancel"]
                    }
                }
                _ => vec![],
            },
            None => vec![],
        },
    }
}

pub(super) fn page(
    snapshot: &Snapshot,
    source: Source,
    historical: bool,
    cx: &Words,
    session: &str,
) -> View {
    let mut rows = vec![navigation(snapshot, source_key(source), historical, cx)];
    if historical {
        rows.push(text(
            "revision",
            cx.t(
                &format!("Revision {} · Read-only", snapshot.revision),
                &format!("修订 {} · 只读", snapshot.revision),
                &format!("修訂 {} · 唯讀", snapshot.revision),
            ),
            Tone::Muted,
        ));
    }
    let (state, tone) = label(snapshot, source, cx);
    rows.push(text("state", state, tone));
    if let Some(plan) = artifact(snapshot, source) {
        rows.push(heading("title", short(&plan.title, 256)));
        if let Some(overview) = &plan.overview {
            rows.push(markdown("overview", short(overview, 1024)));
        }
        rows.push(
            link(
                "details",
                cx.t("Overview and risks", "概述与风险", "概述與風險"),
                json!(Route::Details {
                    revision: snapshot.revision,
                    source
                }),
            )
            .into(),
        );
        let mut steps = vec![];
        for step in &plan.steps {
            let progress = match source {
                Source::Execution => snapshot
                    .execution
                    .as_ref()
                    .and_then(|e| e.steps.iter().find(|p| p.id == step.id)),
                _ => None,
            };
            let mut item = link(
                step.id.clone(),
                clean(&step.title, false),
                json!(Route::Step {
                    revision: snapshot.revision,
                    source,
                    id: step.id.clone()
                }),
            )
            .detail(short(&step.description, 160));
            if let Some(progress) = progress {
                item = item.meta(step_label(progress.status, cx));
            }
            steps.push(item.into());
        }
        rows.push(scroll("steps", 14, column("items", steps)));
        if let Source::Execution = source
            && let Some(execution) = &snapshot.execution
        {
            let completed = execution
                .steps
                .iter()
                .filter(|step| matches!(step.status, StepStatus::Completed | StepStatus::Skipped))
                .count();
            rows.push(progress(
                "progress",
                completed as u64,
                execution.steps.len() as u64,
                cx.t("Steps", "步骤", "步驟"),
            ));
            if let Phase::Interrupted { reason, .. } = &execution.phase {
                rows.push(text("reason", clean(reason, true), Tone::Warning));
            }
        }
    } else {
        rows.push(text(
            "empty",
            cx.t(
                "Ask the assistant to plan your work in the conversation.",
                "在对话中让助手为工作制定计划。",
                "在對話中請助手為工作制定計畫。",
            ),
            Tone::Muted,
        ));
    }
    if historical {
        rows.push(
            link(
                "current",
                cx.t("Current plan", "当前计划", "目前計畫"),
                Value::Null,
            )
            .into(),
        );
    }
    let mut view = base(snapshot, cx, column("root", vec![]));
    if !historical {
        let stamp: Stamp = serde_json::from_str(&view.revision).expect("generated stamp");
        let mut buttons = vec![];
        for id in controls(snapshot, source) {
            let (name, role) = match id {
                "approve" => (
                    cx.t("Approve and run", "批准并执行", "批准並執行"),
                    Role::Primary,
                ),
                "revise" => (
                    cx.t("Request changes", "请求修改", "請求修改"),
                    Role::Normal,
                ),
                "abandon" => (cx.t("Abandon", "放弃", "放棄"), Role::Destructive),
                "resume" => (cx.t("Resume", "继续", "繼續"), Role::Primary),
                "reconcile" => (
                    cx.t("Renew permission", "更新授权", "更新授權"),
                    Role::Normal,
                ),
                _ => (
                    cx.t("Stop execution", "停止执行", "停止執行"),
                    Role::Destructive,
                ),
            };
            let mut action = Action {
                recovery: Some(json!({"operation":stamp.operation(id), "route":destination(id)})),
                ..action(id, name.clone())
            };
            if matches!(id, "approve" | "abandon" | "cancel") {
                action.confirm = Some(Confirm { title: cx.t(&format!("{name}?"), &format!("{name}？"), &format!("{name}？")),
                    message: cx.t(
                        &format!("{} · reviewed revision {}. This decision uses exactly this version of the plan.", short(artifact(snapshot, source).map_or("", |p| p.title.as_str()), 160), snapshot.revision),
                        &format!("{} · 已审阅修订 {}。此操作仅针对这个版本的计划。", short(artifact(snapshot, source).map_or("", |p| p.title.as_str()), 160), snapshot.revision),
                        &format!("{} · 已審閱修訂 {}。此操作僅針對這個版本的計畫。", short(artifact(snapshot, source).map_or("", |p| p.title.as_str()), 160), snapshot.revision)),
                    destructive: matches!(id, "abandon" | "cancel") });
            }
            view.actions.push(action);
            buttons.push(button(id, id, role));
        }
        if !buttons.is_empty() {
            rows.push(row("controls", buttons));
        }
    }
    rows.push(Node::Item {
        key: "conversation".into(),
        title: cx.t("Open conversation", "打开对话", "開啟對話"),
        detail: String::new(),
        meta: String::new(),
        tone: Tone::Muted,
        current: false,
        target: view::Target::Session {
            session: session.into(),
        },
    });
    view.root = column("root", rows);
    view
}

pub(super) fn status(snapshot: &Snapshot, cx: &Words) -> View {
    let source = Source::current(snapshot);
    let finished = match source {
        Source::Proposal => snapshot
            .proposal
            .as_ref()
            .is_some_and(|p| p.status == ProposalStatus::Abandoned),
        Source::Execution => snapshot
            .execution
            .as_ref()
            .is_some_and(|e| matches!(e.phase, Phase::Completed { .. } | Phase::Cancelled { .. })),
    };
    if finished {
        return base(snapshot, cx, row("root", vec![]));
    }
    let rows = match artifact(snapshot, source) {
        Some(plan) => {
            let (state, tone) = label(snapshot, source, cx);
            vec![
                text("title", short(&plan.title, 160), Tone::Normal),
                text("state", state, tone),
            ]
        }
        None => vec![],
    };
    base(snapshot, cx, row("root", rows))
}

pub(super) fn history_row(snapshot: &Snapshot, previous: &Snapshot, cx: &Words) -> Node {
    let source = if snapshot.proposal != previous.proposal {
        Source::Proposal
    } else {
        Source::current(snapshot)
    };
    let (mut state, _) = label(snapshot, source, cx);
    if let Source::Execution = source
        && let Some(execution) = &snapshot.execution
    {
        let progress = match execution
            .steps
            .iter()
            .find(|step| step.status == StepStatus::InProgress)
        {
            Some(active) => execution
                .artifact
                .steps
                .iter()
                .find(|step| step.id == active.id)
                .map(|step| short(&step.title, 120)),
            None => None,
        }
        .unwrap_or_else(|| {
            format!(
                "{}/{}",
                execution
                    .steps
                    .iter()
                    .filter(|step| matches!(
                        step.status,
                        StepStatus::Completed | StepStatus::Skipped
                    ))
                    .count(),
                execution.steps.len()
            )
        });
        state = format!("{state} · {progress}");
    }
    link(
        format!("revision-{}", snapshot.revision),
        state,
        json!(Route::Revision {
            revision: snapshot.revision,
            source
        }),
    )
    .detail(short(
        artifact(snapshot, source).map_or("Plan", |p| p.title.as_str()),
        256,
    ))
    .meta(cx.t(
        &format!("Revision {}", snapshot.revision),
        &format!("修订 {}", snapshot.revision),
        &format!("修訂 {}", snapshot.revision),
    ))
    .into()
}
pub(super) fn history(
    current: &Snapshot,
    through: u64,
    before: u64,
    rows: Vec<Node>,
    cx: &Words,
) -> View {
    let mut children = vec![
        navigation(current, "history", false, cx),
        column("revisions", rows),
    ];
    let mut paging = vec![];
    if before > 8 {
        paging.push(
            link(
                "older",
                cx.t("Earlier", "更早", "更早"),
                json!(Route::History {
                    through,
                    before: before - 8
                }),
            )
            .into(),
        );
    }
    if before < through {
        paging.push(
            link(
                "newer",
                cx.t("Later", "更近", "更近"),
                json!(Route::History {
                    through,
                    before: before.saturating_add(8).min(through)
                }),
            )
            .into(),
        );
    }
    if !paging.is_empty() {
        children.push(row("paging", paging));
    }
    base(current, cx, column("root", children))
}

pub(super) fn details(snapshot: &Snapshot, source: Source, cx: &Words) -> Result<View, Error> {
    let plan = artifact(snapshot, source).ok_or_else(|| invalid("Plan artifact is unavailable"))?;
    let mut rows = vec![heading("title", clean(&plan.title, true))];
    if let Some(overview) = &plan.overview {
        rows.push(markdown("overview", clean(overview, true)));
    }
    if !plan.risks.is_empty() {
        rows.push(heading("risks", cx.t("Risks", "风险", "風險")));
        rows.extend(
            plan.risks.iter().enumerate().map(|(index, risk)| {
                text(format!("risk-{index}"), clean(risk, true), Tone::Warning)
            }),
        );
    }
    Ok(base(snapshot, cx, column("root", rows)))
}
pub(super) fn step(
    snapshot: &Snapshot,
    source: Source,
    id: &str,
    cx: &Words,
) -> Result<View, Error> {
    let step = artifact(snapshot, source)
        .and_then(|p| p.steps.iter().find(|step| step.id == id))
        .ok_or_else(|| invalid("Plan step is unavailable"))?;
    let mut rows = vec![
        heading("title", clean(&step.title, false)),
        markdown("description", clean(&step.description, true)),
    ];
    if let Source::Execution = source
        && let Some(progress) = snapshot
            .execution
            .as_ref()
            .and_then(|e| e.steps.iter().find(|p| p.id == id))
    {
        rows.push(text("state", step_label(progress.status, cx), Tone::Accent));
        if let Some(note) = &progress.note {
            rows.push(text("note", clean(note, true), Tone::Normal));
        }
    }
    if !step.files.is_empty() {
        rows.push(heading("files", cx.t("Files", "文件", "檔案")));
        rows.extend(
            step.files.iter().enumerate().map(|(index, file)| {
                text(format!("file-{index}"), clean(file, false), Tone::Subtle)
            }),
        );
    }
    Ok(base(snapshot, cx, column("root", rows)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{Command, Step};
    use maka_plugins::authorization::Id;
    use uuid::Uuid;

    fn proposal() -> Snapshot {
        let plan = Artifact {
            title: "界".repeat(5000),
            overview: Some("Overview ".repeat(400)),
            steps: (0..50)
                .map(|index| Step {
                    id: format!("step_{index}"),
                    title: "设计与验证".repeat(5),
                    description: "Read the relevant source and verify the result.".into(),
                    files: if index == 0 {
                        (0..50)
                            .map(|i| format!("src/{}.rs", "f".repeat(i + 10)))
                            .collect()
                    } else {
                        vec![]
                    },
                    complexity: None,
                })
                .collect(),
            risks: vec!["A real review is required.".into()],
        };
        plan.validate().unwrap();
        let mut snapshot = Snapshot::default();
        snapshot
            .apply(
                &Command::Propose {
                    turn_id: "planning".into(),
                    artifact: plan,
                },
                "propose",
                "session",
                0,
            )
            .unwrap();
        snapshot.revision = 1;
        snapshot
    }
    #[test]
    fn full_artifacts_are_readable_in_bounded_views_and_only_current_decisions_have_actions() {
        for locale in ["en", "zh-CN", "zh-TW"] {
            let cx = Words::new(locale);
            let mut snapshot = proposal();
            let overview = page(&snapshot, Source::Proposal, false, &cx, "session");
            overview.validate().unwrap();
            let stamp: Stamp = serde_json::from_str(&overview.revision).unwrap();
            assert_eq!(stamp.revision, 1);
            assert_eq!(
                overview
                    .actions
                    .iter()
                    .map(|a| a.id.as_str())
                    .collect::<Vec<_>>(),
                ["approve", "revise", "abandon"]
            );
            for action in &overview.actions {
                assert_eq!(
                    action.recovery.as_ref().unwrap()["operation"],
                    stamp.operation(&action.id)
                );
            }
            let full = details(&snapshot, Source::Proposal, &cx).unwrap();
            full.validate().unwrap();
            assert!(
                serde_json::to_value(&full)
                    .unwrap()
                    .to_string()
                    .contains(&snapshot.proposal.as_ref().unwrap().artifact.title)
            );
            step(&snapshot, Source::Proposal, "step_0", &cx)
                .unwrap()
                .validate()
                .unwrap();
            let historical = page(&snapshot, Source::Proposal, true, &cx, "session");
            assert!(historical.actions.is_empty());
            let Node::Tabs { tabs, .. } = historical.root.children()[0] else {
                panic!("tabs")
            };
            for tab in tabs.iter().filter(|tab| tab.id != "history") {
                assert_eq!(tab.route["kind"], "revision");
                assert_eq!(
                    tab.route["revision"], snapshot.revision,
                    "changing the artifact source must not escape the historical revision"
                );
            }
            history(
                &snapshot,
                1,
                1,
                vec![history_row(&snapshot, &Snapshot::default(), &cx)],
                &cx,
            )
            .validate()
            .unwrap();
            let proposed = snapshot.proposal.as_ref().unwrap();
            snapshot
                .apply(
                    &Command::Approve {
                        proposal_id: proposed.id.clone(),
                        proposal_revision: proposed.revision,
                        behavior: super::super::super::EXECUTION
                            .to_owned()
                            .try_into()
                            .unwrap(),
                        grant: Id(Uuid::new_v4()),
                    },
                    "approve",
                    "session",
                    1,
                )
                .unwrap();
            snapshot.revision = 2;
            page(&snapshot, Source::Execution, false, &cx, "session")
                .validate()
                .unwrap();
            let execution = snapshot.execution.as_ref().unwrap().id.clone();
            snapshot
                .apply(
                    &Command::Cancel {
                        execution_id: execution,
                        reason: "Stopped before admission".into(),
                        grant: None,
                    },
                    "cancel",
                    "session",
                    2,
                )
                .unwrap();
            snapshot.revision = 3;
            assert!(
                status(&snapshot, &cx).root.children().is_empty(),
                "settled work leaves the composer quiet"
            );
            assert!(
                page(&snapshot, Source::Execution, false, &cx, "session")
                    .actions
                    .is_empty()
            );
            snapshot
                .apply(
                    &Command::Propose {
                        turn_id: "another".into(),
                        artifact: snapshot.execution.as_ref().unwrap().artifact.clone(),
                    },
                    "another",
                    "session",
                    3,
                )
                .unwrap();
            snapshot.revision = 4;
            let before = snapshot.clone();
            snapshot
                .apply(
                    &Command::Abandon {
                        proposal_id: before.proposal.as_ref().unwrap().id.clone(),
                    },
                    "abandon",
                    "session",
                    4,
                )
                .unwrap();
            snapshot.revision = 5;
            let row = history_row(&snapshot, &before, &cx);
            let Node::Item {
                title,
                target: view::Target::Route { route },
                ..
            } = row
            else {
                panic!("history row")
            };
            assert_eq!(title, cx.t("Abandoned", "已放弃", "已放棄"));
            assert_eq!(
                route["source"], "proposal",
                "the new proposal decision remains visible beside an older cancelled execution"
            );
        }
    }
}
