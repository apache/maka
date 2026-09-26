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

use super::{Collection, Control};
use crate::ui::{Node, On, Size, Tone};
use unicode_width::UnicodeWidthStr;

impl Collection {
    pub(crate) fn paint_query(
        &self,
        frame: &mut ratatui::Frame<'_>,
        area: ratatui::layout::Rect,
        focused: bool,
        colors: crate::theme::Palette,
        label: &str,
        placeholder: &str,
    ) {
        if area.is_empty() {
            return;
        }
        crate::view::form::draw(
            frame,
            area,
            (label.width() as u16 + 2).min(area.width * 2 / 5),
            crate::view::form::Row {
                label,
                focused,
                masked: false,
                placeholder: Some(placeholder),
            },
            &mut self.0.lock().unwrap().query,
            colors,
        );
    }

    /// The common native collection body; an ordinary Split may compose its panel.
    pub fn node<M: Clone>(
        &self,
        key: &str,
        groups: &[(String, String)],
        filter: Option<(&str, &str)>,
        select: M,
        commit: Option<M>,
        width: u16,
    ) -> Node<M> {
        let mut children = vec![];
        if let Some((label, placeholder)) = filter {
            children.push(Node::slot("filter", 1).on(On::Collection(Control::Query {
                state: self.clone(),
                label: label.into(),
                placeholder: placeholder.into(),
            })));
        }
        let selected = self.selected();
        let preview = self.preview();
        let items = self.visible();
        let narrow = width < 48;
        let lanes = groups
            .iter()
            .map(|(group, label)| {
                let mut rows = vec![Node::text("title", vec![(label.clone(), Tone::Strong)])];
                for item in items.iter().filter(|item| item.group == *group) {
                    let moving = preview
                        .as_ref()
                        .is_some_and(|preview| preview.item == item.key);
                    let mut text = vec![
                        Node::text(
                            "title",
                            vec![(
                                item.title.clone(),
                                if moving { Tone::Accent } else { Tone::Normal },
                            )],
                        )
                        .clip(),
                    ];
                    if !item.summary.is_empty() {
                        text.push(
                            Node::text("summary", vec![(item.summary.clone(), Tone::Muted)]).clip(),
                        );
                    }
                    rows.push(
                        Node::boundary(item.key.clone(), Node::column("card", text))
                            .on(On::Collection(Control::Item {
                                state: self.clone(),
                                item: item.key.clone(),
                                select: select.clone(),
                                commit: commit.clone(),
                            }))
                            .current(selected.as_deref() == Some(item.key.as_str())),
                    );
                }
                Node::column(group.clone(), rows)
                    .gap(1)
                    .focus_group()
                    .on(On::Collection(Control::Destination {
                        state: self.clone(),
                        group: group.clone(),
                    }))
                    .size(if narrow { Size::Content } else { Size::Fill })
            })
            .collect();
        children.push(if narrow {
            Node::column("groups", lanes).gap(1)
        } else {
            Node::row("groups", lanes).gap(1)
        });
        Node::column(key.to_owned(), children).gap(1)
    }
}
