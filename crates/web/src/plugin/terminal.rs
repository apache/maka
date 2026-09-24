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

//! Web search as a settings category: whether the agent may search, with
//! which source, the Tavily key (never shown back), a check of that key,
//! and a place to try a search.

use super::{Web, remote::Service};
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    remote::{Caller, Error, Method, key},
    terminal_ui::{
        Context, Descriptor, Placement, Text, VERSION,
        app::{self, App, Cx, Submission, Words},
        view::{self, Action, Confirm, Control, Field, Node, Reply, Role, Tone, View, build::*},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) fn publish(
    web: Arc<Web>,
    identity: &maka_plugins::fiber::Identity,
    staged: &mut Staged,
) -> Result<(), String> {
    let endpoint = app::endpoint(
        Search(Arc::new(Service {
            web,
            scope: identity.scope.clone(),
        })),
        Descriptor::new(
            Text::localized("Web search", "网络搜索", "網路搜尋"),
            Context::Application,
        )
        .placement(Placement::Settings)
        .icon("⌕", "W")
        .order(20),
    )
    .map_err(|error| error.to_string())?;
    staged
        .insert(
            key(&identity.package_id, "terminal").map_err(|error| error.to_string())?,
            endpoint,
        )
        .map_err(|error| error.to_string())
}

struct Search(Arc<Service>);

#[derive(Deserialize)]
struct Snapshotted {
    snapshot: Snapshot,
}
#[derive(Deserialize)]
struct Snapshot {
    revision: Option<u64>,
    settings: Settings,
    credential: Credential,
}
#[derive(Deserialize, serde::Serialize)]
struct Settings {
    enabled: bool,
    source: String,
}
#[derive(Deserialize)]
struct Credential {
    revision: Option<u64>,
    configured: bool,
    check: Option<Check>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    credential_revision: u64,
    outcome: String,
}
#[derive(Deserialize)]
struct Searched {
    results: Results,
}
#[derive(Deserialize)]
struct Results {
    rows: Vec<Row>,
    #[serde(rename = "omittedResults")]
    omitted: usize,
}
#[derive(Deserialize)]
struct Row {
    title: String,
    url: String,
    snippet: String,
}

impl Search {
    async fn call(&self, input: Value, caller: Caller) -> Result<Value, Error> {
        self.0.call(input, caller).await
    }
    async fn snapshot(&self, caller: &Caller) -> Result<Snapshot, Error> {
        let value = self.call(json!({"kind":"read"}), caller.clone()).await?;
        serde_json::from_value::<Snapshotted>(value)
            .map(|reply| reply.snapshot)
            .map_err(|error| Error::Provider(error.to_string()))
    }
}

fn stamp(snapshot: &Snapshot) -> String {
    format!(
        "{}:{}",
        snapshot.revision.unwrap_or(0),
        snapshot.credential.revision.unwrap_or(0)
    )
}
fn clean(value: &str) -> String {
    view::build::clean(value, false)
}

impl App for Search {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let this = Search(self.0.clone());
        Box::pin(async move {
            let snapshot = this.snapshot(&cx.caller).await?;
            let query = route
                .get("search")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let results = match &query {
                Some(query) => {
                    let value = this
                        .call(
                            json!({"kind":"search","operationId":uuid::Uuid::new_v4(),
                                "query":{"query":query,"limit":5}}),
                            cx.caller.clone(),
                        )
                        .await;
                    Some(value.and_then(|value| {
                        serde_json::from_value::<Searched>(value)
                            .map(|reply| reply.results)
                            .map_err(|error| Error::Provider(error.to_string()))
                    }))
                }
                None => None,
            };
            Ok(match (query, results) {
                (Some(query), Some(results)) => found(&cx.words, &snapshot, &query, results),
                _ => settings(&cx.words, &snapshot),
            })
        })
    }

    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let this = Search(self.0.clone());
        Box::pin(async move {
            let snapshot = this.snapshot(&cx.caller).await?;
            if stamp(&snapshot) != submission.revision {
                return Ok(Reply::Conflict);
            }
            let rejected = |error: Error| match error {
                Error::Invalid(message) | Error::Provider(message) => Ok(Reply::Rejected {
                    message: clean(&message).chars().take(256).collect(),
                }),
                error => Err(error),
            };
            match submission.action.as_str() {
                "save" => {
                    let settings = Settings {
                        enabled: submission.toggle("enabled")?,
                        source: submission.text("source")?.to_owned(),
                    };
                    if let Err(error) = this
                        .call(
                            json!({"kind":"configure","expectedRevision":snapshot.revision,"settings":settings}),
                            cx.caller.clone(),
                        )
                        .await
                    {
                        return rejected(error);
                    }
                    let secret = submission.text("key")?.trim().to_owned();
                    if !secret.is_empty()
                        && let Err(error) = this
                            .call(
                                json!({"kind":"credential",
                                    "expectedRevision":snapshot.credential.revision,"secret":secret}),
                                cx.caller,
                            )
                            .await
                    {
                        return rejected(error);
                    }
                    Ok(Reply::Applied { route: Value::Null })
                }
                "forget" => match this
                    .call(
                        json!({"kind":"credential",
                            "expectedRevision":snapshot.credential.revision,"secret":null}),
                        cx.caller,
                    )
                    .await
                {
                    Ok(_) => Ok(Reply::Applied { route: Value::Null }),
                    Err(error) => rejected(error),
                },
                "test" => match this
                    .call(
                        json!({"kind":"test","operationId":uuid::Uuid::new_v4()}),
                        cx.caller,
                    )
                    .await
                {
                    Ok(_) => Ok(Reply::Applied { route: Value::Null }),
                    Err(error) => rejected(error),
                },
                "search" => {
                    let query = submission.text("query")?.trim().to_owned();
                    if query.is_empty() {
                        return Ok(Reply::Rejected {
                            message: cx.t(
                                "Type something to search for.",
                                "请输入要搜索的内容。",
                                "請輸入要搜尋的內容。",
                            ),
                        });
                    }
                    Ok(Reply::Applied {
                        route: json!({"search": query}),
                    })
                }
                _ => Err(Error::Invalid("Unknown web search action".into())),
            }
        })
    }
}

fn sources(words: &Words) -> Vec<(String, String)> {
    vec![
        (
            "model".into(),
            words.t("The model's own search", "模型自带搜索", "模型內建搜尋"),
        ),
        ("tavily".into(), "Tavily".into()),
    ]
}

fn outcome(words: &Words, check: &Check, current: Option<u64>) -> (String, Tone) {
    if current != Some(check.credential_revision) {
        return (
            words.t(
                "The key changed since its last check.",
                "密钥在上次检查后已更改。",
                "金鑰在上次檢查後已變更。",
            ),
            Tone::Subtle,
        );
    }
    match check.outcome.as_str() {
        "valid" => (
            words.t("The key works.", "密钥可用。", "金鑰可用。"),
            Tone::Success,
        ),
        "invalid_credentials" => (
            words.t(
                "Tavily rejected the key.",
                "Tavily 拒绝了这个密钥。",
                "Tavily 拒絕了這個金鑰。",
            ),
            Tone::Error,
        ),
        "rate_limited" => (
            words.t(
                "Tavily is limiting requests right now.",
                "Tavily 当前限制了请求频率。",
                "Tavily 目前限制了請求頻率。",
            ),
            Tone::Warning,
        ),
        "timeout" => (
            words.t(
                "Tavily did not answer in time.",
                "Tavily 没有及时响应。",
                "Tavily 沒有及時回應。",
            ),
            Tone::Warning,
        ),
        _ => (
            words.t(
                "Tavily could not be reached.",
                "无法连接 Tavily。",
                "無法連線 Tavily。",
            ),
            Tone::Warning,
        ),
    }
}

/// Whether the agent may search, from where, and the key it searches with.
fn settings(words: &Words, snapshot: &Snapshot) -> View {
    let tavily = snapshot.settings.source == "tavily";
    let mut fields = vec![
        toggle("enabled", snapshot.settings.enabled),
        choice("source", snapshot.settings.source.clone(), sources(words)),
        Field {
            control: Control::Text {
                value: String::new(),
                max_bytes: 4096,
                multiline: false,
                placeholder: if snapshot.credential.configured {
                    words.t(
                        "Saved · type to replace",
                        "已保存 · 输入以替换",
                        "已儲存 · 輸入以替換",
                    )
                } else {
                    words.t(
                        "Paste your Tavily key",
                        "粘贴 Tavily 密钥",
                        "貼上 Tavily 金鑰",
                    )
                },
                secret: true,
            },
            ..view::build::line("key", "", 4096)
        },
    ];
    let mut form = vec![
        input("enabled", "enabled", words.t("Enabled", "启用", "啟用")),
        input("source", "source", words.t("Source", "来源", "來源")),
        input(
            "key",
            "key",
            words.t("Tavily key", "Tavily 密钥", "Tavily 金鑰"),
        ),
    ];
    let mut actions = vec![Action {
        fields: vec!["enabled".into(), "source".into(), "key".into()],
        ..view::build::action("save", words.t("Save", "保存", "儲存"))
    }];
    let mut buttons = vec![button("save", "save", Role::Primary)];
    let mut children = vec![text(
        "intro",
        words.t(
            "Let the agent search the web while it works, with the model's own search or Tavily.",
            "允许智能体在工作时搜索网络，可使用模型自带搜索或 Tavily。",
            "允許智慧體在工作時搜尋網路，可使用模型內建搜尋或 Tavily。",
        ),
        Tone::Muted,
    )];
    if snapshot.credential.configured {
        actions.push(view::build::action(
            "test",
            words.t("Check key", "检查密钥", "檢查金鑰"),
        ));
        buttons.push(button("test", "test", Role::Normal));
        actions.push(Action {
            confirm: Some(Confirm {
                title: words.t(
                    "Remove the Tavily key?",
                    "移除 Tavily 密钥？",
                    "移除 Tavily 金鑰？",
                ),
                message: words.t(
                    "Searches through Tavily stop until a key is saved again.",
                    "在重新保存密钥之前，通过 Tavily 的搜索会停止。",
                    "在重新儲存金鑰之前，透過 Tavily 的搜尋會停止。",
                ),
                destructive: true,
            }),
            ..view::build::action("forget", words.t("Remove key", "移除密钥", "移除金鑰"))
        });
        buttons.push(button("forget", "forget", Role::Destructive));
    }
    children.push(stack("form", std::mem::take(&mut form)));
    if let Some(check) = &snapshot.credential.check {
        let (message, tone) = outcome(words, check, snapshot.credential.revision);
        children.push(text("check", message, tone));
    }
    children.push(row("controls", buttons));
    if tavily && snapshot.settings.enabled && snapshot.credential.configured {
        fields.push(view::build::line("query", "", 200));
        actions.push(Action {
            fields: vec!["query".into()],
            ..view::build::action("search", words.t("Search", "搜索", "搜尋"))
        });
        children.push(rule("divider"));
        children.push(stack(
            "try",
            vec![
                input(
                    "query",
                    "query",
                    words.t("Try a search", "试着搜索", "試著搜尋"),
                ),
                row("go", vec![button("search", "search", Role::Normal)]),
            ],
        ));
    }
    View {
        version: VERSION,
        title: words.t("Web search", "网络搜索", "網路搜尋"),
        revision: stamp(snapshot),
        fields,
        actions,
        root: column("root", children),
    }
}

/// What a search found, each result with where it came from.
fn found(words: &Words, snapshot: &Snapshot, query: &str, results: Result<Results, Error>) -> View {
    let mut children = vec![heading("query", clean(query))];
    match results {
        Ok(results) if results.rows.is_empty() => children.push(text(
            "none",
            words.t("Nothing found.", "没有找到结果。", "沒有找到結果。"),
            Tone::Muted,
        )),
        Ok(results) => {
            let rows: Vec<Node> = results
                .rows
                .iter()
                .enumerate()
                .map(|(index, row)| {
                    stack(
                        format!("result-{index}"),
                        vec![
                            text("title", clean(&row.title), Tone::Strong),
                            text("url", clean(&row.url), Tone::Accent),
                            text(
                                "snippet",
                                view::build::clean(&row.snippet, true),
                                Tone::Muted,
                            ),
                        ],
                    )
                })
                .collect();
            children.push(column("results", rows));
            if results.omitted > 0 {
                children.push(text(
                    "omitted",
                    words.t(
                        &format!("{} more results not shown.", results.omitted),
                        &format!("另有 {} 条结果未显示。", results.omitted),
                        &format!("另有 {} 筆結果未顯示。", results.omitted),
                    ),
                    Tone::Subtle,
                ));
            }
        }
        Err(error) => children.push(text(
            "failed",
            clean(&error.to_string())
                .chars()
                .take(512)
                .collect::<String>(),
            Tone::Warning,
        )),
    }
    View {
        version: VERSION,
        title: words.t("Search results", "搜索结果", "搜尋結果"),
        revision: stamp(snapshot),
        fields: vec![],
        actions: vec![],
        root: column("root", children),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(source: &str, configured: bool) -> Snapshot {
        Snapshot {
            revision: Some(2),
            settings: Settings {
                enabled: true,
                source: source.into(),
            },
            credential: Credential {
                revision: configured.then_some(3),
                configured,
                check: configured.then(|| Check {
                    credential_revision: 3,
                    outcome: "valid".into(),
                }),
            },
        }
    }

    #[test]
    fn the_key_is_a_masked_field_never_filled_and_searching_needs_one() {
        let words = Words::new("en");
        let view = settings(&words, &snapshot("model", false));
        view.validate().unwrap();
        assert!(matches!(
            &view.field("key").unwrap().control,
            Control::Text { value, secret: true, .. } if value.is_empty()
        ));
        assert!(view.action("search").is_none() && view.action("forget").is_none());
        let view = settings(&words, &snapshot("tavily", true));
        view.validate().unwrap();
        assert!(view.action("search").is_some());
        assert!(
            view.action("forget")
                .unwrap()
                .confirm
                .as_ref()
                .unwrap()
                .destructive
        );
        assert!(
            serde_json::to_string(&view)
                .unwrap()
                .contains("The key works.")
        );
        let results = Results {
            rows: vec![Row {
                title: "Maka".into(),
                url: "https://example.com".into(),
                snippet: "An assistant".into(),
            }],
            omitted: 2,
        };
        found(&words, &snapshot("tavily", true), "maka", Ok(results))
            .validate()
            .unwrap();
    }
}
