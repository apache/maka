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

use super::source::Source;
use crate::{
    i18n::I18n,
    ui::transcript::{
        self as ui,
        layout::{diff, syntax},
    },
};
use maka_plugins::terminal_ui::transcript as wire;

pub(super) fn sync(source: &Source, view: &mut ui::Transcript, i18n: &I18n, live: bool) {
    if live {
        view.begin_stream();
    } else {
        view.begin();
    }
    for block in source.blocks() {
        let key = ui::MessageKey::new(
            block.key.turn.clone(),
            block.key.message.clone(),
            match block.key.part {
                wire::Part::Text => ui::Part::Text,
                wire::Part::Thinking => ui::Part::Thinking,
                wire::Part::Tool => ui::Part::Tool,
            },
        );
        let kind = match block.kind {
            wire::Kind::User => ui::Kind::User,
            wire::Kind::Assistant => ui::Kind::Assistant,
            wire::Kind::Thinking => ui::Kind::Thinking,
            wire::Kind::Tool => ui::Kind::Tool(state(block.state.expect("validated tool state"))),
            wire::Kind::Failure => ui::Kind::Failure,
            wire::Kind::Other => ui::Kind::Other,
            wire::Kind::Meta => ui::Kind::Meta,
        };
        view.upsert(
            key.clone(),
            ui::Revision::External(block.revision.clone()),
            kind,
            || {
                let content = &block.content;
                ui::Content {
                    text: content.text.clone(),
                    changes: content
                        .diff
                        .iter()
                        .map(|row| diff::Row {
                            source: row.source.clone(),
                            kind: match row.kind {
                                wire::DiffKind::Removed => diff::Kind::Removed,
                                wire::DiffKind::Added => diff::Kind::Added,
                                wire::DiffKind::Context => diff::Kind::Context,
                                wire::DiffKind::Content => diff::Kind::Content,
                            },
                            language: row.language.as_deref().and_then(syntax::language),
                        })
                        .collect(),
                    file: content.link.as_ref().map(|link| crate::files::Link {
                        source: link.source.clone(),
                        path: link.path.clone(),
                    }),
                    emphasis: content.emphasis.clone(),
                }
            },
        );
        view.metadata(
            &key,
            block.timestamp_ms,
            block.affinity.map(|affinity| match affinity {
                wire::Affinity::Read => ui::Activity::Read,
                wire::Affinity::Search => ui::Activity::Search,
            }),
        );
    }
    view.finish(
        source.timings().iter().map(|timing| ui::Timing {
            turn: timing.turn.clone(),
            start: Some(timing.start_ms),
            active: timing.active,
            end: timing.end.as_ref().map(|end| {
                (
                    end.at_ms,
                    match end.outcome {
                        wire::Outcome::Completed => ui::Outcome::Completed,
                        wire::Outcome::Failed => ui::Outcome::Failed,
                        wire::Outcome::Aborted => ui::Outcome::Aborted,
                    },
                )
            }),
        }),
        i18n,
    );
}
fn state(state: wire::ToolState) -> ui::ToolState {
    match state {
        wire::ToolState::Pending => ui::ToolState::Pending,
        wire::ToolState::Waiting => ui::ToolState::Waiting,
        wire::ToolState::Returned => ui::ToolState::Returned,
        wire::ToolState::Attention => ui::ToolState::Attention,
        wire::ToolState::Failed => ui::ToolState::Failed,
        wire::ToolState::TimedOut => ui::ToolState::TimedOut,
        wire::ToolState::Cancelled => ui::ToolState::Cancelled,
        wire::ToolState::Completed => ui::ToolState::Completed,
        wire::ToolState::Missing => ui::ToolState::Missing,
    }
}
