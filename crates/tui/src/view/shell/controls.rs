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

use crate::ui::{Align, Node, On, Size, Tone};
use std::borrow::Cow;

/// A compact action uses the same layout, focus and hit geometry as any text.
pub(crate) fn compact<M>(
    key: impl Into<Cow<'static, str>>,
    label: String,
    tone: Tone,
    message: M,
    enabled: bool,
    hint: String,
) -> Node<M> {
    Node::text(key, vec![(label, tone)])
        .align(Align::Center)
        .clip()
        .size(Size::Fixed(3))
        .on(On::Activate(message))
        .enabled(enabled)
        .hint(hint)
}

/// A one-line summary reserves the status before clipping its descriptive name.
pub(crate) fn summary<M>(
    key: impl Into<Cow<'static, str>>,
    prefix: String,
    name: String,
    status: String,
    message: M,
    enabled: bool,
    hint: String,
) -> Node<M> {
    Node::row(
        key,
        vec![
            Node::text("prefix", vec![(prefix, Tone::Accent)]),
            Node::text("name", vec![(name, Tone::Muted)])
                .clip()
                .size(Size::Fill),
            Node::text("status", vec![(status, Tone::Subtle)]).clip(),
        ],
    )
    .size(Size::Fixed(1))
    .on(On::Activate(message))
    .enabled(enabled)
    .hint(hint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::{Context, Surface};
    use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    use ratatui::{Terminal, backend::TestBackend, layout::Rect};
    use unicode_width::UnicodeWidthStr;

    #[test]
    fn actions_center_graphemes_summaries_keep_the_scan_edge_and_disabled_targets_do_not_activate()
    {
        for title in ["关闭", "關閉", "Close", "⛭", "e\u{301}", "🦀"] {
            for padding in [2, 3] {
                let width = title.width() as u16 + padding;
                let mut surface = Surface::default();
                let compact = |key, message, enabled| {
                    compact(
                        key,
                        title.into(),
                        Tone::Muted,
                        message,
                        enabled,
                        "Hint".into(),
                    )
                    .size(Size::Fixed(width))
                };
                let tree = Node::column(
                    "controls",
                    vec![
                        Node::row("button", vec![compact("action", 1, true)]).size(Size::Fixed(1)),
                        summary(
                            "summary",
                            String::new(),
                            title.into(),
                            String::new(),
                            2,
                            true,
                            "Summary".into(),
                        ),
                        Node::row("disabled", vec![compact("action", 3, false)])
                            .size(Size::Fixed(1)),
                        Node::row("empty", vec![compact("action", 4, true)]).size(Size::Fixed(0)),
                    ],
                );
                let mut terminal = Terminal::new(TestBackend::new(20, 3)).unwrap();
                terminal
                    .draw(|frame| {
                        surface.render(
                            frame,
                            Rect::new(2, 0, width, 3),
                            tree.clone(),
                            Context {
                                colors: crate::theme::Palette::default(),
                                ascii: false,
                                focused: true,
                            },
                        )
                    })
                    .unwrap();
                let action = surface.rect("controls/button/action").unwrap();
                let summary = surface.rect("controls/summary").unwrap();
                let disabled = surface.rect("controls/disabled/action").unwrap();
                let empty = surface.rect("controls/empty/action").unwrap();
                let buffer = terminal.backend().buffer();
                let first = unicode_segmentation::UnicodeSegmentation::graphemes(title, true)
                    .next()
                    .unwrap();
                let centered = (action.x..action.right())
                    .find(|x| buffer[(*x, action.y)].symbol() == first)
                    .unwrap();
                let left = centered - action.x;
                let right = action.right() - centered - title.width() as u16;
                assert!(
                    left >= 1 && right >= 1 && left.abs_diff(right) <= 1,
                    "{title}: {left}/{right}"
                );
                assert_eq!(buffer[(summary.x, summary.y)].symbol(), first);
                assert_eq!(buffer[(centered, disabled.y)].symbol(), first);
                assert!(empty.is_empty());
                let click = |x, y| {
                    Event::Mouse(MouseEvent {
                        kind: MouseEventKind::Down(MouseButton::Left),
                        column: x,
                        row: y,
                        modifiers: KeyModifiers::NONE,
                    })
                };
                assert_eq!(
                    surface.input(&click(action.x, action.y)).message,
                    Some(1),
                    "leading padding stays clickable"
                );
                assert_eq!(
                    surface.input(&click(action.right() - 1, action.y)).message,
                    Some(1),
                    "trailing padding stays clickable"
                );
                assert_eq!(surface.input(&click(summary.x, summary.y)).message, Some(2));
                assert_eq!(surface.input(&click(disabled.x, disabled.y)).message, None);
                assert_eq!(
                    surface.input(&click(2, 3)).message,
                    None,
                    "empty target cannot activate"
                );
            }
        }
    }
}
