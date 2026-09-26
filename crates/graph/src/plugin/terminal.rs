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

//! The agent graph in the terminal: a session panel with the work the
//! graph planned and how each piece stands, a status line while it runs,
//! and the subagent presets as a settings category. It speaks the graph's
//! own Remote methods, so authorization and paging work as they do for
//! any client.

use super::{
    read::Cursor,
    remote::{Action as Call, Service},
};
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    remote::{Caller, Error, Method, key},
    terminal_ui::{
        Context, Descriptor, Placement, Text, VERSION,
        app::{self, App, Cx, Submission, Words},
        view::{self, Action, Confirm, Node, Reply, Role, Tone, View, build::*},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn invalid(message: impl ToString) -> Error {
    Error::Invalid(message.to_string())
}
fn title() -> Text {
    Text::localized("Agents", "智能体", "智慧體")
}

pub(super) fn register(
    staged: &mut Staged,
    package: &str,
    service: Arc<Service>,
) -> Result<(), String> {
    let describe = |placement: Placement| {
        Descriptor::new(title(), Context::Session)
            .placement(placement)
            .icon("⌬", "A")
            .changes("changes")
            .order(30)
    };
    let endpoints = [
        (
            "terminal",
            app::endpoint(
                Graphs {
                    service: service.clone(),
                    place: Place::Panel,
                },
                describe(Placement::Panel),
            )
            .map_err(message)?,
        ),
        (
            "status",
            app::endpoint(
                Graphs {
                    service: service.clone(),
                    place: Place::Status,
                },
                describe(Placement::Status),
            )
            .map_err(message)?,
        ),
        (
            "presets",
            app::endpoint(
                Presets(service),
                Descriptor::new(
                    Text::localized("Subagents", "子智能体", "子智慧體"),
                    Context::Application,
                )
                .placement(Placement::Settings)
                .icon("⌬", "A")
                .order(40),
            )
            .map_err(message)?,
        ),
    ];
    for (method, endpoint) in endpoints {
        staged
            .insert(key(package, method).map_err(message)?, endpoint)
            .map_err(message)?;
    }
    Ok(())
}

async fn call(
    service: &Arc<Service>,
    action: Call,
    input: Value,
    caller: Caller,
) -> Result<Value, Error> {
    super::remote::Call {
        service: service.clone(),
        action,
    }
    .call(input, caller)
    .await
}
fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|error| Error::Provider(error.to_string()))
}

#[derive(Deserialize)]
struct Status {
    authorized: bool,
    selected: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Epochs {
    epochs: Vec<Epoch>,
    current_epoch: Option<u64>,
    next_before: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Epoch {
    epoch: u64,
    graph_id: String,
    mode: String,
}
#[derive(Deserialize)]
struct Snapshot {
    graph: Option<Graph>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Graph {
    epoch: Epoch,
    revision: u64,
    stop_requested: bool,
    finished: bool,
    work: Vec<Work>,
    total_work: usize,
    next_after: Option<Cursor>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Work {
    work_id: String,
    instruction: String,
    status: String,
    execution: Option<Execution>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Execution {
    session_id: String,
    state: String,
    result_record_id: Option<String>,
}
#[derive(Deserialize)]
struct Detailed {
    work: Option<Detail>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Detail {
    instruction: String,
    offset: usize,
    total_bytes: usize,
    next_offset: Option<usize>,
}
#[derive(Deserialize)]
struct Resulted {
    result: Option<Page>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    text: String,
    offset: usize,
    total_bytes: usize,
    next_offset: Option<usize>,
}

#[derive(Clone, Copy)]
enum Place {
    Panel,
    Status,
}
struct Graphs {
    service: Arc<Service>,
    place: Place,
}

/// Where the panel is: the latest graph, one graph, earlier graphs, or one
/// piece of work.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Route {
    Graph {
        graph: String,
        after: Option<Cursor>,
    },
    Earlier {
        before: Option<u64>,
    },
    Work(Reading),
}

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Reading {
    graph: String,
    work: String,
    result: Option<String>,
    after: Option<Cursor>,
    #[serde(default)]
    instruction_offset: usize,
    #[serde(default)]
    result_offset: usize,
}

impl Reading {
    fn route(&self) -> Value {
        let mut route = serde_json::to_value(self).expect("Graph reading route");
        route["kind"] = json!("work");
        route
    }
}

/// Work done, running, and every other state, in words and tone.
fn state(words: &Words, work: &Work) -> (String, Tone) {
    let state = work
        .execution
        .as_ref()
        .map_or(work.status.as_str(), |execution| execution.state.as_str());
    let (en, zh_cn, zh_tw, tone) = match state {
        "completed" => ("Done", "完成", "完成", Tone::Success),
        "running" => ("Running", "运行中", "執行中", Tone::Accent),
        "waiting" => ("Waiting", "等待", "等待", Tone::Warning),
        "blocked" => ("Blocked", "受阻", "受阻", Tone::Error),
        "failed" => ("Failed", "失败", "失敗", Tone::Error),
        "cancelled" | "stopped" => ("Stopped", "已停止", "已停止", Tone::Muted),
        "superseded" => ("Replaced", "已替换", "已替換", Tone::Muted),
        _ => ("Queued", "排队中", "排隊中", Tone::Subtle),
    };
    (words.t(en, zh_cn, zh_tw), tone)
}
fn done(graph: &Graph) -> usize {
    graph
        .work
        .iter()
        .filter(|work| {
            work.execution
                .as_ref()
                .is_some_and(|execution| execution.state == "completed")
        })
        .count()
}
fn first_line(text: &str) -> String {
    clean(text.lines().next().unwrap_or_default(), false)
}
fn clean(value: &str, multiline: bool) -> String {
    view::build::clean(value, multiline)
}
fn view(words: &Words, revision: String, actions: Vec<Action>, root: Node) -> View {
    View {
        version: VERSION,
        title: title().resolve(&words.locale).into(),
        revision,
        fields: vec![],
        actions,
        root,
    }
}

impl Graphs {
    async fn status(&self, caller: &Caller) -> Result<Status, Error> {
        decode(
            call(
                &self.service,
                Call::Authorize,
                json!({"kind":"status"}),
                caller.clone(),
            )
            .await?,
        )
    }
    async fn query(&self, caller: &Caller, query: Value) -> Result<Value, Error> {
        call(&self.service, Call::Query, query, caller.clone()).await
    }
    async fn latest(&self, caller: &Caller) -> Result<(Epochs, Option<Graph>), Error> {
        let epochs: Epochs = decode(self.query(caller, json!({"kind":"epochs"})).await?)?;
        let current = epochs
            .current_epoch
            .and_then(|current| epochs.epochs.iter().find(|epoch| epoch.epoch == current))
            .or_else(|| epochs.epochs.first());
        let graph = match current {
            Some(epoch) => self.graph(caller, &epoch.graph_id, None).await?,
            None => None,
        };
        Ok((epochs, graph))
    }
    async fn graph(
        &self,
        caller: &Caller,
        id: &str,
        after: Option<&Cursor>,
    ) -> Result<Option<Graph>, Error> {
        let snapshot: Snapshot = decode(
            self.query(
                caller,
                json!({"kind":"snapshot","graphId":id,"after":after}),
            )
            .await?,
        )?;
        Ok(snapshot.graph)
    }
}

impl App for Graphs {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let this = Graphs {
            service: self.service.clone(),
            place: self.place,
        };
        Box::pin(async move {
            let words = &cx.words;
            let status = this.status(&cx.caller).await?;
            // A session that does not run as a graph shows nothing here.
            if !status.selected {
                return Ok(view(words, "none".into(), vec![], column("root", vec![])));
            }
            if matches!(this.place, Place::Status) {
                if !status.authorized {
                    return Ok(view(words, "none".into(), vec![], row("root", vec![])));
                }
                let (_, graph) = this.latest(&cx.caller).await?;
                return Ok(line(words, graph.as_ref()));
            }
            if !status.authorized {
                return Ok(ask(words));
            }
            if route.is_null() {
                let (epochs, graph) = this.latest(&cx.caller).await?;
                return Ok(panel(
                    words,
                    graph.as_ref(),
                    epochs.epochs.len() > 1 || epochs.next_before.is_some(),
                    None,
                ));
            }
            match serde_json::from_value::<Route>(route).map_err(invalid)? {
                Route::Graph { graph, after } => {
                    let snapshot = match this.graph(&cx.caller, &graph, after.as_ref()).await {
                        Err(Error::Invalid(_)) if after.is_some() => {
                            return Ok(restart(words, &graph));
                        }
                        result => result?,
                    };
                    Ok(panel(words, snapshot.as_ref(), false, after.as_ref()))
                }
                Route::Earlier { before } => {
                    let epochs: Epochs = decode(
                        this.query(&cx.caller, json!({"kind":"epochs","before":before}))
                            .await?,
                    )?;
                    Ok(earlier(words, &epochs))
                }
                Route::Work(mut reading) => {
                    let snapshot = match this
                        .graph(&cx.caller, &reading.graph, reading.after.as_ref())
                        .await
                    {
                        Err(Error::Invalid(_)) if reading.after.is_some() => {
                            return Ok(restart(words, &reading.graph));
                        }
                        result => result?,
                    };
                    let item = snapshot.as_ref().and_then(|snapshot| {
                        snapshot
                            .work
                            .iter()
                            .find(|item| item.work_id == reading.work)
                    });
                    if item.is_none() {
                        return Ok(restart(words, &reading.graph));
                    }
                    let detail: Detailed = decode(
                        this.query(
                            &cx.caller,
                            json!({"kind":"work","graphId":reading.graph,"workId":reading.work,
                                "offset":reading.instruction_offset}),
                        )
                        .await?,
                    )?;
                    reading.result = reading.result.or_else(|| {
                        item.and_then(|item| item.execution.as_ref())
                            .and_then(|execution| execution.result_record_id.clone())
                    });
                    let answer = match &reading.result {
                        Some(record) => {
                            let page: Resulted = decode(
                                this.query(
                                    &cx.caller,
                                    json!({"kind":"result","graphId":reading.graph,"workId":reading.work,
                                        "recordId":record,"offset":reading.result_offset}),
                                )
                                .await?,
                            )?;
                            page.result
                        }
                        None => None,
                    };
                    Ok(detail_view(
                        words,
                        &reading,
                        item,
                        detail.work.as_ref(),
                        answer.as_ref(),
                    ))
                }
            }
        })
    }

    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let this = Graphs {
            service: self.service.clone(),
            place: self.place,
        };
        Box::pin(async move {
            match submission.action.as_str() {
                "authorize" => {
                    let Some(grant) = submission.grant else {
                        let session = cx.session()?.to_owned();
                        return Ok(Reply::Consent {
                            request: maka_plugins::authorization::Request {
                                operation_id: uuid::Uuid::new_v4(),
                                title: "Let the agent graph run in this session".into(),
                                target: maka_plugins::authorization::Target::Session {
                                    session_id: session,
                                },
                                capabilities: [maka_plugins::authorization::Capability::Executions]
                                    .into(),
                            },
                        });
                    };
                    call(
                        &this.service,
                        Call::Authorize,
                        json!({"kind":"remember","id":grant}),
                        cx.caller,
                    )
                    .await?;
                    Ok(Reply::Applied { route: Value::Null })
                }
                "stop" => {
                    let graph = submission
                        .revision
                        .rsplit_once(':')
                        .map(|(graph, _)| graph.to_owned())
                        .filter(|graph| graph != "none")
                        .ok_or_else(|| invalid("No graph to stop"))?;
                    call(
                        &this.service,
                        Call::Stop,
                        json!({"graphId":graph}),
                        cx.caller,
                    )
                    .await?;
                    Ok(Reply::Applied {
                        route: submission.route,
                    })
                }
                _ => Err(invalid("Unknown graph action")),
            }
        })
    }
}

fn ask(words: &Words) -> View {
    view(
        words,
        "ask".into(),
        vec![view::build::action("authorize", words.t("Allow", "允许", "允許"))],
        column(
            "root",
            vec![
                text(
                    "why",
                    words.t(
                        "This session plans work across agents. Allow it to show and steer that work here.",
                        "这个会话会把工作分给多个智能体。允许后可在这里查看和控制这些工作。",
                        "這個工作階段會把工作分給多個智慧體。允許後可在這裡查看和控制這些工作。",
                    ),
                    Tone::Muted,
                ),
                row("allow", vec![button("allow", "authorize", Role::Primary)]),
            ],
        ),
    )
}

/// One graph: how far it has come, what it is doing, and every piece of work.
fn panel(words: &Words, graph: Option<&Graph>, earlier: bool, after: Option<&Cursor>) -> View {
    let Some(graph) = graph else {
        let mut children = vec![text(
            "empty",
            words.t(
                "No work planned yet. When the agent splits a task, each piece appears here.",
                "还没有计划的工作。智能体拆分任务后，每一项都会出现在这里。",
                "還沒有計畫的工作。智慧體拆分任務後，每一項都會出現在這裡。",
            ),
            Tone::Muted,
        )];
        if earlier {
            children.push(
                link(
                    "earlier",
                    words.t("Earlier graphs", "更早的图", "更早的圖"),
                    json!({"kind":"earlier","before":null}),
                )
                .into(),
            );
        }
        return view(words, "none:0".into(), vec![], column("root", children));
    };
    let (finished, total) = (done(graph), graph.work.len());
    let paged = after.is_some() || graph.next_after.is_some();
    let mode = if graph.epoch.mode == "swarm" {
        words.t("Swarm", "蜂群", "蜂群")
    } else {
        words.t("Graph", "图", "圖")
    };
    let graph_state = if graph.finished {
        (words.t("Finished", "已结束", "已結束"), Tone::Success)
    } else if graph.stop_requested {
        (words.t("Stopping", "正在停止", "正在停止"), Tone::Warning)
    } else {
        (words.t("Working", "进行中", "進行中"), Tone::Accent)
    };
    let mut children = vec![
        spans(
            "heading",
            vec![
                (format!("{mode} #{}", graph.epoch.epoch), Tone::Strong),
                ("  ·  ".into(), Tone::Subtle),
                (graph_state.0, graph_state.1),
            ],
        ),
        progress(
            "progress",
            finished as u64,
            total.max(1) as u64,
            if paged {
                words.t(
                    &format!("Page {finished}/{total}"),
                    &format!("本页 {finished}/{total}"),
                    &format!("本頁 {finished}/{total}"),
                )
            } else {
                words.t(
                    &format!("{finished} of {total}"),
                    &format!("{finished}/{total}"),
                    &format!("{finished}/{total}"),
                )
            },
        ),
    ];
    if paged {
        children.push(text(
            "total",
            words.t(
                &format!("{} work items", graph.total_work),
                &format!("共 {} 项工作", graph.total_work),
                &format!("共 {} 項工作", graph.total_work),
            ),
            Tone::Muted,
        ));
    }
    let items: Vec<Node> = graph
        .work
        .iter()
        .map(|work| {
            let (label, tone) = state(words, work);
            link(
                format!("work-{}", work.work_id).replace('/', ":"),
                first_line(&work.instruction),
                Reading {
                    graph: graph.epoch.graph_id.clone(),
                    work: work.work_id.clone(),
                    result: work
                        .execution
                        .as_ref()
                        .and_then(|execution| execution.result_record_id.clone()),
                    after: after.cloned(),
                    instruction_offset: 0,
                    result_offset: 0,
                }
                .route(),
            )
            .meta(label)
            .tone(tone)
            .into()
        })
        .collect();
    if !items.is_empty() {
        children.push(scroll("work", 16, stack("list", items)));
    }
    if let Some(next) = &graph.next_after {
        children.push(
            link(
                "next",
                words.t("Next work items", "下一页工作", "下一頁工作"),
                json!({"kind":"graph","graph":graph.epoch.graph_id,"after":next}),
            )
            .into(),
        );
    }
    if after.is_some() {
        children.push(
            link(
                "first",
                words.t("First work items", "第一页工作", "第一頁工作"),
                json!({"kind":"graph","graph":graph.epoch.graph_id}),
            )
            .into(),
        );
    }
    let mut actions = vec![];
    if !graph.finished && !graph.stop_requested {
        actions.push(Action {
            confirm: Some(Confirm {
                title: words.t("Stop this graph?", "停止这个图？", "停止這個圖？"),
                message: words.t(
                    "No new work starts. Work already running may still finish.",
                    "不会再开始新的工作。正在运行的工作仍可能完成。",
                    "不會再開始新的工作。正在執行的工作仍可能完成。",
                ),
                destructive: true,
            }),
            ..view::build::action("stop", words.t("Stop", "停止", "停止"))
        });
        children.push(row(
            "controls",
            vec![button("stop", "stop", Role::Destructive)],
        ));
    }
    if earlier {
        children.push(
            link(
                "earlier",
                words.t("Earlier graphs", "更早的图", "更早的圖"),
                json!({"kind":"earlier","before":null}),
            )
            .into(),
        );
    }
    view(
        words,
        format!("{}:{}", graph.epoch.graph_id, graph.revision),
        actions,
        column("root", children),
    )
}

/// While a graph works: how far it has come.
fn line(words: &Words, graph: Option<&Graph>) -> View {
    let children = match graph.filter(|graph| !graph.finished) {
        Some(graph) => {
            let running = graph
                .work
                .iter()
                .filter(|work| {
                    work.execution
                        .as_ref()
                        .is_some_and(|execution| execution.state == "running")
                })
                .count();
            vec![
                text(
                    "count",
                    if graph.next_after.is_some() {
                        words.t(
                            &format!(
                                "{}/{} shown · {} total",
                                done(graph),
                                graph.work.len(),
                                graph.total_work
                            ),
                            &format!(
                                "本页 {}/{} · 共 {} 项",
                                done(graph),
                                graph.work.len(),
                                graph.total_work
                            ),
                            &format!(
                                "本頁 {}/{} · 共 {} 項",
                                done(graph),
                                graph.work.len(),
                                graph.total_work
                            ),
                        )
                    } else {
                        format!("{}/{}", done(graph), graph.work.len())
                    },
                    Tone::Muted,
                ),
                text(
                    "running",
                    if graph.next_after.is_some() {
                        words.t(
                            &format!("{running} shown running"),
                            &format!("本页 {running} 个运行中"),
                            &format!("本頁 {running} 個執行中"),
                        )
                    } else {
                        words.t(
                            &format!("{running} running"),
                            &format!("{running} 个运行中"),
                            &format!("{running} 個執行中"),
                        )
                    },
                    Tone::Accent,
                ),
            ]
        }
        None => vec![],
    };
    view(words, "line".into(), vec![], row("root", children))
}

fn earlier(words: &Words, epochs: &Epochs) -> View {
    let mut rows: Vec<Node> = epochs
        .epochs
        .iter()
        .map(|epoch| {
            let mode = if epoch.mode == "swarm" {
                words.t("Swarm", "蜂群", "蜂群")
            } else {
                words.t("Graph", "图", "圖")
            };
            link(
                format!("graph-{}", epoch.epoch),
                format!("{mode} #{}", epoch.epoch),
                json!({"kind":"graph","graph":epoch.graph_id}),
            )
            .current(epochs.current_epoch == Some(epoch.epoch))
            .into()
        })
        .collect();
    if let Some(before) = epochs.next_before {
        rows.push(
            link(
                "older",
                words.t("Older", "更早", "更早"),
                json!({"kind":"earlier","before":before}),
            )
            .into(),
        );
    }
    view(
        words,
        "earlier".into(),
        vec![],
        column("root", vec![stack("graphs", rows)]),
    )
}

fn detail_view(
    words: &Words,
    reading: &Reading,
    work: Option<&Work>,
    detail: Option<&Detail>,
    answer: Option<&Page>,
) -> View {
    let mut children = vec![];
    if let Some(work) = work {
        let (label, tone) = state(words, work);
        children.push(text("state", label, tone));
        if let Some(execution) = &work.execution {
            children.push(Node::Item {
                key: "session".into(),
                title: words.t(
                    "Open the agent's session",
                    "打开该智能体的会话",
                    "開啟該智慧體的工作階段",
                ),
                detail: String::new(),
                meta: String::new(),
                tone: Tone::Normal,
                current: false,
                target: view::Target::Session {
                    session: execution.session_id.clone(),
                },
            });
        }
    }
    if let Some(detail) = detail {
        let mut instruction = vec![
            text(
                "label",
                words.t("Instruction", "指令", "指令"),
                Tone::Subtle,
            ),
            markdown("text", clean(&detail.instruction, true)),
        ];
        instruction.extend(page_links(
            words,
            reading,
            false,
            detail.offset,
            detail.instruction.len(),
            detail.total_bytes,
            detail.next_offset,
        ));
        children.push(stack("instruction", instruction));
    } else {
        children.push(text(
            "missing",
            words.t(
                "Work is no longer available.",
                "工作已不可用。",
                "工作已無法使用。",
            ),
            Tone::Muted,
        ));
    }
    if let Some(answer) = answer {
        let mut result = vec![
            text("label", words.t("Result", "结果", "結果"), Tone::Subtle),
            markdown("text", clean(&answer.text, true)),
        ];
        result.extend(page_links(
            words,
            reading,
            true,
            answer.offset,
            answer.text.len(),
            answer.total_bytes,
            answer.next_offset,
        ));
        children.push(stack("answer", result));
    } else if work.is_some() {
        children.push(text(
            "pending",
            words.t("No result yet.", "还没有结果。", "還沒有結果。"),
            Tone::Muted,
        ));
    }
    view(
        words,
        "work".into(),
        vec![],
        scroll("root", 40, column("body", children)),
    )
}

/// Back navigation restores the preceding route; these links retain only the
/// current offsets, never a growing copy of all visited pages or their text.
fn page_links(
    words: &Words,
    reading: &Reading,
    result: bool,
    offset: usize,
    length: usize,
    total: usize,
    next: Option<usize>,
) -> Vec<Node> {
    if offset == 0 && next.is_none() {
        return vec![];
    }
    let mut links = vec![text(
        "range",
        words.t(
            &format!("Bytes {offset}–{} of {total}", offset + length),
            &format!("字节 {offset}–{}，共 {total}", offset + length),
            &format!("位元組 {offset}–{}，共 {total}", offset + length),
        ),
        Tone::Subtle,
    )];
    for (key, target, label) in [
        (
            "next",
            next,
            if result {
                words.t("Next result page", "下一页结果", "下一頁結果")
            } else {
                words.t("Next instruction page", "下一页指令", "下一頁指令")
            },
        ),
        (
            "first",
            (offset > 0).then_some(0),
            if result {
                words.t("Result from start", "从头阅读结果", "從頭閱讀結果")
            } else {
                words.t("Instruction from start", "从头阅读指令", "從頭閱讀指令")
            },
        ),
    ] {
        if let Some(target) = target {
            let mut page = reading.clone();
            if result {
                page.result_offset = target;
            } else {
                page.instruction_offset = target;
            }
            links.push(link(key, label, page.route()).into());
        }
    }
    links
}

fn restart(words: &Words, graph: &str) -> View {
    view(
        words,
        "changed".into(),
        vec![],
        column(
            "root",
            vec![
                text(
                    "changed",
                    words.t(
                        "This work page changed. Reopen the graph to read its current work items.",
                        "工作页已变化。请重新打开图以查看当前工作。",
                        "工作頁已變更。請重新開啟圖以查看目前工作。",
                    ),
                    Tone::Muted,
                ),
                link(
                    "restart",
                    words.t("Reopen graph", "重新打开图", "重新開啟圖"),
                    json!({"kind":"graph","graph":graph}),
                )
                .into(),
            ],
        ),
    )
}

/// Subagent presets: which agents the graph may start, and how each runs.
struct Presets(Arc<Service>);

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Preset {
    id: String,
    name: String,
    description: String,
    profile: String,
    connection_slug: String,
    model: String,
    thinking_level: Option<Value>,
    enabled: bool,
}
#[derive(Deserialize)]
struct Presetting {
    revision: Option<u64>,
    presets: Vec<Preset>,
}

impl Presets {
    async fn read(&self, caller: &Caller) -> Result<Presetting, Error> {
        decode(
            call(
                &self.0,
                Call::Settings,
                json!({"kind":"read"}),
                caller.clone(),
            )
            .await?,
        )
    }
}

fn profiles(words: &Words) -> Vec<(String, String)> {
    vec![
        (
            "local_read".into(),
            words.t("Read the workspace", "读取工作区", "讀取工作區"),
        ),
        (
            "web_research".into(),
            words.t("Research the web", "网络调研", "網路調研"),
        ),
        (
            "implementation".into(),
            words.t("Change the workspace", "修改工作区", "修改工作區"),
        ),
    ]
}

impl App for Presets {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let this = Presets(self.0.clone());
        Box::pin(async move {
            let words = &cx.words;
            let snapshot = this.read(&cx.caller).await?;
            let revision = snapshot
                .revision
                .map_or_else(|| "0".into(), |r| r.to_string());
            let title = words.t("Subagents", "子智能体", "子智慧體");
            if let Some(id) = route.get("preset") {
                let preset = id
                    .as_str()
                    .and_then(|id| snapshot.presets.iter().find(|preset| preset.id == id));
                return Ok(editor(words, revision, preset));
            }
            let mut rows: Vec<Node> = vec![text(
                "intro",
                words.t(
                    "Agents the graph may start, each with a model and what it may do.",
                    "图可以启动的智能体，每个都有自己的模型和权限。",
                    "圖可以啟動的智慧體，每個都有自己的模型和權限。",
                ),
                Tone::Muted,
            )];
            for preset in &snapshot.presets {
                let (profile, _) = profiles(words)
                    .into_iter()
                    .map(|(value, label)| (label, value))
                    .find(|(_, value)| *value == preset.profile)
                    .unwrap_or_default();
                rows.push(
                    link(
                        format!("preset-{}", preset.id).replace('/', ":"),
                        clean(&preset.name, false),
                        json!({"preset": preset.id}),
                    )
                    .detail(format!("{} · {}", clean(&preset.model, false), profile))
                    .meta(if preset.enabled {
                        words.t("On", "开", "開")
                    } else {
                        words.t("Off", "关", "關")
                    })
                    .tone(if preset.enabled {
                        Tone::Normal
                    } else {
                        Tone::Muted
                    })
                    .into(),
                );
            }
            rows.push(
                link(
                    "add",
                    words.t("Add a subagent", "添加子智能体", "新增子智慧體"),
                    json!({"preset": null}),
                )
                .into(),
            );
            Ok(View {
                version: VERSION,
                title,
                revision,
                fields: vec![],
                actions: vec![],
                root: column("root", rows),
            })
        })
    }

    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let this = Presets(self.0.clone());
        Box::pin(async move {
            let snapshot = this.read(&cx.caller).await?;
            let revision = snapshot
                .revision
                .map_or_else(|| "0".into(), |r| r.to_string());
            if revision != submission.revision {
                return Ok(Reply::Conflict);
            }
            let original = submission
                .route
                .get("preset")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mut presets = snapshot.presets;
            match submission.action.as_str() {
                "delete" => {
                    let id = original.ok_or_else(|| invalid("No preset"))?;
                    presets.retain(|preset| preset.id != id);
                }
                "save" => {
                    let preset = Preset {
                        id: original
                            .clone()
                            .unwrap_or_else(|| format!("preset-{}", uuid::Uuid::new_v4().simple())),
                        name: submission.text("name")?.trim().to_owned(),
                        description: submission.text("description")?.trim().to_owned(),
                        profile: submission.text("profile")?.to_owned(),
                        connection_slug: submission.text("connection")?.trim().to_owned(),
                        model: submission.text("model")?.trim().to_owned(),
                        thinking_level: original
                            .as_ref()
                            .and_then(|id| presets.iter().find(|preset| &preset.id == id))
                            .and_then(|preset| preset.thinking_level.clone()),
                        enabled: submission.toggle("enabled")?,
                    };
                    match presets.iter_mut().find(|item| item.id == preset.id) {
                        Some(item) => *item = preset,
                        None => presets.push(preset),
                    }
                }
                _ => return Err(invalid("Unknown preset action")),
            }
            let replaced = call(
                &this.0,
                Call::Settings,
                json!({"kind":"replace","snapshot":{"revision":snapshot.revision,"presets":presets}}),
                cx.caller,
            )
            .await;
            match replaced {
                Ok(_) => Ok(Reply::Applied { route: Value::Null }),
                Err(Error::Invalid(message) | Error::Provider(message)) => Ok(Reply::Rejected {
                    message: view::build::clean(&message, false)
                        .chars()
                        .take(256)
                        .collect(),
                }),
                Err(error) => Err(error),
            }
        })
    }
}

fn editor(words: &Words, revision: String, preset: Option<&Preset>) -> View {
    let value =
        |get: fn(&Preset) -> &str| preset.map_or_else(String::new, |preset| get(preset).to_owned());
    let fields = vec![
        view::build::line("name", value(|preset| &preset.name), 512),
        view::build::area("description", value(|preset| &preset.description), 4000),
        choice(
            "profile",
            preset.map_or_else(|| "local_read".to_owned(), |preset| preset.profile.clone()),
            profiles(words),
        ),
        view::build::line("connection", value(|preset| &preset.connection_slug), 128),
        view::build::line("model", value(|preset| &preset.model), 256),
        toggle("enabled", preset.is_none_or(|preset| preset.enabled)),
    ];
    let names = [
        "name",
        "description",
        "profile",
        "connection",
        "model",
        "enabled",
    ];
    let mut actions = vec![Action {
        fields: names.iter().map(|name| (*name).to_owned()).collect(),
        ..view::build::action("save", words.t("Save", "保存", "儲存"))
    }];
    let mut buttons = vec![button("save", "save", Role::Primary)];
    if preset.is_some() {
        actions.push(Action {
            confirm: Some(Confirm {
                title: words.t(
                    "Remove this subagent?",
                    "移除这个子智能体？",
                    "移除這個子智慧體？",
                ),
                message: words.t(
                    "Graphs stop starting it. Work it already did stays.",
                    "图将不再启动它。它已完成的工作会保留。",
                    "圖將不再啟動它。它已完成的工作會保留。",
                ),
                destructive: true,
            }),
            ..view::build::action("delete", words.t("Remove", "移除", "移除"))
        });
        buttons.push(button("delete", "delete", Role::Destructive));
    }
    let label = |en: &str, zh_cn: &str, zh_tw: &str| words.t(en, zh_cn, zh_tw);
    View {
        version: VERSION,
        title: preset.map_or_else(
            || label("New subagent", "新建子智能体", "新增子智慧體"),
            |preset| clean(&preset.name, false),
        ),
        revision,
        fields,
        actions,
        root: column(
            "root",
            vec![
                stack(
                    "form",
                    vec![
                        input("name", "name", label("Name", "名称", "名稱")),
                        input(
                            "description",
                            "description",
                            label("Description", "说明", "說明"),
                        ),
                        input("profile", "profile", label("May", "权限", "權限")),
                        input(
                            "connection",
                            "connection",
                            label("Connection", "连接", "連線"),
                        ),
                        input("model", "model", label("Model", "模型", "模型")),
                        input("enabled", "enabled", label("Enabled", "启用", "啟用")),
                    ],
                ),
                row("controls", buttons),
            ],
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph(states: &[&str]) -> Graph {
        Graph {
            epoch: Epoch {
                epoch: 3,
                graph_id: "agent_graph_fixture".into(),
                mode: "graph".into(),
            },
            revision: 5,
            stop_requested: false,
            finished: false,
            total_work: states.len(),
            next_after: None,
            work: states
                .iter()
                .enumerate()
                .map(|(index, state)| Work {
                    work_id: format!("graph_work_{index}"),
                    instruction: format!("Step {index}\nmore detail"),
                    status: "requested".into(),
                    execution: Some(Execution {
                        session_id: format!("agent-{index}"),
                        state: (*state).into(),
                        result_record_id: None,
                    }),
                })
                .collect(),
        }
    }

    #[test]
    fn localized_work_states_need_no_glyph_and_preserve_instructions() {
        let instruction = "指令 ✓ ◐ ◇ × ○ 😀";
        for (state, labels, tone) in [
            ("completed", ["Done", "完成", "完成"], Tone::Success),
            ("running", ["Running", "运行中", "執行中"], Tone::Accent),
            ("waiting", ["Waiting", "等待", "等待"], Tone::Warning),
            ("blocked", ["Blocked", "受阻", "受阻"], Tone::Error),
            ("failed", ["Failed", "失败", "失敗"], Tone::Error),
            ("cancelled", ["Stopped", "已停止", "已停止"], Tone::Muted),
            ("superseded", ["Replaced", "已替换", "已替換"], Tone::Muted),
            ("requested", ["Queued", "排队中", "排隊中"], Tone::Subtle),
        ] {
            let mut working = graph(&[state]);
            working.work[0].instruction = instruction.into();
            let reading = Reading {
                graph: working.epoch.graph_id.clone(),
                work: working.work[0].work_id.clone(),
                result: None,
                after: None,
                instruction_offset: 0,
                result_offset: 0,
            };
            let detail = Detail {
                instruction: instruction.into(),
                offset: 0,
                total_bytes: instruction.len(),
                next_offset: None,
            };
            for (locale, label) in ["en", "zh-CN", "zh-TW"].into_iter().zip(labels) {
                let words = Words::new(locale);
                let view = panel(&words, Some(&working), false, None);
                view.validate().unwrap();
                let list = view
                    .root
                    .children()
                    .into_iter()
                    .find(|node| node.key() == "work")
                    .unwrap();
                let Node::Item {
                    title,
                    meta,
                    tone: item_tone,
                    ..
                } = list.children()[0].children()[0]
                else {
                    panic!("graph work item");
                };
                assert_eq!(title, instruction);
                assert_eq!(meta, label);
                assert_eq!(*item_tone, tone);
                let view = detail_view(&words, &reading, working.work.first(), Some(&detail), None);
                view.validate().unwrap();
                let Node::Text { spans, .. } = view.root.children()[0].children()[0] else {
                    panic!("graph work state");
                };
                assert_eq!(spans.len(), 1);
                assert_eq!(spans[0].text, label);
                assert_eq!(spans[0].tone, tone);
                assert!(serde_json::to_string(&view).unwrap().contains(instruction));
            }
        }
    }

    #[test]
    fn a_running_graph_lists_its_work_and_asks_before_stopping() {
        let words = Words::new("en");
        let working = graph(&["completed", "running", "requested"]);
        let view = panel(&words, Some(&working), true, None);
        view.validate().unwrap();
        let text = serde_json::to_string(&view).unwrap();
        assert!(
            text.contains("Graph #3") && text.contains("1 of 3") && text.contains("Earlier graphs")
        );
        assert!(
            view.action("stop")
                .unwrap()
                .confirm
                .as_ref()
                .unwrap()
                .destructive
        );
        let status = line(&words, Some(&working));
        status.validate().unwrap();
        assert!(
            serde_json::to_string(&status)
                .unwrap()
                .contains("1 running")
        );
        panel(&words, None, false, None).validate().unwrap();
        ask(&words).validate().unwrap();
        let reading = Reading {
            graph: "agent_graph_fixture".into(),
            work: "graph_work_0".into(),
            result: None,
            after: None,
            instruction_offset: 0,
            result_offset: 0,
        };
        detail_view(&words, &reading, working.work.first(), None, None)
            .validate()
            .unwrap();
    }

    #[test]
    fn work_and_text_pages_keep_exact_identity_and_independent_byte_cursors() {
        let cursor: Cursor = decode(json!({"revision":5,"workId":"graph_work_15"})).unwrap();
        let mut working = graph(&["completed"; 16]);
        working.total_work = 17;
        working.next_after = Some(cursor.clone());
        let reading = Reading {
            graph: "agent_graph_full_identity".into(),
            work: "graph_work_full_identity".into(),
            result: Some("full-result-identity".into()),
            after: Some(cursor),
            instruction_offset: 0,
            result_offset: 0,
        };
        fn route(node: &Node, key: &str) -> Option<Value> {
            if node.key() == key
                && let Node::Item {
                    target: view::Target::Route { route },
                    ..
                } = node
            {
                return Some(route.clone());
            }
            node.children()
                .into_iter()
                .find_map(|child| route(child, key))
        }
        for locale in ["en", "zh-CN", "zh-TW"] {
            let words = Words::new(locale);
            let page = panel(&words, Some(&working), false, None);
            page.validate().unwrap();
            let next = route(&page.root, "next").unwrap();
            assert_eq!(next["after"]["workId"], "graph_work_15");
            assert!(matches!(
                decode::<Route>(next).unwrap(),
                Route::Graph { after: Some(_), .. }
            ));
            line(&words, Some(&working)).validate().unwrap();
            let detail = Detail {
                instruction: "中".repeat(2730),
                offset: 0,
                total_bytes: 20000,
                next_offset: Some(8190),
            };
            let answer = Page {
                text: "😀".repeat(1024),
                offset: 0,
                total_bytes: 12000,
                next_offset: Some(4096),
            };
            let page = detail_view(
                &words,
                &reading,
                working.work.first(),
                Some(&detail),
                Some(&answer),
            );
            page.validate().unwrap(); // Both sections have next links with distinct full node paths.
            let body = page.root.children()[0];
            for (section, changed, expected) in [
                ("instruction", "instruction_offset", 8190),
                ("answer", "result_offset", 4096),
            ] {
                let section = body
                    .children()
                    .into_iter()
                    .find(|node| node.key() == section)
                    .unwrap();
                let next = route(section, "next").unwrap();
                assert_eq!(next[changed], expected);
                assert_eq!(
                    next[if changed == "instruction_offset" {
                        "result_offset"
                    } else {
                        "instruction_offset"
                    }],
                    0
                );
                assert_eq!(next["graph"], reading.graph);
                assert_eq!(next["work"], reading.work);
                assert_eq!(next["result"], json!(reading.result));
                assert_eq!(next["after"], reading.route()["after"]);
                assert!(matches!(decode::<Route>(next).unwrap(), Route::Work(_)));
            }
            restart(&words, &reading.graph).validate().unwrap();
        }
        let encoded =
            serde_json::to_string(&panel(&Words::new("en"), Some(&working), false, None)).unwrap();
        assert!(encoded.contains("Page 16/16") && encoded.contains("17 work items"));
    }

    #[test]
    fn a_preset_form_edits_every_setting_and_removal_asks_first() {
        let words = Words::new("en");
        let preset = Preset {
            id: "reviewer".into(),
            name: "Reviewer".into(),
            description: "Reads diffs".into(),
            profile: "local_read".into(),
            connection_slug: "openai".into(),
            model: "gpt".into(),
            thinking_level: None,
            enabled: true,
        };
        let view = editor(&words, "1".into(), Some(&preset));
        view.validate().unwrap();
        assert_eq!(view.fields.len(), 6);
        assert!(view.action("delete").unwrap().confirm.is_some());
        editor(&words, "1".into(), None).validate().unwrap();
    }
}
