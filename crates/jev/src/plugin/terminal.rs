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

//! Jev as a settings category: where the evaluator runs, with which model
//! and patience, its key (never shown back), and a test of the setup.

use super::{ID, remote::Service};
use crate::decision::Jev;
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    remote::{Caller, Error, Method, key},
    terminal_ui::{
        Context, Descriptor, Placement, Text, VERSION,
        app::{self, App, Cx, Submission, Words},
        view::{self, Action, Confirm, Control, Field, Reply, Role, Tone, View, build::*},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) fn publish(jev: Arc<Jev>, staged: &mut Staged) -> Result<(), String> {
    let endpoint = app::endpoint(
        Settings(Arc::new(Service(jev))),
        Descriptor::new(Text::plain("Jev"), Context::Application)
            .placement(Placement::Settings)
            .icon("⚖", "J")
            .order(36),
    )
    .map_err(|error| error.to_string())?;
    staged
        .insert(
            key(ID, "terminal").map_err(|error| error.to_string())?,
            endpoint,
        )
        .map_err(|error| error.to_string())
}

struct Settings(Arc<Service>);

#[derive(Deserialize)]
struct Snapshotted {
    snapshot: Snapshot,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    revision: Option<u64>,
    settings: Setup,
    credential_revision: Option<u64>,
    configured: bool,
    header_names: Vec<String>,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Setup {
    enabled: bool,
    url: String,
    model: String,
    timeout_ms: u64,
}

impl Settings {
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
        snapshot.credential_revision.unwrap_or(0)
    )
}
fn clean(value: &str) -> String {
    view::build::clean(value, false)
}
fn rejected(error: Error) -> Result<Reply, Error> {
    match error {
        Error::Invalid(message) | Error::Provider(message) => Ok(Reply::Rejected {
            message: clean(&message).chars().take(256).collect(),
        }),
        error => Err(error),
    }
}

impl App for Settings {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let this = Settings(self.0.clone());
        Box::pin(async move {
            let snapshot = this.snapshot(&cx.caller).await?;
            let tested = route.get("tested").and_then(Value::as_str).map(clean);
            Ok(form(&cx.words, &snapshot, tested.as_deref()))
        })
    }

    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let this = Settings(self.0.clone());
        Box::pin(async move {
            let snapshot = this.snapshot(&cx.caller).await?;
            if stamp(&snapshot) != submission.revision {
                return Ok(Reply::Conflict);
            }
            match submission.action.as_str() {
                "save" => {
                    let Ok(timeout_ms) = submission.text("timeout")?.trim().parse::<u64>() else {
                        return Ok(Reply::Rejected {
                            message: cx.t(
                                "The timeout is a number of milliseconds.",
                                "超时时间需填写毫秒数。",
                                "逾時時間需填寫毫秒數。",
                            ),
                        });
                    };
                    let setup = Setup {
                        enabled: submission.toggle("enabled")?,
                        url: submission.text("url")?.trim().to_owned(),
                        model: submission.text("model")?.trim().to_owned(),
                        timeout_ms,
                    };
                    let url = setup.url.clone();
                    if let Err(error) = this
                        .call(
                            json!({"kind":"configure","expectedRevision":snapshot.revision,"settings":setup}),
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
                                json!({"kind":"credential","url":url,
                                    "expectedRevision":snapshot.credential_revision,
                                    "secret":{"apiKey":secret}}),
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
                        json!({"kind":"credential","url":snapshot.settings.url,
                            "expectedRevision":snapshot.credential_revision,"secret":null}),
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
                    Ok(value) => {
                        let answer = value.get("answer").cloned().unwrap_or(Value::Null);
                        let summary: String = serde_json::to_string(&answer)
                            .unwrap_or_default()
                            .chars()
                            .take(512)
                            .collect();
                        Ok(Reply::Applied {
                            route: json!({"tested": summary}),
                        })
                    }
                    Err(error) => rejected(error),
                },
                _ => Err(Error::Invalid("Unknown Jev action".into())),
            }
        })
    }
}

fn form(words: &Words, snapshot: &Snapshot, tested: Option<&str>) -> View {
    let setup = &snapshot.settings;
    let fields = vec![
        toggle("enabled", setup.enabled),
        view::build::line("url", clean(&setup.url), 2048),
        view::build::line("model", clean(&setup.model), 256),
        view::build::line("timeout", setup.timeout_ms.to_string(), 8),
        Field {
            control: Control::Text {
                value: String::new(),
                max_bytes: 4096,
                multiline: false,
                placeholder: if snapshot.configured {
                    words.t(
                        "Saved · type to replace",
                        "已保存 · 输入以替换",
                        "已儲存 · 輸入以替換",
                    )
                } else {
                    words.t("Paste the API key", "粘贴 API 密钥", "貼上 API 金鑰")
                },
                secret: true,
            },
            ..view::build::line("key", "", 4096)
        },
    ];
    let mut children = vec![text(
        "intro",
        words.t(
            "Jev answers yes-or-no questions about the work, for checks that need judgment.",
            "Jev 会回答关于工作的是非题，用于需要判断的检查。",
            "Jev 會回答關於工作的是非題，用於需要判斷的檢查。",
        ),
        Tone::Muted,
    )];
    if let Some(tested) = tested {
        children.push(spans(
            "tested",
            vec![
                (
                    words.t("Test answered: ", "测试结果：", "測試結果："),
                    Tone::Success,
                ),
                (tested.to_owned(), Tone::Normal),
            ],
        ));
    }
    children.push(stack(
        "form",
        vec![
            input("enabled", "enabled", words.t("Enabled", "启用", "啟用")),
            input("url", "url", words.t("Endpoint", "端点", "端點")),
            input("model", "model", words.t("Model", "模型", "模型")),
            input(
                "timeout",
                "timeout",
                words.t("Timeout (ms)", "超时（毫秒）", "逾時（毫秒）"),
            ),
            input("key", "key", words.t("API key", "API 密钥", "API 金鑰")),
        ],
    ));
    if !snapshot.header_names.is_empty() {
        children.push(text(
            "headers",
            words.t(
                &format!("Extra headers: {}", snapshot.header_names.join(", ")),
                &format!("附加请求头：{}", snapshot.header_names.join("，")),
                &format!("附加請求標頭：{}", snapshot.header_names.join("，")),
            ),
            Tone::Subtle,
        ));
    }
    let mut actions = vec![Action {
        fields: ["enabled", "url", "model", "timeout", "key"]
            .map(String::from)
            .to_vec(),
        ..view::build::action("save", words.t("Save", "保存", "儲存"))
    }];
    let mut buttons = vec![button("save", "save", Role::Primary)];
    if setup.enabled {
        actions.push(view::build::action("test", words.t("Test", "测试", "測試")));
        buttons.push(button("test", "test", Role::Normal));
    }
    if snapshot.configured {
        actions.push(Action {
            confirm: Some(Confirm {
                title: words.t("Remove the Jev key?", "移除 Jev 密钥？", "移除 Jev 金鑰？"),
                message: words.t(
                    "Checks that use Jev fail until a key is saved again.",
                    "在重新保存密钥之前，使用 Jev 的检查会失败。",
                    "在重新儲存金鑰之前，使用 Jev 的檢查會失敗。",
                ),
                destructive: true,
            }),
            ..view::build::action("forget", words.t("Remove key", "移除密钥", "移除金鑰"))
        });
        buttons.push(button("forget", "forget", Role::Destructive));
    }
    children.push(row("controls", buttons));
    View {
        version: VERSION,
        title: "Jev".into(),
        revision: stamp(snapshot),
        fields,
        actions,
        root: column("root", children),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setup_form_masks_its_key_and_tests_only_when_enabled() {
        let words = Words::new("zh-CN");
        let mut snapshot = Snapshot {
            revision: Some(1),
            settings: Setup {
                enabled: false,
                url: "https://example.com/v1".into(),
                model: "one".into(),
                timeout_ms: 30_000,
            },
            credential_revision: None,
            configured: false,
            header_names: vec![],
        };
        let view = form(&words, &snapshot, None);
        view.validate().unwrap();
        assert!(view.action("test").is_none());
        snapshot.settings.enabled = true;
        snapshot.configured = true;
        snapshot.header_names = vec!["X-Team".into()];
        let view = form(&words, &snapshot, Some("true"));
        view.validate().unwrap();
        assert!(view.action("test").is_some() && view.action("forget").is_some());
        assert!(matches!(
            &view.field("key").unwrap().control,
            Control::Text { secret: true, value, .. } if value.is_empty()
        ));
    }
}
