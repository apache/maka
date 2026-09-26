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

//! External agents as a settings category: the command-line agents Maka
//! can hand work to, each with how it starts, and a check that it answers.
//! The endpoint requires Host path access, as the management it wraps does.

mod auth;
mod sign_in;
mod url;

use super::Management;
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    remote::{self, Caller, Error, Method, StreamProvider},
    terminal_ui::{
        Context, Descriptor, Placement, Text, VERSION,
        app::{self, App, Cx, Submission, Words},
        view::{self, Action, Confirm, Node, Reply, Role, Tone, View, build::*},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

pub(super) fn publish(
    management: Arc<Management>,
    setup: Arc<crate::setup::Provider>,
    package: &str,
    staged: &mut Staged,
) -> Result<(), String> {
    let pages = auth::Pages::default();
    url::publish(pages.clone(), package, staged)?;
    staged
        .insert(
            remote::key(package, "terminal-changes").map_err(|error| error.to_string())?,
            remote::Endpoint::standalone(remote::Handler::Stream(pages.provider(setup.clone())))
                .requiring_host_paths(),
        )
        .map_err(|error| error.to_string())?;
    let endpoint = app::endpoint(
        Agents {
            management,
            setup,
            pages,
        },
        Descriptor::new(
            Text::localized("External agents", "外部代理", "外部代理"),
            Context::Application,
        )
        .changes("terminal-changes")
        .placement(Placement::Settings)
        .icon("⇆", "X")
        .order(37),
    )
    .map_err(|error| error.to_string())?
    .requiring_host_paths();
    staged
        .insert(
            remote::key(package, "terminal").map_err(|error| error.to_string())?,
            endpoint,
        )
        .map_err(|error| error.to_string())
}

#[derive(Clone)]
struct Agents {
    management: Arc<Management>,
    setup: Arc<crate::setup::Provider>,
    pages: auth::Pages,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Configuration {
    revision: Option<u64>,
    #[serde(default)]
    agents: Vec<Agent>,
    activation_error: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Agent {
    id: String,
    display_name: String,
    executable: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

impl Agents {
    async fn read(&self, caller: &Caller) -> Result<Configuration, Error> {
        let value = self
            .management
            .call(json!({"kind":"read"}), caller.clone())
            .await?;
        serde_json::from_value(value).map_err(|error| Error::Provider(error.to_string()))
    }
    /// Runs a check to its first answer: whether the agent starts and speaks,
    /// and how it can sign in.
    async fn check(&self, id: &str, revision: Option<u64>, caller: Caller) -> Result<(), Error> {
        let stream = self
            .setup
            .open(
                json!({"kind":"check","agentId":id,"operationId":uuid::Uuid::new_v4(),"expectedRevision":revision}),
                caller.clone(),
            )
            .await?;
        let answer = tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                match stream.next().await? {
                    Some(item)
                        if item.get("kind").and_then(Value::as_str) == Some("initialized") =>
                    {
                        return Ok::<_, Error>(item);
                    }
                    Some(_) => continue,
                    None => {
                        return Err(Error::Provider("The check ended without an answer".into()));
                    }
                }
            }
        })
        .await;
        stream.cancel();
        stream.close().await?;
        let item =
            answer.map_err(|_| Error::Provider("The agent did not answer in time".into()))??;
        let revision = revision.ok_or_else(|| Error::Invalid("Save the agent first".into()))?;
        let checked = sign_in::Checked {
            id: uuid::Uuid::new_v4(),
            agent: id.to_owned(),
            revision,
            methods: sign_in::offered(&item),
            summary: summary(&item),
            start: 0,
        };
        if !self.pages.remember(&caller, checked) {
            return Err(Error::Cancelled);
        }
        Ok(())
    }
}

/// What a check learned, in one line: the agent, and its sign-in methods.
fn summary(item: &Value) -> String {
    let info = &item["agentInfo"];
    let name = info
        .get("title")
        .or_else(|| info.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("agent");
    let version = info.get("version").and_then(Value::as_str).unwrap_or("");
    let methods: Vec<&str> = item["authMethods"]
        .as_array()
        .map(|methods| {
            methods
                .iter()
                .filter_map(|method| {
                    method
                        .get("name")
                        .or_else(|| method.get("id"))
                        .and_then(Value::as_str)
                })
                .collect()
        })
        .unwrap_or_default();
    let mut line = format!("{name} {version}").trim().to_owned();
    if !methods.is_empty() {
        line.push_str(&format!(" · {}", methods.join(", ")));
    }
    view::build::clean(&line, false).chars().take(512).collect()
}
fn clean(value: &str) -> String {
    view::build::clean(value, false)
}
fn stamp(configuration: &Configuration) -> String {
    configuration.revision.unwrap_or(0).to_string()
}

impl App for Agents {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let this = self.clone();
        Box::pin(async move {
            let configuration = this.read(&cx.caller).await?;
            let words = &cx.words;
            if let Some(attempt) = this.pages.snapshot(&cx.caller)
                && attempt.active()
                && route["agent"].as_str() != Some(attempt.agent.as_str())
            {
                this.pages.cancel(&cx.caller, attempt.id)?;
            }
            match route.get("agent") {
                None => Ok(list(words, &configuration)),
                Some(id) => {
                    let agent = id
                        .as_str()
                        .and_then(|id| configuration.agents.iter().find(|agent| agent.id == id));
                    let checked = this.pages.checked(&cx.caller).filter(|checked| {
                        route["agent"] == checked.agent
                            && configuration.revision == Some(checked.revision)
                    });
                    let mut view = editor(
                        words,
                        &configuration,
                        agent,
                        checked.as_ref().map(|checked| checked.summary.as_str()),
                    );
                    if !this.pages.connected(&cx.caller) {
                        for action in &mut view.actions {
                            if action.id == "check" {
                                action.enabled = false;
                                action.label = words.t("Connecting…", "正在连接…", "正在連線…");
                            }
                        }
                    }
                    sign_in::append(
                        &mut view,
                        &route,
                        &configuration,
                        checked,
                        this.pages.snapshot(&cx.caller),
                        words,
                    );
                    Ok(view)
                }
            }
        })
    }

    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let this = self.clone();
        Box::pin(async move {
            let configuration = this.read(&cx.caller).await?;
            if submission.action.starts_with("cancel-authentication-") {
                return sign_in::cancel(&this.pages, submission, &cx);
            }
            if this
                .pages
                .snapshot(&cx.caller)
                .is_some_and(|attempt| attempt.active())
            {
                return Ok(Reply::Rejected {
                    message: cx.t(
                        "Cancel the current sign-in first.",
                        "请先取消当前登录。",
                        "請先取消目前登入。",
                    ),
                });
            }
            if stamp(&configuration) != submission.revision {
                return Ok(Reply::Conflict);
            }
            let original = submission
                .route
                .get("agent")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let rejected = |error: Error| match error {
                Error::Invalid(message) | Error::Provider(message) => Ok(Reply::Rejected {
                    message: clean(&message).chars().take(256).collect(),
                }),
                error => Err(error),
            };
            if submission.action.starts_with("auth-page-") {
                return sign_in::page(&this.pages, submission, &cx);
            }
            if submission.action.starts_with("authenticate-") {
                return sign_in::begin(&this.pages, &configuration, submission, &cx);
            }
            let mut agents = configuration.agents;
            match submission.action.as_str() {
                "reconcile" => {
                    return match this
                        .management
                        .call(json!({"kind":"reconcile"}), cx.caller)
                        .await
                    {
                        Ok(_) => Ok(Reply::Applied { route: Value::Null }),
                        Err(error) => rejected(error),
                    };
                }
                "check" => {
                    let id = original.ok_or_else(|| Error::Invalid("No agent".into()))?;
                    return match this.check(&id, configuration.revision, cx.caller).await {
                        Ok(()) => Ok(Reply::Updated {}),
                        Err(error) => rejected(error),
                    };
                }
                "remove" => {
                    let id = original.ok_or_else(|| Error::Invalid("No agent".into()))?;
                    agents.retain(|agent| agent.id != id);
                }
                "save" => {
                    let id = match &original {
                        Some(id) => id.clone(),
                        None => submission.text("id")?.trim().to_owned(),
                    };
                    let mut env = BTreeMap::new();
                    for line in submission.text("env")?.lines() {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let Some((key, value)) = line.split_once('=') else {
                            return Ok(Reply::Rejected {
                                message: cx.t(
                                    "Write each variable as NAME=value on its own line.",
                                    "每行写一个变量，格式为 NAME=value。",
                                    "每行寫一個變數，格式為 NAME=value。",
                                ),
                            });
                        };
                        env.insert(key.trim().to_owned(), value.to_owned());
                    }
                    let agent = Agent {
                        id: id.clone(),
                        display_name: submission.text("name")?.trim().to_owned(),
                        executable: submission.text("executable")?.trim().to_owned(),
                        args: submission
                            .text("args")?
                            .lines()
                            .map(str::trim)
                            .filter(|arg| !arg.is_empty())
                            .map(str::to_owned)
                            .collect(),
                        env,
                    };
                    match agents.iter_mut().find(|item| item.id == id) {
                        Some(item) => *item = agent,
                        None if original.is_none() => agents.push(agent),
                        None => return Ok(Reply::Conflict),
                    }
                }
                _ => return Err(Error::Invalid("Unknown agent action".into())),
            }
            match this
                .management
                .call(
                    json!({"kind":"configure","expectedRevision":configuration.revision,"agents":agents}),
                    cx.caller,
                )
                .await
            {
                Ok(_) => Ok(Reply::Applied { route: Value::Null }),
                Err(error) => rejected(error),
            }
        })
    }
}

fn list(words: &Words, configuration: &Configuration) -> View {
    let mut children = vec![text(
        "intro",
        words.t(
            "Command-line agents Maka can hand work to. Each runs as you configure it here.",
            "Maka 可以把工作交给这些命令行代理，按这里的配置运行。",
            "Maka 可以把工作交給這些命令列代理，按這裡的設定執行。",
        ),
        Tone::Muted,
    )];
    let mut actions = vec![];
    if let Some(error) = &configuration.activation_error {
        children.push(text("error", clean(error), Tone::Warning));
        actions.push(view::build::action(
            "reconcile",
            words.t("Try again", "重试", "重試"),
        ));
        children.push(row(
            "retry",
            vec![button("retry", "reconcile", Role::Primary)],
        ));
    }
    let mut rows: Vec<Node> = configuration
        .agents
        .iter()
        .map(|agent| {
            link(
                format!("agent-{}", agent.id).replace('/', ":"),
                clean(&agent.display_name),
                json!({"agent": agent.id}),
            )
            .detail(clean(&format!(
                "{} {}",
                agent.executable,
                agent.args.join(" ")
            )))
            .into()
        })
        .collect();
    rows.push(
        link(
            "add",
            words.t("Add an agent", "添加代理", "新增代理"),
            json!({"agent": null}),
        )
        .into(),
    );
    children.push(stack("agents", rows));
    View {
        version: VERSION,
        title: words.t("External agents", "外部代理", "外部代理"),
        revision: stamp(configuration),
        fields: vec![],
        actions,
        root: column("root", children),
    }
}

fn editor(
    words: &Words,
    configuration: &Configuration,
    agent: Option<&Agent>,
    checked: Option<&str>,
) -> View {
    let text_of = |get: fn(&Agent) -> String| agent.map_or_else(String::new, get);
    let mut fields = vec![
        view::build::line("name", text_of(|agent| clean(&agent.display_name)), 256),
        view::build::line(
            "executable",
            text_of(|agent| clean(&agent.executable)),
            4096,
        ),
        area(
            "args",
            text_of(|agent| {
                agent
                    .args
                    .iter()
                    .map(|arg| clean(arg))
                    .collect::<Vec<_>>()
                    .join("\n")
            }),
            8192,
        ),
        area(
            "env",
            text_of(|agent| {
                agent
                    .env
                    .iter()
                    .map(|(key, value)| clean(&format!("{key}={value}")))
                    .collect::<Vec<_>>()
                    .join("\n")
            }),
            8192,
        ),
    ];
    let mut form = vec![];
    let mut sent: Vec<String> = vec![];
    if agent.is_none() {
        fields.insert(0, view::build::line("id", "", 128));
        form.push(input("id", "id", words.t("Identifier", "标识", "識別碼")));
        sent.push("id".into());
    }
    for (id, en, zh_cn, zh_tw) in [
        ("name", "Name", "名称", "名稱"),
        ("executable", "Executable", "可执行文件", "可執行檔"),
        ("args", "Arguments", "参数", "參數"),
        ("env", "Environment", "环境变量", "環境變數"),
    ] {
        form.push(input(id, id, words.t(en, zh_cn, zh_tw)));
        sent.push(id.into());
    }
    let mut children = vec![link(
        "all-agents", words.t("All agents", "所有代理", "所有代理"), Value::Null,
    ).into(), text(
        "hint",
        words.t(
            "One argument per line, and NAME=value per line for the environment. Sign-in secrets stay in the agent's own login.",
            "参数每行一个，环境变量每行一个 NAME=value。登录凭据保存在代理自己的登录中。",
            "參數每行一個，環境變數每行一個 NAME=value。登入憑證保存在代理自己的登入中。",
        ),
        Tone::Subtle,
    )];
    if let Some(checked) = checked {
        children.push(spans(
            "checked",
            vec![
                (
                    words.t("It answered: ", "代理已响应：", "代理已回應："),
                    Tone::Success,
                ),
                (checked.to_owned(), Tone::Normal),
            ],
        ));
    }
    children.push(stack("form", form));
    let mut actions = vec![Action {
        fields: sent,
        ..view::build::action("save", words.t("Save", "保存", "儲存"))
    }];
    let mut buttons = vec![button("save", "save", Role::Primary)];
    if agent.is_some() {
        actions.push(view::build::action(
            "check",
            words.t("Check", "检查", "檢查"),
        ));
        buttons.push(button("check", "check", Role::Normal));
        actions.push(Action {
            confirm: Some(Confirm {
                title: words.t("Remove this agent?", "移除这个代理？", "移除這個代理？"),
                message: words.t(
                    "Maka stops handing work to it. Its own files and login stay.",
                    "Maka 将不再把工作交给它。它自己的文件和登录会保留。",
                    "Maka 將不再把工作交給它。它自己的檔案和登入會保留。",
                ),
                destructive: true,
            }),
            ..view::build::action("remove", words.t("Remove", "移除", "移除"))
        });
        buttons.push(button("remove", "remove", Role::Destructive));
    }
    children.push(row("controls", buttons));
    View {
        version: VERSION,
        title: agent.map_or_else(
            || words.t("New agent", "新代理", "新代理"),
            |agent| clean(&agent.display_name),
        ),
        revision: stamp(configuration),
        fields,
        actions,
        root: column("root", children),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_view_requires_explicit_selection_and_fences_configuration() {
        let configuration = Configuration {
            revision: Some(4),
            agents: vec![],
            activation_error: None,
        };
        let mut checked = sign_in::Checked {
            id: uuid::Uuid::new_v4(),
            agent: "fixture".into(),
            revision: 4,
            methods: json!([{"id":"urn:login/browser method","name":"Browser","type":"agent"}]),
            summary: "fixture 1".into(),
            start: 0,
        };
        let route = json!({"agent":"fixture"});
        for locale in ["en", "zh-CN", "zh-TW"] {
            let words = Words::new(locale);
            let mut view = editor(&words, &configuration, None, Some("fixture 1"));
            sign_in::append(
                &mut view,
                &route,
                &configuration,
                Some(checked.clone()),
                None,
                &words,
            );
            view.validate().unwrap();
            assert!(
                view.action(&format!("authenticate-{}", checked.id))
                    .unwrap()
                    .recovery
                    .is_none()
            );
            assert!(matches!(&view.field("auth-method").unwrap().control,
                view::Control::Choice { value, options } if value == "choose" && options[1].value == "method-0"));
        }
        // Protocol choice pages are bounded, while all offered methods remain reachable.
        checked.methods = json!(
            (0..70)
                .map(
                    |index| json!({"id":format!("method {index}"),"name":format!("Method {index}")})
                )
                .collect::<Vec<_>>()
        );
        for page in [0, 31, 62] {
            checked.start = page;
            Reply::Updated {}.validate().unwrap();
            let words = Words::new("en");
            let mut view = editor(&words, &configuration, None, None);
            sign_in::append(
                &mut view,
                &route,
                &configuration,
                Some(checked.clone()),
                None,
                &words,
            );
            view.validate().unwrap();
        }
        checked.revision = 3;
        let words = Words::new("en");
        let mut view = editor(&words, &configuration, None, None);
        sign_in::append(
            &mut view,
            &route,
            &configuration,
            Some(checked.clone()),
            None,
            &words,
        );
        assert!(
            view.action(&format!("authenticate-{}", checked.id))
                .is_none()
        );
    }

    #[test]
    fn agents_edit_their_launch_and_a_check_reports_who_answered() {
        let words = Words::new("en");
        let configuration = Configuration {
            revision: Some(4),
            agents: vec![Agent {
                id: "codex".into(),
                display_name: "Codex".into(),
                executable: "codex".into(),
                args: vec!["acp".into()],
                env: BTreeMap::from([("LOG".into(), "info".into())]),
            }],
            activation_error: Some("codex was not found".into()),
        };
        let view = list(&words, &configuration);
        view.validate().unwrap();
        assert!(view.action("reconcile").is_some());
        let edit = editor(
            &words,
            &configuration,
            configuration.agents.first(),
            Some("Codex 1.0 · ChatGPT"),
        );
        edit.validate().unwrap();
        let Node::Column { children, .. } = &edit.root else {
            panic!("agent editor column");
        };
        assert!(
            matches!(children.first(), Some(Node::Item { target: view::Target::Route { route }, .. }) if route.is_null())
        );
        assert!(edit.action("remove").unwrap().confirm.is_some());
        assert!(serde_json::to_string(&edit).unwrap().contains("LOG=info"));
        editor(&words, &configuration, None, None)
            .validate()
            .unwrap();
        let item = json!({"kind":"initialized","agentInfo":{"name":"codex","version":"1.0"},
            "authMethods":[{"id":"chatgpt","name":"ChatGPT"}]});
        assert_eq!(summary(&item), "codex 1.0 · ChatGPT");
    }
}
