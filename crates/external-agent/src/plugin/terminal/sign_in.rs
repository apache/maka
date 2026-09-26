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

use super::*;
use auth::{Attempt, Pages, Phase};

#[derive(Clone)]
pub(super) struct Checked {
    pub id: uuid::Uuid,
    pub agent: String,
    pub revision: u64,
    pub methods: Value,
    pub summary: String,
    pub start: usize,
}

pub(super) fn offered(event: &Value) -> Value {
    json!(event["authMethods"].as_array().into_iter().flatten().filter_map(|method| {
        let id = method["id"].as_str()?;
        if id.is_empty() || id.len() > 1024 || id.chars().any(char::is_control) { return None; }
        let name = clean(method["name"].as_str().filter(|name| !name.trim().is_empty()).unwrap_or(id));
        Some(json!({"id":id,"name":name[..name.floor_char_boundary(256.min(name.len()))],
            "type":if method.get("type").is_none_or(|kind| kind == "agent") { "agent" } else { "unsupported" }}))
    }).collect::<Vec<_>>())
}

fn methods(checked: &Checked) -> Vec<(String, String)> {
    checked
        .methods
        .as_array()
        .into_iter()
        .flatten()
        .filter(|method| method.get("type").is_none_or(|kind| kind == "agent"))
        .filter_map(|method| {
            let id = method["id"].as_str()?;
            if id.is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
                return None;
            }
            let mut label = clean(
                method["name"]
                    .as_str()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or(id),
            );
            label.truncate(label.floor_char_boundary(256.min(label.len())));
            Some((id.to_owned(), label))
        })
        .collect()
}
pub(super) fn begin(
    pages: &Pages,
    configuration: &Configuration,
    submission: Submission,
    cx: &Cx,
) -> Result<Reply, Error> {
    let Some(checked) = pages.checked(&cx.caller) else {
        return Ok(Reply::Conflict);
    };
    if Some(checked.revision) != configuration.revision
        || submission.action != format!("authenticate-{}", checked.id)
        || submission.route["agent"] != checked.agent
    {
        return Ok(Reply::Conflict);
    }
    let agent = submission.route["agent"]
        .as_str()
        .filter(|id| configuration.agents.iter().any(|agent| agent.id == *id))
        .ok_or_else(|| Error::Invalid("No saved agent".into()))?;
    let selection = submission
        .text("auth-method")?
        .strip_prefix("method-")
        .and_then(|value| value.parse::<usize>().ok());
    let offered = methods(&checked);
    let method = selection.and_then(|index| offered.get(index));
    let Some((method, _)) = method else {
        return Ok(Reply::Rejected {
            message: cx.t(
                "Choose a sign-in method first.",
                "请先选择登录方式。",
                "請先選擇登入方式。",
            ),
        });
    };
    let revision = configuration
        .revision
        .ok_or_else(|| Error::Invalid("Save the agent first".into()))?;
    pages.begin(&cx.caller, agent.to_owned(), method.to_owned(), revision)?;
    Ok(Reply::Updated {})
}
pub(super) fn cancel(pages: &Pages, submission: Submission, cx: &Cx) -> Result<Reply, Error> {
    let id = submission
        .action
        .strip_prefix("cancel-authentication-")
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .ok_or_else(|| Error::Invalid("Invalid sign-in operation".into()))?;
    pages.cancel(&cx.caller, id)?;
    Ok(Reply::Updated {})
}
pub(super) fn page(pages: &Pages, submission: Submission, cx: &Cx) -> Result<Reply, Error> {
    let Some(checked) = pages.checked(&cx.caller) else {
        return Ok(Reply::Conflict);
    };
    let start = submission
        .action
        .strip_prefix(&format!("auth-page-{}-", checked.id))
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|start| *start < methods(&checked).len())
        .ok_or_else(|| Error::Invalid("Invalid authentication method page".into()))?;
    pages.method_page(&cx.caller, checked.id, start)?;
    Ok(Reply::Updated {})
}
pub(super) fn append(
    view: &mut View,
    route: &Value,
    configuration: &Configuration,
    checked: Option<Checked>,
    attempt: Option<Attempt>,
    words: &Words,
) {
    let Node::Column { children, .. } = &mut view.root else {
        return;
    };
    let attempt = attempt.filter(|value| route["agent"].as_str() == Some(value.agent.as_str()));
    if let Some(attempt) = &attempt {
        let (en, cn, tw, tone) = match attempt.phase {
            Phase::Pending => ("Waiting for sign-in", "等待登录", "等待登入", Tone::Accent),
            Phase::Cancelling => (
                "Cancelling sign-in",
                "正在取消登录",
                "正在取消登入",
                Tone::Muted,
            ),
            Phase::Authenticated => (
                "Sign-in confirmed by the agent",
                "代理已确认登录成功",
                "代理已確認登入成功",
                Tone::Success,
            ),
            Phase::Cancelled => (
                "Sign-in cancelled; check the agent before trying again.",
                "登录已取消；再次尝试前请检查代理。",
                "登入已取消；再次嘗試前請檢查代理。",
                Tone::Muted,
            ),
            Phase::Failed => (
                "Sign-in was not confirmed; check the agent before trying again.",
                "登录未获确认；再次尝试前请检查代理。",
                "登入未獲確認；再次嘗試前請檢查代理。",
                Tone::Warning,
            ),
        };
        children.insert(0, text("authentication-status", words.t(en, cn, tw), tone));
        children.insert(
            1,
            text("authentication-method", clean(&attempt.method), Tone::Muted),
        );
        if attempt.url.is_some() {
            children.insert(
                2,
                text(
                    "authentication-url-hint",
                    words.t(
                        "Copy this URL into your browser to sign in:",
                        "复制此网址并在浏览器中登录：",
                        "複製此網址並在瀏覽器中登入：",
                    ),
                    Tone::Normal,
                ),
            );
            children.insert(
                3,
                transcript("authentication-url", super::url::resource(attempt)),
            );
        }
        if attempt.active() {
            for field in &mut view.fields {
                field.enabled = false;
            }
            for action in &mut view.actions {
                action.enabled = false;
            }
            let id = format!("cancel-authentication-{}", attempt.id);
            view.actions.push(action(
                &id,
                words.t("Cancel sign-in", "取消登录", "取消登入"),
            ));
            children.insert(
                2,
                row(
                    "authentication-controls",
                    vec![button("cancel-authentication", id, Role::Normal)],
                ),
            );
            return;
        }
    }
    let Some(checked) = checked.filter(|checked| {
        Some(checked.revision) == configuration.revision && route["agent"] == checked.agent
    }) else {
        if route.get("checked").is_some() {
            children.insert(
                0,
                text(
                    "check-again",
                    words.t(
                        "Check again to choose a sign-in method.",
                        "请重新检查以选择登录方式。",
                        "請重新檢查以選擇登入方式。",
                    ),
                    Tone::Muted,
                ),
            );
        }
        return;
    };
    let offered = methods(&checked);
    if offered.is_empty() {
        children.insert(0, text("auth-unavailable", words.t("No supported sign-in methods were offered. Use the agent’s own login if needed.", "没有可用的登录方式；如需登录，请使用代理自身的登录入口。", "沒有可用的登入方式；如需登入，請使用代理自身的登入入口。"), Tone::Muted));
        return;
    }
    let start = if checked.start < offered.len() {
        checked.start
    } else {
        0
    };
    let mut options = offered
        .iter()
        .enumerate()
        .skip(start)
        .take(31)
        .map(|(index, (_, label))| (format!("method-{index}"), label.clone()))
        .collect::<Vec<_>>();
    if start + options.len() < offered.len() || start > 0 {
        let next = if start + options.len() < offered.len() {
            start + options.len()
        } else {
            0
        };
        let id = format!("auth-page-{}-{next}", checked.id);
        view.actions.push(Action {
            fields: vec!["auth-method".into()],
            ..action(
                &id,
                words.t("More sign-in methods", "更多登录方式", "更多登入方式"),
            )
        });
        children.insert(
            0,
            row("auth-more", vec![button("auth-more", id, Role::Normal)]),
        );
    }
    options.insert(
        0,
        (
            "choose".into(),
            words.t("Choose a method", "选择登录方式", "選擇登入方式"),
        ),
    );
    view.fields.push(choice("auth-method", "choose", options));
    if let Some(check) = view.actions.iter_mut().find(|action| action.id == "check") {
        check.fields.push("auth-method".into());
    }
    let authenticate = format!("authenticate-{}", checked.id);
    view.actions.push(Action {
        fields: vec!["auth-method".into()],
        ..action(&authenticate, words.t("Sign in", "登录", "登入"))
    });
    // Keep sign-in controls above launch configuration, including narrow screens.
    children.insert(
        0,
        row(
            "sign-in",
            vec![
                input(
                    "auth-method",
                    "auth-method",
                    words.t("Sign-in method", "登录方式", "登入方式"),
                ),
                button("authenticate", authenticate, Role::Normal),
            ],
        ),
    );
}
