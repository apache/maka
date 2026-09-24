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

//! Conversation import as a settings category: where other tools keep
//! their conversations, a browser over each, and bringing one into Maka as
//! a new session in a folder of your choice. The endpoint requires Host
//! path access, as the handler it speaks to does.

use crate::remote::Import;
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
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) fn publish(
    backend: Arc<Import>,
    package: &str,
    staged: &mut Staged,
) -> Result<(), String> {
    let endpoint = app::endpoint(
        Importing(backend),
        Descriptor::new(
            Text::localized("Conversation import", "导入对话", "匯入對話"),
            Context::Application,
        )
        .placement(Placement::Settings)
        .icon("⇣", "I")
        .order(35),
    )
    .map_err(|error| error.to_string())?
    .requiring_host_paths();
    staged
        .insert(
            key(package, "terminal").map_err(|error| error.to_string())?,
            endpoint,
        )
        .map_err(|error| error.to_string())
}

struct Importing(Arc<Import>);

#[derive(Deserialize)]
struct Sourced {
    snapshot: Sources,
}
#[derive(Deserialize)]
struct Sources {
    revision: Option<u64>,
    configuration: Configuration,
}
#[derive(Clone, Default, Deserialize, Serialize)]
struct Configuration {
    sources: Vec<Source>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Source {
    id: uuid::Uuid,
    name: String,
    location: Location,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Location {
    Codex { root: String },
    ClaudeCode { root: String },
    OpenCode { database: String },
}
impl Location {
    fn kind(&self) -> &'static str {
        match self {
            Self::Codex { .. } => "codex",
            Self::ClaudeCode { .. } => "claude_code",
            Self::OpenCode { .. } => "open_code",
        }
    }
    fn path(&self) -> &str {
        match self {
            Self::Codex { root } | Self::ClaudeCode { root } => root,
            Self::OpenCode { database } => database,
        }
    }
}
#[derive(Deserialize)]
struct Cataloged {
    page: Catalog,
}
#[derive(Deserialize)]
struct Catalog {
    entries: Vec<Entry>,
    next: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    path: String,
    title: String,
    cwd: Option<String>,
    archived: bool,
}
#[derive(Deserialize)]
struct Copied {
    page: Copies,
}
#[derive(Deserialize)]
struct Copies {
    copies: Vec<Copy>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Copy {
    operation_id: uuid::Uuid,
    source_name: String,
    title: String,
    records: usize,
    receipt: Option<Value>,
}
#[derive(Deserialize)]
struct Modeled {
    choices: Choices,
}
#[derive(Deserialize)]
struct Choices {
    models: Vec<Choice>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choice {
    model: Value,
    display_name: String,
    connection_name: String,
    default_thinking_level: Option<Value>,
    is_default: bool,
}
impl Choice {
    /// A stable identity for the choice, from what it binds.
    fn id(&self) -> String {
        let part = |name: &str| {
            self.model
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        format!("{}:{}", part("connectionSlug"), part("model"))
    }
}

/// Where the category is: the sources, one source's conversations, one
/// conversation to import, a source to edit, or a copy to settle.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Route {
    Browse {
        source: uuid::Uuid,
        text: String,
        cursor: Option<String>,
    },
    Import {
        source: uuid::Uuid,
        entry: Entry,
    },
    Edit {
        source: Option<uuid::Uuid>,
    },
    Copy {
        operation: uuid::Uuid,
    },
}

fn failed(error: impl std::fmt::Display) -> Error {
    Error::Provider(error.to_string())
}
fn clean(value: &str) -> String {
    view::build::clean(value, false)
}
fn stamp(sources: &Sources) -> String {
    sources.revision.unwrap_or(0).to_string()
}
fn rejected(error: Error) -> Result<Reply, Error> {
    match error {
        Error::Invalid(message) | Error::Provider(message) => Ok(Reply::Rejected {
            message: clean(&message).chars().take(256).collect(),
        }),
        error => Err(error),
    }
}

impl Importing {
    async fn call<T: for<'de> Deserialize<'de>>(
        &self,
        input: Value,
        caller: &Caller,
    ) -> Result<T, Error> {
        let value = self.0.call(input, caller.clone()).await?;
        if value.get("kind").and_then(Value::as_str) == Some("conflict") {
            return Err(Error::Provider(
                "The import changed underneath; refresh".into(),
            ));
        }
        serde_json::from_value(value).map_err(failed)
    }
    async fn sources(&self, caller: &Caller) -> Result<Sources, Error> {
        Ok(self
            .call::<Sourced>(json!({"kind":"sources"}), caller)
            .await?
            .snapshot)
    }
}

impl App for Importing {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let this = Importing(self.0.clone());
        Box::pin(async move {
            let words = &cx.words;
            let sources = this.sources(&cx.caller).await?;
            if route.is_null() {
                let copies: Copied = this
                    .call(json!({"kind":"copies","after":null}), &cx.caller)
                    .await?;
                return Ok(home(words, &sources, &copies.page.copies));
            }
            match serde_json::from_value::<Route>(route)
                .map_err(|error| Error::Invalid(error.to_string()))?
            {
                Route::Browse {
                    source,
                    text,
                    cursor,
                } => {
                    let found = sources
                        .configuration
                        .sources
                        .iter()
                        .find(|item| item.id == source);
                    let catalog = match found {
                        Some(_) => {
                            let cataloged: Cataloged = this
                                .call(
                                    json!({"kind":"catalog","sourceId":source,"revision":sources.revision.unwrap_or(0),
                                        "query":{"text":text,"includeArchived":false,"limit":20,"cursor":cursor}}),
                                    &cx.caller,
                                )
                                .await?;
                            Some(cataloged.page)
                        }
                        None => None,
                    };
                    Ok(browse(words, &sources, found, &text, catalog.as_ref()))
                }
                Route::Import { source, entry } => {
                    let models: Modeled = this
                        .call(json!({"kind":"models","query":{"query":""}}), &cx.caller)
                        .await?;
                    Ok(import(
                        words,
                        &sources,
                        source,
                        &entry,
                        &models.choices.models,
                    ))
                }
                Route::Edit { source } => {
                    let found = source.and_then(|id| {
                        sources
                            .configuration
                            .sources
                            .iter()
                            .find(|item| item.id == id)
                    });
                    Ok(edit(words, &sources, found))
                }
                Route::Copy { operation } => {
                    let copies: Copied = this
                        .call(json!({"kind":"copies","after":null}), &cx.caller)
                        .await?;
                    let copy = copies
                        .page
                        .copies
                        .iter()
                        .find(|copy| copy.operation_id == operation);
                    Ok(settle(words, &sources, copy))
                }
            }
        })
    }

    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let this = Importing(self.0.clone());
        Box::pin(async move {
            let sources = this.sources(&cx.caller).await?;
            if stamp(&sources) != submission.revision {
                return Ok(Reply::Conflict);
            }
            let route: Option<Route> = serde_json::from_value(submission.route.clone()).ok();
            match (submission.action.as_str(), route) {
                ("search", Some(Route::Browse { source, .. })) => Ok(Reply::Applied {
                    route: json!({"kind":"browse","source":source,"text":submission.text("text")?.trim(),"cursor":null}),
                }),
                ("import", Some(Route::Import { source, entry })) => {
                    let destination = submission.text("destination")?.trim().to_owned();
                    if destination.is_empty() {
                        return Ok(Reply::Rejected {
                            message: cx.t(
                                "Choose the folder the session works in.",
                                "请选择会话的工作目录。",
                                "請選擇工作階段的工作目錄。",
                            ),
                        });
                    }
                    let models: Modeled = this
                        .call(json!({"kind":"models","query":{"query":""}}), &cx.caller)
                        .await?;
                    let choice = submission.text("model")?;
                    let Some(model) = models
                        .choices
                        .models
                        .iter()
                        .find(|item| item.id() == choice)
                    else {
                        return Ok(Reply::Conflict);
                    };
                    let operation = uuid::Uuid::new_v4();
                    let request = json!({
                        "operationId": operation,
                        "selection": {"sourceId": source, "sourceRevision": sources.revision.unwrap_or(0),
                            "sessionId": entry.id, "path": entry.path},
                        "workspace": {"kind":"host_path","path":destination},
                        "settings": {
                            "target": {"kind":"model","model":model.model,"thinkingLevel":model.default_thinking_level},
                            "sandboxMode": submission.text("sandbox")?,
                            "approvalPolicy": {"kind":"on-request"},
                            "collaborationMode": "agent",
                            "behavior": "default"
                        }
                    });
                    if let Err(error) = this
                        .call::<Value>(json!({"kind":"prepare","request":request}), &cx.caller)
                        .await
                    {
                        return rejected(error);
                    }
                    match this
                        .call::<Value>(
                            json!({"kind":"deliver","operationId":operation}),
                            &cx.caller,
                        )
                        .await
                    {
                        Ok(_) => Ok(Reply::Applied { route: Value::Null }),
                        // Prepared but not delivered: the copy waits among the others.
                        Err(error) => rejected(error),
                    }
                }
                (action @ ("deliver" | "abandon"), Some(Route::Copy { operation })) => {
                    match this
                        .call::<Value>(json!({"kind":action,"operationId":operation}), &cx.caller)
                        .await
                    {
                        Ok(_) => Ok(Reply::Applied { route: Value::Null }),
                        Err(error) => rejected(error),
                    }
                }
                (action @ ("save" | "remove"), Some(Route::Edit { source })) => {
                    let mut configuration = sources.configuration.clone();
                    if action == "remove" {
                        configuration.sources.retain(|item| Some(item.id) != source);
                    } else {
                        let path = submission.text("path")?.trim().to_owned();
                        let location = match submission.text("kind")? {
                            "codex" => Location::Codex { root: path },
                            "claude_code" => Location::ClaudeCode { root: path },
                            _ => Location::OpenCode { database: path },
                        };
                        let item = Source {
                            id: source.unwrap_or_else(uuid::Uuid::new_v4),
                            name: submission.text("name")?.trim().to_owned(),
                            location,
                        };
                        match configuration
                            .sources
                            .iter_mut()
                            .find(|existing| existing.id == item.id)
                        {
                            Some(existing) => *existing = item,
                            None => configuration.sources.push(item),
                        }
                    }
                    match this
                        .call::<Value>(
                            json!({"kind":"save_sources","expectedRevision":sources.revision,"configuration":configuration}),
                            &cx.caller,
                        )
                        .await
                    {
                        Ok(_) => Ok(Reply::Applied { route: Value::Null }),
                        Err(error) => rejected(error),
                    }
                }
                _ => Err(Error::Invalid("Unknown import action".into())),
            }
        })
    }
}

fn kinds(words: &Words) -> Vec<(String, String)> {
    vec![
        ("codex".into(), "Codex".into()),
        ("claude_code".into(), "Claude Code".into()),
        (
            "open_code".into(),
            words.t("OpenCode database", "OpenCode 数据库", "OpenCode 資料庫"),
        ),
    ]
}
fn kind_label(words: &Words, location: &Location) -> String {
    kinds(words)
        .into_iter()
        .find(|(kind, _)| kind == location.kind())
        .map(|(_, label)| label)
        .unwrap_or_default()
}
fn view_of(
    title: String,
    sources: &Sources,
    fields: Vec<view::Field>,
    actions: Vec<Action>,
    root: Node,
) -> View {
    View {
        version: VERSION,
        title,
        revision: stamp(sources),
        fields,
        actions,
        root,
    }
}

fn home(words: &Words, sources: &Sources, copies: &[Copy]) -> View {
    let mut children = vec![text(
        "intro",
        words.t(
            "Bring conversations from other tools into Maka as new sessions.",
            "把其它工具中的对话导入 Maka，成为新的会话。",
            "把其他工具中的對話匯入 Maka，成為新的工作階段。",
        ),
        Tone::Muted,
    )];
    let mut rows: Vec<Node> = sources
        .configuration
        .sources
        .iter()
        .map(|source| {
            link(
                format!("source-{}", source.id),
                clean(&source.name),
                json!({"kind":"browse","source":source.id,"text":"","cursor":null}),
            )
            .detail(clean(&format!(
                "{} · {}",
                kind_label(words, &source.location),
                source.location.path()
            )))
            .into()
        })
        .collect();
    rows.push(
        link(
            "add",
            words.t("Add a source", "添加来源", "新增來源"),
            json!({"kind":"edit","source":null}),
        )
        .into(),
    );
    children.push(stack("sources", rows));
    if !copies.is_empty() {
        let items: Vec<Node> = copies
            .iter()
            .take(8)
            .map(|copy| {
                let settled = copy.receipt.is_some();
                let item = link(
                    format!("copy-{}", copy.operation_id),
                    clean(&copy.title),
                    json!({"kind":"copy","operation":copy.operation_id}),
                )
                .detail(clean(&copy.source_name))
                .meta(if settled {
                    words.t(
                        &format!("{} records", copy.records),
                        &format!("{} 条记录", copy.records),
                        &format!("{} 筆記錄", copy.records),
                    )
                } else {
                    words.t("Not finished", "未完成", "未完成")
                });
                if settled {
                    item.into()
                } else {
                    item.tone(Tone::Warning).into()
                }
            })
            .collect();
        children.push(stack(
            "copies",
            std::iter::once(text(
                "title",
                words.t("Imported", "已导入", "已匯入"),
                Tone::Subtle,
            ))
            .chain(items)
            .collect(),
        ));
    }
    view_of(
        words.t("Conversation import", "导入对话", "匯入對話"),
        sources,
        vec![],
        vec![],
        column("root", children),
    )
}

fn browse(
    words: &Words,
    sources: &Sources,
    source: Option<&Source>,
    query: &str,
    catalog: Option<&Catalog>,
) -> View {
    let Some(source) = source else {
        return view_of(
            words.t("Source", "来源", "來源"),
            sources,
            vec![],
            vec![],
            column(
                "root",
                vec![text(
                    "gone",
                    words.t(
                        "This source is no longer configured.",
                        "这个来源已不存在。",
                        "這個來源已不存在。",
                    ),
                    Tone::Warning,
                )],
            ),
        );
    };
    let mut children = vec![stack(
        "search",
        vec![
            input("text", "text", words.t("Find", "查找", "尋找")),
            row(
                "go",
                vec![
                    button("search", "search", Role::Normal),
                    link(
                        "edit",
                        words.t("Edit source", "编辑来源", "編輯來源"),
                        json!({"kind":"edit","source":source.id}),
                    )
                    .into(),
                ],
            ),
        ],
    )];
    if let Some(catalog) = catalog {
        if catalog.entries.is_empty() {
            children.push(text(
                "none",
                words.t(
                    "No conversations found.",
                    "没有找到对话。",
                    "沒有找到對話。",
                ),
                Tone::Muted,
            ));
        }
        let rows: Vec<Node> = catalog
            .entries
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let mut item = link(
                    format!("entry-{index}"),
                    clean(&entry.title),
                    json!({"kind":"import","source":source.id,"entry":entry}),
                );
                if let Some(cwd) = &entry.cwd {
                    item = item.detail(clean(cwd));
                }
                if entry.archived {
                    item = item.meta(words.t("Archived", "已归档", "已封存"));
                }
                item.into()
            })
            .collect();
        children.push(stack("entries", rows));
        if let Some(next) = &catalog.next {
            children.push(
                link(
                    "more",
                    words.t("More", "更多", "更多"),
                    json!({"kind":"browse","source":source.id,"text":query,"cursor":next}),
                )
                .into(),
            );
        }
    }
    view_of(
        clean(&source.name),
        sources,
        vec![view::build::line("text", clean(query), 256)],
        vec![Action {
            fields: vec!["text".into()],
            ..view::build::action("search", words.t("Search", "搜索", "搜尋"))
        }],
        column("root", children),
    )
}

fn import(
    words: &Words,
    sources: &Sources,
    _source: uuid::Uuid,
    entry: &Entry,
    models: &[Choice],
) -> View {
    let default = models
        .iter()
        .find(|model| model.is_default)
        .or_else(|| models.first());
    let mut fields = vec![
        view::build::line(
            "destination",
            entry.cwd.as_deref().map(clean).unwrap_or_default(),
            4096,
        ),
        choice(
            "sandbox",
            "read-only",
            vec![
                ("read-only".into(), words.t("Read only", "只读", "唯讀")),
                (
                    "workspace-write".into(),
                    words.t("Can change the folder", "可修改该目录", "可修改該目錄"),
                ),
            ],
        ),
    ];
    let mut form = vec![input(
        "destination",
        "destination",
        words.t("Folder", "目录", "目錄"),
    )];
    let mut sent = vec!["destination".to_owned(), "sandbox".to_owned()];
    let mut children = vec![heading("title", clean(&entry.title))];
    match default {
        Some(default) => {
            fields.push(choice(
                "model",
                default.id(),
                models
                    .iter()
                    .take(32)
                    .map(|model| {
                        (
                            model.id(),
                            clean(&format!(
                                "{} · {}",
                                model.display_name, model.connection_name
                            )),
                        )
                    })
                    .collect(),
            ));
            form.push(input("model", "model", words.t("Model", "模型", "模型")));
            sent.push("model".into());
        }
        None => children.push(text(
            "no-models",
            words.t(
                "Add a model connection before importing.",
                "导入前请先添加模型连接。",
                "匯入前請先新增模型連線。",
            ),
            Tone::Warning,
        )),
    }
    form.push(input(
        "sandbox",
        "sandbox",
        words.t("Access", "权限", "權限"),
    ));
    children.push(stack("form", form));
    let mut actions = vec![];
    if default.is_some() {
        actions.push(Action {
            fields: sent,
            ..view::build::action("import", words.t("Import", "导入", "匯入"))
        });
        children.push(row(
            "controls",
            vec![button("import", "import", Role::Primary)],
        ));
    }
    view_of(
        words.t("Import", "导入", "匯入"),
        sources,
        fields,
        actions,
        column("root", children),
    )
}

fn edit(words: &Words, sources: &Sources, source: Option<&Source>) -> View {
    let fields = vec![
        view::build::line(
            "name",
            source.map(|item| clean(&item.name)).unwrap_or_default(),
            256,
        ),
        choice(
            "kind",
            source.map_or("codex", |item| item.location.kind()),
            kinds(words),
        ),
        view::build::line(
            "path",
            source
                .map(|item| clean(item.location.path()))
                .unwrap_or_default(),
            4096,
        ),
    ];
    let mut actions = vec![Action {
        fields: vec!["name".into(), "kind".into(), "path".into()],
        ..view::build::action("save", words.t("Save", "保存", "儲存"))
    }];
    let mut buttons = vec![button("save", "save", Role::Primary)];
    if source.is_some() {
        actions.push(Action {
            confirm: Some(Confirm {
                title: words.t("Remove this source?", "移除这个来源？", "移除這個來源？"),
                message: words.t(
                    "Its conversations stay where they are; imported sessions stay in Maka.",
                    "它的对话仍在原处；已导入的会话仍保留在 Maka 中。",
                    "它的對話仍在原處；已匯入的工作階段仍保留在 Maka 中。",
                ),
                destructive: true,
            }),
            ..view::build::action("remove", words.t("Remove", "移除", "移除"))
        });
        buttons.push(button("remove", "remove", Role::Destructive));
    }
    view_of(
        source.map_or_else(
            || words.t("New source", "新来源", "新來源"),
            |item| clean(&item.name),
        ),
        sources,
        fields,
        actions,
        column(
            "root",
            vec![
                stack(
                    "form",
                    vec![
                        input("name", "name", words.t("Name", "名称", "名稱")),
                        input("kind", "kind", words.t("Tool", "工具", "工具")),
                        input("path", "path", words.t("Location", "位置", "位置")),
                    ],
                ),
                row("controls", buttons),
            ],
        ),
    )
}

fn settle(words: &Words, sources: &Sources, copy: Option<&Copy>) -> View {
    let Some(copy) = copy else {
        return view_of(
            words.t("Import", "导入", "匯入"),
            sources,
            vec![],
            vec![],
            column(
                "root",
                vec![text(
                    "gone",
                    words.t(
                        "This import is no longer listed.",
                        "这次导入已不在列表中。",
                        "這次匯入已不在列表中。",
                    ),
                    Tone::Muted,
                )],
            ),
        );
    };
    let mut children = vec![
        heading("title", clean(&copy.title)),
        text("source", clean(&copy.source_name), Tone::Muted),
    ];
    let mut actions = vec![];
    if copy.receipt.is_some() {
        children.push(text(
            "done",
            words.t(
                &format!("Imported {} records.", copy.records),
                &format!("已导入 {} 条记录。", copy.records),
                &format!("已匯入 {} 筆記錄。", copy.records),
            ),
            Tone::Success,
        ));
    } else {
        children.push(text(
            "pending",
            words.t(
                "This import was prepared but not finished.",
                "这次导入已准备但尚未完成。",
                "這次匯入已準備但尚未完成。",
            ),
            Tone::Warning,
        ));
        actions.push(view::build::action(
            "deliver",
            words.t("Finish import", "完成导入", "完成匯入"),
        ));
        actions.push(Action {
            confirm: Some(Confirm {
                title: words.t("Abandon this import?", "放弃这次导入？", "放棄這次匯入？"),
                message: words.t(
                    "No session is created from it.",
                    "不会由它创建会话。",
                    "不會由它建立工作階段。",
                ),
                destructive: true,
            }),
            ..view::build::action("abandon", words.t("Abandon", "放弃", "放棄"))
        });
        children.push(row(
            "controls",
            vec![
                button("deliver", "deliver", Role::Primary),
                button("abandon", "abandon", Role::Destructive),
            ],
        ));
    }
    view_of(
        words.t("Import", "导入", "匯入"),
        sources,
        vec![],
        actions,
        column("root", children),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> Sources {
        Sources {
            revision: Some(2),
            configuration: Configuration {
                sources: vec![Source {
                    id: uuid::Uuid::new_v4(),
                    name: "Codex".into(),
                    location: Location::Codex {
                        root: "/home/me/.codex".into(),
                    },
                }],
            },
        }
    }

    #[test]
    fn every_step_of_an_import_is_a_valid_view() {
        let words = Words::new("en");
        let sources = sources();
        let copies = vec![Copy {
            operation_id: uuid::Uuid::new_v4(),
            source_name: "Codex".into(),
            title: "Refactor".into(),
            records: 12,
            receipt: None,
        }];
        home(&words, &sources, &copies).validate().unwrap();
        let entry = Entry {
            id: "abc".into(),
            path: "sessions/abc.jsonl".into(),
            title: "Refactor".into(),
            cwd: Some("/work".into()),
            archived: false,
        };
        let source = sources.configuration.sources.first();
        let catalog = Catalog {
            entries: vec![entry.clone()],
            next: Some("next".into()),
        };
        browse(&words, &sources, source, "", Some(&catalog))
            .validate()
            .unwrap();
        let model = Choice {
            model: json!({"connectionId":"c","connectionSlug":"openai","model":"gpt"}),
            display_name: "GPT".into(),
            connection_name: "OpenAI".into(),
            default_thinking_level: None,
            is_default: true,
        };
        let view = import(&words, &sources, source.unwrap().id, &entry, &[model]);
        view.validate().unwrap();
        assert_eq!(
            view.field("model").map(|field| &field.id),
            Some(&"model".to_owned())
        );
        import(&words, &sources, source.unwrap().id, &entry, &[])
            .validate()
            .unwrap();
        edit(&words, &sources, source).validate().unwrap();
        let view = settle(&words, &sources, copies.first());
        view.validate().unwrap();
        assert!(view.action("abandon").unwrap().confirm.is_some());
    }
}
