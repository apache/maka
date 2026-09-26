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

//! WorkHub as an app of its own: a coordinator conversation to hand work
//! to, and a board of the work it delegated to other sessions, each piece
//! with where it runs, how it stands and what it returned. It speaks
//! WorkHub's own Remote methods.

use super::{
    Manager,
    remote::{Action as Call, Call as Calling},
};
use futures_util::future::BoxFuture;
use maka_plugins::{
    authorization::{Capability, Request as Authorization, Target as Scope},
    contributions::Staged,
    remote::{Caller, Error, Method, key},
    terminal_ui::{
        Context, Descriptor, Placement, Text, VERSION,
        app::{self, App, Cx, Submission, Words},
        view::{self, Action, Confirm, Node, Reply, Role, Tone, View, build::*},
    },
};
use maka_runtime::event::Invocation;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

mod setup;

pub(super) fn publish(
    staged: &mut Staged,
    manager: Arc<Manager>,
    package: &str,
) -> Result<(), String> {
    let endpoint = app::endpoint(
        Hub(manager.clone()),
        Descriptor::new(Text::plain("WorkHub"), Context::Application)
            .icon("◈", "H")
            .order(10),
    )
    .map_err(|error| error.to_string())?
    .requiring_host_paths();
    staged
        .insert(
            key(package, "terminal").map_err(|error| error.to_string())?,
            endpoint,
        )
        .map_err(|error| error.to_string())?;
    staged
        .insert(
            key(package, "task-models").map_err(|error| error.to_string())?,
            app::endpoint(
                setup::SessionModels(Hub(manager)),
                Descriptor::new(
                    Text::localized(
                        "WorkHub task models",
                        "WorkHub 任务模型",
                        "WorkHub 任務模型",
                    ),
                    Context::Session,
                )
                .placement(Placement::Panel)
                .icon("◈", "H")
                .order(40),
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
}

struct Hub(Arc<Manager>);

/// WorkHub works in its own plugin workspace, and needs leave to run there.
fn workspace() -> Scope {
    Scope::PluginWorkspace {
        sandbox_mode: maka_runtime::execution::SandboxMode::WorkspaceWrite,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Query {
    coordinator_session_id: Option<String>,
    recovery: Recovery,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Recovery {
    pending_results: bool,
    failures: Vec<Failure>,
    unavailable: Option<String>,
}
#[derive(Deserialize)]
struct Failure {
    message: String,
    retrying: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    entries: Vec<Summary>,
    next_after: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    operation_id: String,
    title: String,
    source: Invocation,
    delivery: Option<Delivery>,
    retired: bool,
    control: Option<String>,
}
#[derive(Deserialize)]
struct Delivery {
    receipt: Receipt,
}
#[derive(Deserialize)]
struct Receipt {
    invocation: Invocation,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Feedback {
    id: String,
    state: String,
    result_preview: Option<String>,
}

/// Where the app is: the board under a filter, or one piece of work.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Place {
    filter: Option<String>,
    after: Option<String>,
    assignment: Option<String>,
    setup: Option<setup::Route>,
}

impl Hub {
    async fn detail(&self, id: &str) -> Result<Option<Summary>, Error> {
        let assignment = self
            .0
            .assignments
            .repository
            .read::<crate::assignment::Assignment>(
                &crate::assignment::key(id).map_err(super::remote::failure)?,
            )
            .await
            .map_err(super::remote::failure)?;
        Ok(assignment.map(|(_, assignment)| Summary {
            operation_id: assignment.request.operation_id,
            title: match assignment.request.target {
                crate::assignment::Target::Create { request } => request.name,
                crate::assignment::Target::Existing { .. } => {
                    assignment.request.content.text.chars().take(160).collect()
                }
            },
            source: assignment.request.source,
            delivery: assignment.delivery.map(|delivery| Delivery {
                receipt: Receipt {
                    invocation: delivery.invocation().clone(),
                },
            }),
            retired: assignment.retired,
            control: assignment.control,
        }))
    }
    async fn call<T: for<'de> Deserialize<'de>>(
        &self,
        action: Call,
        input: Value,
        caller: &Caller,
    ) -> Result<T, Error> {
        let value = Calling {
            manager: self.0.clone(),
            action,
        }
        .call(input, caller.clone())
        .await?;
        serde_json::from_value(value).map_err(|error| Error::Provider(error.to_string()))
    }
    async fn ready(&self, caller: &Caller) -> Result<bool, Error> {
        let remembered: Option<Value> =
            self.call(Call::Consent, json!(workspace()), caller).await?;
        Ok(remembered.is_some())
    }
    async fn board(
        &self,
        caller: &Caller,
        after: Option<String>,
    ) -> Result<(Page, Vec<Feedback>), Error> {
        let page: Page = self
            .call(Call::Assignments, json!({"after": after}), caller)
            .await?;
        let ids: Vec<&str> = page
            .entries
            .iter()
            .take(32)
            .map(|entry| entry.operation_id.as_str())
            .collect();
        let feedback: Vec<Feedback> = if ids.is_empty() {
            vec![]
        } else {
            self.call(Call::Feedback, json!(ids), caller).await?
        };
        Ok((page, feedback))
    }
}

impl App for Hub {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let this = Hub(self.0.clone());
        Box::pin(async move {
            let words = &cx.words;
            let place: Place = serde_json::from_value(route).unwrap_or_default();
            if let Some(route) = place.setup {
                return setup::read(&this, route, &cx).await;
            }
            if !this.ready(&cx.caller).await? {
                return Ok(welcome(words));
            }
            if let Some(id) = &place.assignment {
                let summary = this.detail(id).await?;
                let feedback: Vec<Feedback> =
                    this.call(Call::Feedback, json!([id]), &cx.caller).await?;
                return Ok(assignment(words, id, summary.as_ref(), feedback.first()));
            }
            let query: Query = this.call(Call::Query, Value::Null, &cx.caller).await?;
            let (page, feedback) = this.board(&cx.caller, place.after.clone()).await?;
            let filter = place.filter.unwrap_or_else(|| "active".into());
            let mut view = board(words, &query, &page, &feedback, &filter);
            setup::entries(&this, &mut view, &cx).await?;
            Ok(view)
        })
    }

    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let this = Hub(self.0.clone());
        Box::pin(async move {
            let rejected = |error: Error| match error {
                Error::Invalid(message) | Error::Provider(message) => Ok(Reply::Rejected {
                    message: view::build::clean(&message, false)
                        .chars()
                        .take(256)
                        .collect(),
                }),
                error => Err(error),
            };
            if submission.action == "search" || submission.action == "save-target" {
                return match setup::submit(&this, submission, &cx).await {
                    Err(Error::Invalid(message)) => Ok(Reply::Rejected {
                        message: clean(&message, false).chars().take(256).collect(),
                    }),
                    result => result,
                };
            }
            match submission.action.as_str() {
                "discovery" => setup::discovery(&this, submission, &cx).await,
                "setup" => {
                    let Some(grant) = submission.grant else {
                        return Ok(Reply::Consent {
                            request: Authorization {
                                operation_id: uuid::Uuid::new_v4(),
                                title: "Let WorkHub coordinate work".into(),
                                target: workspace(),
                                capabilities: [Capability::Executions].into(),
                            },
                        });
                    };
                    if let Err(error) = this
                        .call::<Value>(Call::Authorize, json!({"id": grant}), &cx.caller)
                        .await
                    {
                        return rejected(error);
                    }
                    match this
                        .call::<Value>(Call::Resolve, Value::Null, &cx.caller)
                        .await
                    {
                        Ok(_) => Ok(Reply::Applied { route: Value::Null }),
                        Err(error) => rejected(error),
                    }
                }
                "start" => match this
                    .call::<Value>(Call::Resolve, Value::Null, &cx.caller)
                    .await
                {
                    Ok(_) => Ok(Reply::Applied { route: Value::Null }),
                    Err(error) => rejected(error),
                },
                action @ ("stop" | "resume") => {
                    let id = submission
                        .route
                        .get("assignment")
                        .and_then(Value::as_str)
                        .ok_or_else(|| Error::Invalid("No assignment".into()))?
                        .to_owned();
                    match this
                        .call::<Value>(
                            Call::Control,
                            json!({"operationId":uuid::Uuid::new_v4().to_string(),"assignmentId":id,
                                "action":{"kind":action}}),
                            &cx.caller,
                        )
                        .await
                    {
                        Ok(_) => Ok(Reply::Applied {
                            route: submission.route,
                        }),
                        Err(error) => rejected(error),
                    }
                }
                _ => Err(Error::Invalid("Unknown WorkHub action".into())),
            }
        })
    }
}

fn view_of(title: &str, revision: &str, actions: Vec<Action>, root: Node) -> View {
    View {
        version: VERSION,
        title: title.into(),
        revision: revision.into(),
        fields: vec![],
        actions,
        root,
    }
}

fn welcome(words: &Words) -> View {
    view_of(
        "WorkHub",
        "welcome",
        vec![view::build::action("setup", words.t("Set up WorkHub", "设置 WorkHub", "設定 WorkHub"))],
        column(
            "root",
            vec![
                heading("title", "WorkHub"),
                text(
                    "pitch",
                    words.t(
                        "Hand WorkHub a goal in plain words. It plans the work, delegates each piece to a session, and keeps track until it is done.",
                        "用自然语言把目标交给 WorkHub。它会规划工作，把每一部分委派给会话，并一直跟进到完成。",
                        "用自然語言把目標交給 WorkHub。它會規劃工作，把每一部分委派給工作階段，並一直追蹤到完成。",
                    ),
                    Tone::Muted,
                ),
                text(
                    "leave",
                    words.t(
                        "It works in its own workspace and starts the sessions it delegates to, so it asks first.",
                        "它在自己的工作区中运行，并会启动被委派的会话，因此需要先获得许可。",
                        "它在自己的工作區中執行，並會啟動被委派的工作階段，因此需要先取得許可。",
                    ),
                    Tone::Subtle,
                ),
                row("setup", vec![button("setup", "setup", Role::Primary)]),
                link("coordinator-model", words.t("Choose coordinator model", "选择协调器模型", "選擇協調器模型"),
                    json!({"setup":{"purpose":{"kind":"coordinator"}}})).into(),
            ],
        ),
    )
}

/// How a piece of work stands, and which filter shows it.
fn state(words: &Words, state: Option<&str>) -> (String, Tone, &'static str) {
    let (en, zh_cn, zh_tw, tone, group) = match state {
        Some("running") => ("Running", "运行中", "執行中", Tone::Accent, "active"),
        Some("accepted") => ("Queued", "排队中", "排隊中", Tone::Muted, "active"),
        Some("recovering") => ("Checking", "核对中", "核對中", Tone::Warning, "active"),
        Some("waiting_for_user") => ("Needs you", "需要你", "需要你", Tone::Warning, "attention"),
        Some("failed") => ("Failed", "失败", "失敗", Tone::Error, "attention"),
        Some("completed") => ("Done", "完成", "完成", Tone::Success, "done"),
        Some("aborted") => ("Stopped", "已停止", "已停止", Tone::Muted, "done"),
        _ => ("Unknown", "未知", "未知", Tone::Subtle, "active"),
    };
    (words.t(en, zh_cn, zh_tw), tone, group)
}

fn board(words: &Words, query: &Query, page: &Page, feedback: &[Feedback], filter: &str) -> View {
    let mut children = vec![];
    let mut actions = vec![];
    match &query.coordinator_session_id {
        Some(session) => children.push(Node::Item {
            key: "coordinator".into(),
            title: words.t("Coordinator conversation", "协调对话", "協調對話"),
            detail: words.t(
                "Tell WorkHub what you need, or ask how the work is going",
                "告诉 WorkHub 你需要什么，或询问工作进展",
                "告訴 WorkHub 你需要什麼，或詢問工作進展",
            ),
            meta: String::new(),
            tone: Tone::Accent,
            current: false,
            target: view::Target::Session {
                session: session.clone(),
            },
        }),
        None => {
            actions.push(view::build::action(
                "start",
                words.t("Start WorkHub", "启动 WorkHub", "啟動 WorkHub"),
            ));
            children.push(row("start", vec![button("start", "start", Role::Primary)]));
        }
    }
    let recovery = &query.recovery;
    if let Some(unavailable) = &recovery.unavailable {
        children.push(text(
            "unavailable",
            view::build::clean(unavailable, false),
            Tone::Warning,
        ));
    }
    for (index, failure) in recovery.failures.iter().take(5).enumerate() {
        let tone = if failure.retrying {
            Tone::Warning
        } else {
            Tone::Error
        };
        children.push(text(
            format!("failure-{index}"),
            view::build::clean(&failure.message, false),
            tone,
        ));
    }
    if recovery.pending_results {
        children.push(text(
            "pending",
            words.t(
                "Some results are still being collected.",
                "仍在收集部分结果。",
                "仍在收集部分結果。",
            ),
            Tone::Subtle,
        ));
    }
    children.push(tabs(
        "filter",
        filter,
        [
            ("active", words.t("Active", "进行中", "進行中")),
            ("attention", words.t("Needs you", "需要你", "需要你")),
            ("done", words.t("Done", "已完成", "已完成")),
            ("all", words.t("All", "全部", "全部")),
        ]
        .into_iter()
        .map(|(id, label)| (id.to_owned(), label, json!({"filter": id})))
        .collect(),
    ));
    let rows: Vec<Node> = page
        .entries
        .iter()
        .filter(|entry| !entry.retired)
        .filter_map(|entry| {
            let item = feedback.iter().find(|item| item.id == entry.operation_id);
            let (label, tone, group) = state(words, item.map(|item| item.state.as_str()));
            if filter != "all" && group != filter {
                return None;
            }
            let mut row = link(
                format!("work-{}", entry.operation_id).replace('/', ":"),
                view::build::clean(&entry.title, false),
                json!({"assignment": entry.operation_id}),
            )
            .meta(label)
            .tone(tone);
            if let Some(preview) = item.and_then(|item| item.result_preview.as_deref()) {
                row = row.detail(view::build::clean(preview, false));
            }
            Some(row.into())
        })
        .collect();
    if rows.is_empty() {
        children.push(text(
            "empty",
            words.t(
                "Nothing here. Work WorkHub delegates appears as it starts.",
                "这里还没有内容。WorkHub 委派的工作开始后会出现在这里。",
                "這裡還沒有內容。WorkHub 委派的工作開始後會出現在這裡。",
            ),
            Tone::Muted,
        ));
    } else {
        children.push(scroll("work", 24, stack("list", rows)));
    }
    if let Some(after) = &page.next_after {
        children.push(
            link(
                "more",
                words.t("Older work", "更早的工作", "更早的工作"),
                json!({"filter": filter, "after": after}),
            )
            .into(),
        );
    }
    view_of("WorkHub", filter, actions, column("root", children))
}

fn assignment(
    words: &Words,
    id: &str,
    summary: Option<&Summary>,
    feedback: Option<&Feedback>,
) -> View {
    let Some(summary) = summary else {
        return view_of(
            "WorkHub",
            id,
            vec![],
            column(
                "root",
                vec![text(
                    "gone",
                    words.t(
                        "This work is no longer listed.",
                        "这项工作已不在列表中。",
                        "這項工作已不在列表中。",
                    ),
                    Tone::Muted,
                )],
            ),
        );
    };
    let (label, tone, group) = state(words, feedback.map(|item| item.state.as_str()));
    let mut children = vec![
        heading("title", view::build::clean(&summary.title, false)),
        text("state", label, tone),
    ];
    if let Some(preview) = feedback.and_then(|item| item.result_preview.as_deref()) {
        children.push(stack(
            "result",
            vec![
                text(
                    "label",
                    words.t("Result so far", "目前结果", "目前結果"),
                    Tone::Subtle,
                ),
                markdown("text", view::build::clean(preview, true)),
            ],
        ));
    }
    if let Some(delivery) = &summary.delivery {
        children.push(Node::Item {
            key: "delegated".into(),
            title: words.t(
                "Open the session doing it",
                "打开执行它的会话",
                "開啟執行它的工作階段",
            ),
            detail: String::new(),
            meta: String::new(),
            tone: Tone::Normal,
            current: false,
            target: view::Target::Session {
                session: delivery.receipt.invocation.session_id.clone(),
            },
        });
    }
    children.push(Node::Item {
        key: "source".into(),
        title: words.t(
            "Open where it was asked for",
            "打开发起它的会话",
            "開啟發起它的工作階段",
        ),
        detail: String::new(),
        meta: String::new(),
        tone: Tone::Normal,
        current: false,
        target: view::Target::Session {
            session: summary.source.session_id.clone(),
        },
    });
    if !summary.retired {
        children.push(
            link(
                "model",
                words.t("Change task model", "更换任务模型", "更換任務模型"),
                json!({"setup":{"purpose":{"kind":"delegation","assignment":id}}}),
            )
            .into(),
        );
        // Only stable task/session identities cross the extension boundary.
        // A filler owns its own data; it receives no result text or authority.
        children.push(slot(
            format!(
                "extensions-{}",
                crate::repository::digest(&id).expect("assignment identity serializes")
            ),
            "workhub.task.detail",
            json!({"assignmentId":id,"sourceSessionId":summary.source.session_id}),
        ));
    }
    let mut actions = vec![];
    let stopped = feedback.is_some_and(|item| item.state == "aborted");
    if summary.retired {
        // Retired assignments keep their history but offer no new controls.
    } else if summary.control.is_some() {
        // A stop or resume is already on its way; another waits for it.
        children.push(text(
            "applying",
            words.t(
                "A change to this work is being applied.",
                "正在应用对这项工作的更改。",
                "正在套用對這項工作的變更。",
            ),
            Tone::Subtle,
        ));
    } else if group != "done" {
        actions.push(Action {
            confirm: Some(Confirm {
                title: words.t("Stop this work?", "停止这项工作？", "停止這項工作？"),
                message: words.t(
                    "The session doing it stops. What it already changed stays.",
                    "执行它的会话会停止。已做出的更改会保留。",
                    "執行它的工作階段會停止。已做出的變更會保留。",
                ),
                destructive: true,
            }),
            ..view::build::action("stop", words.t("Stop", "停止", "停止"))
        });
        children.push(row(
            "controls",
            vec![button("stop", "stop", Role::Destructive)],
        ));
    } else if stopped {
        actions.push(view::build::action(
            "resume",
            words.t("Resume", "继续", "繼續"),
        ));
        children.push(row(
            "controls",
            vec![button("resume", "resume", Role::Primary)],
        ));
    }
    view_of(
        "WorkHub",
        &format!(
            "{id}:{}",
            feedback.map_or("none", |item| item.state.as_str())
        ),
        actions,
        column("root", children),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invocation(session: &str) -> Invocation {
        Invocation {
            session_id: session.into(),
            turn_id: format!("turn-{session}"),
            run_id: format!("run-{session}"),
            invocation_id: format!("invocation-{session}"),
        }
    }

    fn summary(id: &str) -> Summary {
        // Exercise the actual domain serialization consumed by Call::Assignments.
        // Invocation is snake_case inside the otherwise camelCase summary.
        let domain = crate::observation::Summary {
            operation_id: id.into(),
            title: format!("Task {id}"),
            source: invocation("coordinator"),
            delivery: Some(crate::assignment::Delivery::Submitted {
                receipt: maka_plugins::execution::Receipt {
                    invocation: invocation(&format!("worker-{id}")),
                    message_id: format!("message-{id}"),
                    content_digest: format!("digest-{id}"),
                },
            }),
            retired: false,
            control: None,
        };
        serde_json::from_value(serde_json::to_value(domain).unwrap()).unwrap()
    }

    #[test]
    fn localized_assignment_states_need_no_glyph_and_preserve_user_content() {
        let mut summary = summary("a");
        summary.title = "任务 ● 😀".into();
        for (state, labels, tone) in [
            ("running", ["Running", "运行中", "執行中"], Tone::Accent),
            ("accepted", ["Queued", "排队中", "排隊中"], Tone::Muted),
            (
                "recovering",
                ["Checking", "核对中", "核對中"],
                Tone::Warning,
            ),
            (
                "waiting_for_user",
                ["Needs you", "需要你", "需要你"],
                Tone::Warning,
            ),
            ("failed", ["Failed", "失败", "失敗"], Tone::Error),
            ("completed", ["Done", "完成", "完成"], Tone::Success),
            ("aborted", ["Stopped", "已停止", "已停止"], Tone::Muted),
            ("unknown", ["Unknown", "未知", "未知"], Tone::Subtle),
        ] {
            let feedback = Feedback {
                id: "a".into(),
                state: state.into(),
                result_preview: Some("结果 ● ✓ 😀".into()),
            };
            for (locale, label) in ["en", "zh-CN", "zh-TW"].into_iter().zip(labels) {
                let detail = assignment(&Words::new(locale), "a", Some(&summary), Some(&feedback));
                detail.validate().unwrap();
                let Node::Text { spans, .. } = detail.root.children()[1] else {
                    panic!("assignment state");
                };
                assert_eq!(spans.len(), 1);
                assert_eq!(spans[0].text, label);
                assert_eq!(spans[0].tone, tone);
                let encoded = serde_json::to_string(&detail).unwrap();
                assert!(encoded.contains("任务 ● 😀"));
                assert!(encoded.contains("结果 ● ✓ 😀"));
            }
        }
    }

    #[test]
    fn the_board_files_work_by_state_and_each_piece_opens_its_sessions() {
        let words = Words::new("en");
        welcome(&words).validate().unwrap();
        let query = Query {
            coordinator_session_id: Some("coordinator".into()),
            recovery: Recovery {
                pending_results: true,
                failures: vec![Failure {
                    message: "Could not reach a session".into(),
                    retrying: true,
                }],
                unavailable: None,
            },
        };
        let page = Page {
            entries: vec![summary("a"), summary("b")],
            next_after: Some("b".into()),
        };
        let feedback = vec![
            Feedback {
                id: "a".into(),
                state: "running".into(),
                result_preview: None,
            },
            Feedback {
                id: "b".into(),
                state: "waiting_for_user".into(),
                result_preview: Some("Which branch?".into()),
            },
        ];
        let active = board(&words, &query, &page, &feedback, "active");
        active.validate().unwrap();
        let text = serde_json::to_string(&active).unwrap();
        assert!(text.contains("Task a") && !text.contains("Task b"));
        assert!(text.contains("\"kind\":\"session\"") && text.contains("Could not reach"));
        let task_target = |view: &View| {
            let mut pending = vec![&view.root];
            while let Some(node) = pending.pop() {
                if let Node::Item { key, target, .. } = node
                    && key == "work-a"
                {
                    return target.clone();
                }
                pending.extend(node.children());
            }
            panic!("task a has a destination")
        };
        let another_list = board(&words, &query, &page, &feedback, "all");
        assert_eq!(
            task_target(&active),
            task_target(&another_list),
            "the task and its nested drafts keep one address across list filters"
        );
        let attention =
            serde_json::to_string(&board(&words, &query, &page, &feedback, "attention")).unwrap();
        assert!(attention.contains("Task b") && attention.contains("Which branch?"));
        let detail = assignment(&words, "a", page.entries.first(), feedback.first());
        detail.validate().unwrap();
        assert!(
            detail
                .action("stop")
                .unwrap()
                .confirm
                .as_ref()
                .unwrap()
                .destructive
        );
        assert!(serde_json::to_string(&detail).unwrap().contains("worker-a"));
        let Node::Column { children, .. } = &detail.root else {
            panic!("task detail column");
        };
        let context = children
            .iter()
            .find_map(|node| match node {
                Node::Slot { name, context, .. } if name == "workhub.task.detail" => Some(context),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            context,
            &json!({"assignmentId":"a","sourceSessionId":"coordinator"})
        );
        let slot_key = |view: &View| {
            let Node::Column { children, .. } = &view.root else {
                panic!("task detail")
            };
            children
                .iter()
                .find_map(|node| match node {
                    Node::Slot { key, context, .. } => Some((key.clone(), context.clone())),
                    _ => None,
                })
                .unwrap()
        };
        // Delivery adds a session link, but the mounted child keeps the same
        // origin while its draft or unknown write is retained.
        let mut undelivered = summary("a");
        undelivered.delivery = None;
        let pending = assignment(&words, "a", Some(&undelivered), None);
        pending.validate().unwrap();
        assert_eq!(slot_key(&pending), slot_key(&detail));
        assert!(
            !serde_json::to_string(&pending)
                .unwrap()
                .contains("worker-a")
        );
        let second = assignment(&words, "b", page.entries.get(1), feedback.get(1));
        second.validate().unwrap();
        assert_ne!(slot_key(&detail), slot_key(&second));
        assert_eq!(
            slot_key(&detail),
            slot_key(&assignment(
                &words,
                "a",
                page.entries.first(),
                feedback.get(1)
            ))
        );

        let mut retired = summary("retired");
        retired.retired = true;
        let history = assignment(&words, "retired", Some(&retired), feedback.first());
        history.validate().unwrap();
        assert!(history.actions.is_empty());
        let Node::Column { children, .. } = history.root else {
            panic!("task history")
        };
        assert!(
            !children
                .iter()
                .any(|node| matches!(node, Node::Slot { .. }))
        );
    }
}
