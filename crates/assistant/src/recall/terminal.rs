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

//! Recall as an app: find what was said in earlier conversations, and
//! open the session each match came from.

use super::{Recall, remote::Search};
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    remote::{Error, Method},
    terminal_ui::{
        Context, Descriptor, Text, VERSION,
        app::{self, App, Cx, Submission, Words},
        view::{self, Action, Node, Reply, Role, Target, Tone, View, build::*},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) fn publish(
    staged: &mut Staged,
    package: &str,
    recall: Arc<Recall>,
) -> Result<(), String> {
    let endpoint = app::endpoint(
        Finder(Arc::new(Search(recall))),
        Descriptor::new(
            Text::localized("Recall", "回忆", "回憶"),
            Context::Application,
        )
        .icon("⌕", "R")
        .order(30),
    )
    .map_err(|error| error.to_string())?;
    staged
        .insert(
            maka_plugins::remote::key(package, "terminal").map_err(|error| error.to_string())?,
            endpoint,
        )
        .map_err(|error| error.to_string())
}

struct Finder(Arc<Search>);

#[derive(Deserialize)]
struct Found {
    matches: Vec<Match>,
    complete: bool,
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Match {
    Title {
        session_id: String,
        title: String,
    },
    Passage {
        session_id: String,
        title: String,
        text: String,
        truncated: bool,
    },
}

/// Words to look for: at most eight, each a whole word of the query.
fn terms(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .filter(|term| term.chars().count() <= 64)
        .take(8)
        .map(str::to_owned)
        .collect()
}

impl App for Finder {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let search = self.0.clone();
        Box::pin(async move {
            let query = route
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let terms = terms(&query);
            let found = if terms.is_empty() {
                None
            } else {
                let value = search
                    .call(json!({"terms":terms,"limit":20}), cx.caller.clone())
                    .await;
                Some(value.and_then(|value| {
                    serde_json::from_value::<Found>(value)
                        .map_err(|error| Error::Provider(error.to_string()))
                }))
            };
            Ok(finder(&cx.words, &query, found))
        })
    }

    fn submit(&self, submission: Submission, _: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        Box::pin(async move {
            if submission.action != "find" {
                return Err(Error::Invalid("Unknown recall action".into()));
            }
            Ok(Reply::Applied {
                route: json!({"query": submission.text("query")?.trim()}),
            })
        })
    }
}

fn finder(words: &Words, query: &str, found: Option<Result<Found, Error>>) -> View {
    let mut children = vec![
        text(
            "intro",
            words.t(
                "Find what was said in earlier conversations.",
                "在以前的对话中查找说过的内容。",
                "在以前的對話中尋找說過的內容。",
            ),
            Tone::Muted,
        ),
        row(
            "search",
            vec![
                input("query", "query", words.t("Find", "查找", "尋找")),
                button("find", "find", Role::Primary),
            ],
        ),
    ];
    match found {
        None => {}
        Some(Ok(found)) if found.matches.is_empty() => children.push(text(
            "none",
            words.t("Nothing matched.", "没有匹配的内容。", "沒有符合的內容。"),
            Tone::Muted,
        )),
        Some(Ok(found)) => {
            let rows: Vec<Node> = found
                .matches
                .iter()
                .enumerate()
                .map(|(index, found)| {
                    let (session, title, detail) = match found {
                        Match::Title { session_id, title } => (session_id, title, String::new()),
                        Match::Passage {
                            session_id,
                            title,
                            text,
                            truncated,
                        } => (
                            session_id,
                            title,
                            format!(
                                "{}{}",
                                view::build::clean(text, false),
                                if *truncated { "…" } else { "" }
                            ),
                        ),
                    };
                    Node::Item {
                        key: format!("match-{index}"),
                        title: view::build::clean(title, false),
                        detail,
                        meta: String::new(),
                        tone: Tone::Normal,
                        current: false,
                        target: Target::Session {
                            session: session.clone(),
                        },
                    }
                })
                .collect();
            children.push(scroll("matches", 40, stack("list", rows)));
            if !found.complete {
                children.push(text(
                    "more",
                    words.t(
                        "More matched; add words to narrow it down.",
                        "还有更多匹配；再加一些词可以缩小范围。",
                        "還有更多符合；再加一些詞可以縮小範圍。",
                    ),
                    Tone::Subtle,
                ));
            }
        }
        Some(Err(error)) => children.push(text(
            "failed",
            view::build::clean(&error.to_string(), false)
                .chars()
                .take(512)
                .collect::<String>(),
            Tone::Warning,
        )),
    }
    View {
        version: VERSION,
        title: words.t("Recall", "回忆", "回憶"),
        revision: "recall".into(),
        fields: vec![view::build::line(
            "query",
            view::build::clean(query, false),
            512,
        )],
        actions: vec![Action {
            fields: vec!["query".into()],
            ..view::build::action("find", words.t("Find", "查找", "尋找"))
        }],
        root: column("root", children),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_open_the_session_they_came_from() {
        let words = Words::new("en");
        finder(&words, "", None).validate().unwrap();
        let found = Found {
            matches: vec![
                Match::Title {
                    session_id: "a".into(),
                    title: "Release plan".into(),
                },
                Match::Passage {
                    session_id: "b".into(),
                    title: "Refactor".into(),
                    text: "We chose the kernel".into(),
                    truncated: true,
                },
            ],
            complete: false,
        };
        let view = finder(&words, "kernel", Some(Ok(found)));
        view.validate().unwrap();
        let text = serde_json::to_string(&view).unwrap();
        assert!(text.contains("\"session\":\"b\"") && text.contains("We chose the kernel…"));
        assert_eq!(terms("a b c d e f g h i j").len(), 8);
    }
}
