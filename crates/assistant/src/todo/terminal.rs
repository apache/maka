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

//! The session's checklist beside it: the whole list in a panel, and the
//! step in progress on the status line. Read-only; the agent keeps it.

use super::{Document, Item, Repository, Status, message};
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    remote::{Endpoint, Error, Handler, key},
    terminal_ui::{
        Context, Descriptor, Placement, Text, VERSION,
        app::{self, App, Cx, Submission, Words},
        view::{Node, Reply, Tone, View, build::*},
    },
};
use serde_json::Value;
use std::sync::Arc;

fn title() -> Text {
    Text::localized("Checklist", "清单", "清單")
}

pub(super) fn publish(
    repository: Arc<Repository>,
    package: &str,
    staged: &mut Staged,
) -> Result<(), String> {
    let describe = |placement: Placement| {
        Descriptor::new(title(), Context::Session)
            .placement(placement)
            .icon("☑", "T")
            .changes("changes")
            .order(20)
    };
    let changed = repository.changed.clone();
    let endpoints = [
        (
            "terminal",
            app::endpoint(
                Checklist {
                    repository: repository.clone(),
                    place: Place::Panel,
                },
                describe(Placement::Panel),
            )
            .map_err(message)?,
        ),
        (
            "status",
            app::endpoint(
                Checklist {
                    repository,
                    place: Place::Status,
                },
                describe(Placement::Status),
            )
            .map_err(message)?,
        ),
        (
            "changes",
            Endpoint::standalone(Handler::Stream(app::changes(move |_| changed.subscribe()))),
        ),
    ];
    for (method, endpoint) in endpoints {
        staged
            .insert(key(package, method).map_err(message)?, endpoint)
            .map_err(message)?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Place {
    Panel,
    Status,
}
struct Checklist {
    repository: Arc<Repository>,
    place: Place,
}

impl App for Checklist {
    fn read(&self, route: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let (repository, place) = (self.repository.clone(), self.place);
        Box::pin(async move {
            if !route.is_null() {
                return Err(Error::Invalid("Invalid checklist route".into()));
            }
            let session = cx.session()?.to_owned();
            // The session must still exist and be the caller's to read.
            cx.caller.views.session().await?;
            let snapshot = repository
                .read(&session)
                .await
                .map_err(|error| Error::Provider(error.to_string()))?;
            let revision = snapshot
                .revision
                .map_or_else(|| "0".into(), |r| r.to_string());
            Ok(match place {
                Place::Panel => panel(&snapshot.document, revision, &cx.words),
                Place::Status => line(&snapshot.document, revision, &cx.words),
            })
        })
    }
    fn submit(&self, _: Submission, _: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        Box::pin(async { Err(Error::Invalid("The checklist is read-only".into())) })
    }
}

fn done(document: &Document) -> usize {
    document
        .items
        .iter()
        .filter(|item| item.status == Status::Completed)
        .count()
}

fn view(revision: String, words: &Words, root: Node) -> View {
    View {
        version: VERSION,
        title: title().resolve(&words.locale).into(),
        revision,
        fields: vec![],
        actions: vec![],
        root,
    }
}

fn mark(item: &Item) -> (&'static str, Tone, Tone) {
    match item.status {
        Status::Completed => ("[x]", Tone::Success, Tone::Muted),
        Status::InProgress => ("[>]", Tone::Accent, Tone::Strong),
        Status::Pending => ("[ ]", Tone::Subtle, Tone::Normal),
    }
}

/// Every step, the one in progress stronger and the finished ones quieter.
fn panel(document: &Document, revision: String, words: &Words) -> View {
    if document.items.is_empty() {
        let empty = text(
            "empty",
            words.t(
                "No checklist yet. The agent keeps one here as it works.",
                "还没有清单。智能体工作时会在这里维护。",
                "還沒有清單。智慧體工作時會在這裡維護。",
            ),
            Tone::Muted,
        );
        return view(revision, words, column("root", vec![empty]));
    }
    let (finished, total) = (done(document), document.items.len());
    let rows = document
        .items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let (glyph, tone, content) = mark(item);
            spans(
                format!("item-{index}"),
                vec![
                    (format!("{glyph} "), tone),
                    (clean(&item.content, false), content),
                ],
            )
        })
        .collect();
    let summary = progress(
        "progress",
        finished as u64,
        total as u64,
        words.t(
            &format!("{finished} of {total} done"),
            &format!("已完成 {finished}/{total}"),
            &format!("已完成 {finished}/{total}"),
        ),
    );
    view(
        revision,
        words,
        column(
            "root",
            vec![summary, scroll("items", 20, stack("list", rows))],
        ),
    )
}

/// While work remains: how far along, and the step in progress.
fn line(document: &Document, revision: String, words: &Words) -> View {
    let (finished, total) = (done(document), document.items.len());
    let mut children = vec![];
    if total > 0 && finished < total {
        children.push(text(
            "count",
            words.t(
                &format!("{finished}/{total}"),
                &format!("{finished}/{total}"),
                &format!("{finished}/{total}"),
            ),
            Tone::Muted,
        ));
        if let Some(current) = document
            .items
            .iter()
            .find(|item| item.status == Status::InProgress)
        {
            children.push(text(
                "current",
                clean(&current.content, false),
                Tone::Normal,
            ));
        }
    }
    view(revision, words, row("root", children))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(statuses: &[Status]) -> Document {
        Document {
            items: statuses
                .iter()
                .enumerate()
                .map(|(index, status)| Item {
                    content: format!("Step {index}"),
                    status: *status,
                })
                .collect(),
        }
    }

    #[test]
    fn the_panel_lists_every_step_and_the_status_shows_the_one_in_progress() {
        let words = Words::new("en");
        let empty = panel(&Document::default(), "0".into(), &words);
        empty.validate().unwrap();
        assert!(
            line(&Document::default(), "0".into(), &words)
                .root
                .children()
                .is_empty()
        );
        let working = document(&[Status::Completed, Status::InProgress, Status::Pending]);
        let view = panel(&working, "3".into(), &words);
        view.validate().unwrap();
        assert!(
            serde_json::to_string(&view)
                .unwrap()
                .contains("1 of 3 done")
        );
        let status = line(&working, "3".into(), &words);
        status.validate().unwrap();
        let text = serde_json::to_string(&status).unwrap();
        assert!(text.contains("1/3") && text.contains("Step 1"));
        // Finished lists leave the status line.
        let finished = document(&[Status::Completed, Status::Completed]);
        assert!(
            line(&finished, "4".into(), &words)
                .root
                .children()
                .is_empty()
        );
        // The list holds its maximum and still validates.
        let full = document(&[Status::Pending; 200]);
        panel(&full, "5".into(), &words).validate().unwrap();

        for (locale, title) in [("en", "Checklist"), ("zh-CN", "清单"), ("zh-TW", "清單")] {
            let words = Words::new(locale);
            let mut working = document(&[Status::Completed, Status::InProgress, Status::Pending]);
            for item in &mut working.items {
                item.content.push_str(" 步骤 ✓ ◐ ○ 😀");
            }
            let view = panel(&working, "6".into(), &words);
            view.validate().unwrap();
            assert_eq!(view.title, title);
            let rows = view.root.children()[1].children()[0].children();
            for ((row, item), (mark, tone)) in rows.iter().zip(&working.items).zip([
                ("[x] ", Tone::Success),
                ("[>] ", Tone::Accent),
                ("[ ] ", Tone::Subtle),
            ]) {
                let Node::Text { spans, .. } = row else {
                    panic!("checklist row");
                };
                assert_eq!(spans[0].text, mark);
                assert_eq!(spans[0].tone, tone);
                assert_eq!(spans[1].text, item.content);
            }
            let status = line(&working, "6".into(), &words);
            status.validate().unwrap();
            assert!(
                serde_json::to_string(&status)
                    .unwrap()
                    .contains(&working.items[1].content)
            );
        }
    }
}
