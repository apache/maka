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
use crate::{app::Hit, pages::chat::history::History};

pub(super) fn draw(
    frame: &mut Frame<'_>,
    history: &mut History,
    area: Rect,
    i18n: &crate::i18n::I18n,
    ascii: bool,
    colors: crate::theme::Palette,
    available: bool,
) -> Vec<Hit> {
    history.list_area = None;
    history.preview_area = None;
    history.prepare_preview(i18n, ascii);
    if area.is_empty() {
        history.invalidate_geometry();
        return vec![];
    }
    use crate::ui::{Context, Node, On, Size, Tone};
    let items = history
        .matches
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let selected = index == history.selected;
            let marker = if selected {
                if ascii { ">" } else { "›" }
            } else {
                " "
            };
            Node::text(
                item.sequence.to_string(),
                vec![
                    (format!("{marker} "), Tone::Accent),
                    (safe(&item.preview), Tone::Normal),
                ],
            )
            .clip()
            .current(selected)
            .on(On::Activate(Command::Pick(item.sequence)))
        })
        .collect();
    let list = Node::scroll("matches", Node::column("rows", items));
    let message = if !available {
        Some("chat-search-connect")
    } else if history.error.is_some() {
        // The session's single feedback row owns the summary and opt-in detail.
        None
    } else if history.matches.is_empty() {
        Some(if history.query_empty() {
            "chat-search-history-prompt"
        } else if history.scanning {
            "chat-search-scanning"
        } else {
            "chat-search-no-matches"
        })
    } else {
        None
    };
    let body = if let Some(message) = message {
        Node::text("notice", vec![(i18n.text(message), Tone::Subtle)]).size(Size::Fill)
    } else if history.preview.is_some() {
        Node::transcript("preview", uuid::Uuid::nil())
    } else {
        let text = if history.preview_loading {
            i18n.text("chat-search-preview-loading")
        } else {
            String::new()
        };
        Node::text("notice", vec![(text, Tone::Subtle)]).size(Size::Fill)
    };
    let tree = if area.width >= 100 {
        Node::row(
            "history",
            vec![
                list.size(Size::Fixed(area.width * 34 / 100)),
                Node::rule("divider"),
                body,
            ],
        )
    } else {
        let rows = (area.height / 3)
            .clamp(1, 6)
            .min(history.matches.len().max(1) as u16);
        Node::column(
            "history",
            vec![list.size(Size::Fixed(rows)), Node::rule("divider"), body],
        )
    };
    if let Some(selected) = history.matches.get(history.selected) {
        let path = format!("history/matches/rows/{}", selected.sequence);
        if history.reader_surface.focused() != Some(path.as_str()) {
            history.reader_surface.focus(path.clone());
            history.reader_surface.reveal_item(&path);
        }
    }
    let context = Context {
        colors,
        ascii,
        focused: false,
    };
    history.reader_surface.render(frame, area, tree, context);
    history.list_area = history.reader_surface.viewport("history/matches");
    history.preview_area = history.reader_surface.transcript_area(uuid::Uuid::nil());
    let mut hits = Vec::new();
    if message.is_none()
        && let Some(preview) = &mut history.preview
    {
        preview.colors = colors;
        match history.reader_surface.paint_transcript(
            frame,
            uuid::Uuid::nil(),
            preview,
            context,
            false,
        ) {
            Ok(found) => hits.extend(found.into_iter().filter_map(|hit| {
                use crate::ui::transcript::Effect;
                let action = match hit.effect {
                    Effect::Disclosure(key) => Action::Search(Command::PreviewToggle(key)),
                    Effect::Link { key, revision } => {
                        Action::CopyFile(preview.link(&key, &revision)?.into())
                    }
                };
                Some(Hit {
                    area: hit.area,
                    action,
                })
            })),
            Err(error) => history.fail(error.into()),
        }
    }
    hits
}
