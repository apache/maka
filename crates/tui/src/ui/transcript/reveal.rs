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

//! A bounded paint-only reveal: source and layout are always complete.
use super::layout::VisualLine;
use crate::theme::Palette;
use ratatui::{
    style::Color,
    text::{Line, Span},
};
use std::{
    ops::Range,
    time::{Duration, Instant},
};
use unicode_segmentation::UnicodeSegmentation;

const DURATION: Duration = Duration::from_millis(220);
const FRAME: Duration = Duration::from_millis(33);
const MAX_SPANS: usize = 8;

#[derive(Default)]
pub(super) struct Reveal {
    spans: Vec<(Range<usize>, Instant)>,
}
impl Reveal {
    pub fn clear(&mut self) {
        self.spans = Vec::new();
    }
    pub fn expire(&mut self, now: Option<Instant>) {
        self.spans.retain(|(_, start)| {
            now.is_some_and(|now| now.saturating_duration_since(*start) < DURATION)
        });
        if self.spans.is_empty() {
            self.clear();
        }
    }
    pub fn bytes(&self) -> usize {
        self.spans.capacity() * std::mem::size_of::<(Range<usize>, Instant)>()
    }
    pub fn append(&mut self, source: Range<usize>, now: Option<Instant>) {
        self.expire(now);
        let Some(now) = now.filter(|_| !source.is_empty()) else {
            return;
        };
        // A transport burst never creates a character backlog or resets older text.
        if self.spans.len() == MAX_SPANS {
            self.spans.remove(0);
        }
        self.spans.push((source, now));
    }
    pub fn paint(
        &self,
        visual: &VisualLine,
        line: &mut Line<'static>,
        now: Option<Instant>,
        colors: Palette,
    ) -> Option<Duration> {
        let now = now.filter(|_| !colors.terminal)?;
        let mut ranges = Vec::new();
        for (source, start) in &self.spans {
            let elapsed = now.saturating_duration_since(*start);
            if elapsed >= DURATION {
                continue;
            }
            let t = elapsed.as_secs_f32() / DURATION.as_secs_f32();
            let strength = 1.0 - 0.18 * (1.0 - t).powi(2);
            for mapping in &visual.mapping {
                if let Some(display) = mapping.intersection(source) {
                    ranges.push((display, strength, FRAME.min(DURATION - elapsed)));
                }
            }
        }
        if ranges.is_empty() {
            return None;
        }
        let mut output: Vec<Span<'static>> = Vec::new();
        let mut offset = 0;
        let mut wake = None;
        for span in std::mem::take(&mut line.spans) {
            for (index, grapheme) in span.content.grapheme_indices(true) {
                let start = offset + index;
                let end = start + grapheme.len();
                let mut style = span.style;
                // An appended combining mark or ZWJ colors the whole grapheme.
                if let Some((_, strength, wait)) = ranges
                    .iter()
                    .rev()
                    .find(|(range, _, _)| start < range.end && end > range.start)
                {
                    let foreground = style.fg.or(line.style.fg).unwrap_or(colors.foreground);
                    let background = style.bg.or(line.style.bg).unwrap_or(colors.background);
                    if let Some(color) = blend(foreground, background, *strength)
                        && color != foreground
                    {
                        style.fg = Some(color);
                        wake = Some(wake.map_or(*wait, |old: Duration| old.min(*wait)));
                    }
                }
                if let Some(previous) = output.last_mut().filter(|last| last.style == style) {
                    previous.content.to_mut().push_str(grapheme);
                } else {
                    output.push(Span::styled(grapheme.to_owned(), style));
                }
            }
            offset += span.content.len();
        }
        line.spans = output;
        wake
    }
}

fn blend(foreground: Color, background: Color, strength: f32) -> Option<Color> {
    let (Color::Rgb(r, g, b), Color::Rgb(br, bg, bb)) = (foreground, background) else {
        // Terminal-owned and ANSI colors have no known RGB background to blend against.
        return None;
    };
    let channel =
        |fg: u8, bg: u8| (f32::from(bg) + (f32::from(fg) - f32::from(bg)) * strength).round() as u8;
    Some(Color::Rgb(channel(r, br), channel(g, bg), channel(b, bb)))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        i18n::{I18n, Locale, LocalePreference},
        ui::transcript::{
            Kind, MessageKey, Part, Revision, Transcript, search, selection::CopyMode,
        },
    };
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer, widgets::Block};

    fn record(view: &mut Transcript, text: &str, revision: Revision, live: bool) {
        if live {
            view.begin_stream();
        } else {
            view.begin();
        }
        view.upsert(
            MessageKey::new("turn", "text", Part::Text),
            revision,
            Kind::Assistant,
            || text.to_owned().into(),
        );
        view.finish(
            [],
            &I18n::new(LocalePreference::Explicit(Locale::En), Locale::En),
        );
    }
    fn draw(view: &mut Transcript) -> Buffer {
        let mut terminal = Terminal::new(TestBackend::new(60, 8)).unwrap();
        terminal
            .draw(|frame| {
                frame.render_widget(Block::default().style(view.colors.base()), frame.area());
                view.draw(frame, frame.area(), false).unwrap();
            })
            .unwrap();
        terminal.backend().buffer().clone()
    }
    fn decoration(buffer: &Buffer) -> Vec<(&str, Color, ratatui::style::Modifier)> {
        buffer
            .content
            .iter()
            .map(|cell| (cell.symbol(), cell.bg, cell.modifier))
            .collect()
    }
    fn color(buffer: &Buffer, symbol: &str) -> Color {
        buffer
            .content
            .iter()
            .find(|cell| cell.symbol() == symbol)
            .unwrap()
            .fg
    }

    #[test]
    fn live_reveal_keeps_complete_unicode_source_geometry_and_completion() {
        let start = Instant::now();
        let mut view = Transcript::default();
        view.motion(Some(start));
        record(&mut view, "prefix e", Revision::Durable(1), false);
        draw(&mut view);
        assert!(view.motion_wait().is_none(), "history is settled");
        let text = "prefix e\u{301}中👩‍💻";
        record(&mut view, text, Revision::Live(2), false);
        let first = draw(&mut view);
        assert_eq!(view.copy_text(CopyMode::Source, false).unwrap(), text);
        assert_eq!(view.motion_wait(), Some(FRAME));
        let builds = view.builds;
        view.motion(Some(start + Duration::from_millis(110)));
        record(&mut view, text, Revision::Durable(3), false);
        let middle = draw(&mut view);
        assert_ne!(color(&first, "中"), color(&middle, "中"));
        view.motion(Some(start + DURATION));
        let settled = draw(&mut view);
        assert_eq!(color(&settled, "中"), view.colors.foreground);
        assert_eq!(color(&first, "p"), color(&settled, "p"));
        assert_eq!(decoration(&first), decoration(&settled));
        assert!(first.content.iter().any(|cell| cell.symbol() == "e\u{301}"));
        assert_eq!(view.builds, builds, "paint and completion reuse layout");
        assert!(view.motion_wait().is_none());
    }

    #[test]
    fn external_updates_preserve_syntax_search_selection_and_motion_policy() {
        let start = Instant::now();
        for colors in [Palette::default(), crate::theme::Choice::Paper.colors()] {
            let mut view = Transcript {
                colors,
                ..Default::default()
            };
            view.motion(Some(start));
            record(
                &mut view,
                "```rust\nlet n = 4;\n```",
                Revision::External("new".into()),
                true,
            );
            let first = draw(&mut view);
            assert!(view.motion_wait().is_some());
            view.motion(Some(start + DURATION));
            let settled = draw(&mut view);
            assert_ne!(color(&first, "l"), color(&settled, "l"));
            assert_ne!(color(&settled, "l"), color(&settled, "4"));
            assert_eq!(decoration(&first), decoration(&settled));
        }
        let mut view = Transcript::default();
        view.motion(Some(start));
        record(&mut view, "中文", Revision::External("1".into()), true);
        draw(&mut view);
        view.search_command(search::Command::Open);
        view.search.as_mut().unwrap().editor.insert("中");
        view.refresh_search(false);
        let searched = draw(&mut view);
        assert_eq!(color(&searched, "中"), view.colors.search_text);
        view.search_command(search::Command::Close);
        view.selection_key(crossterm::event::KeyCode::Right);
        let selected = draw(&mut view);
        assert_eq!(view.copy_text(CopyMode::Selection, false).unwrap(), "中");
        assert_eq!(color(&selected, "中"), view.colors.selection_text);
        view.text_selection.clear();
        view.motion(None);
        let static_frame = draw(&mut view);
        assert_eq!(color(&static_frame, "中"), view.colors.foreground);
        assert!(view.motion_wait().is_none());
        view.colors = crate::theme::Choice::Terminal.colors();
        view.motion(Some(start));
        record(&mut view, "中文末", Revision::External("2".into()), true);
        assert_eq!(color(&draw(&mut view), "末"), Color::Reset);
        assert!(view.motion_wait().is_none());
    }

    #[test]
    fn bursts_are_bounded_and_pages_or_offscreen_text_do_not_request_frames() {
        let start = Instant::now();
        let mut view = Transcript::default();
        for revision in 1..=100 {
            view.motion(Some(start));
            record(
                &mut view,
                &"x".repeat(revision),
                Revision::Live(revision as u64),
                false,
            );
        }
        draw(&mut view);
        let key = MessageKey::new("turn", "text", Part::Text);
        assert_eq!(view.blocks[&key].text.len(), 100);
        assert_eq!(view.blocks[&key].reveal.spans.len(), MAX_SPANS);
        view.motion(Some(start + DURATION));
        record(&mut view, "page", Revision::External("p".into()), false);
        draw(&mut view);
        assert!(view.motion_wait().is_none());
        view.motion(Some(start + DURATION));
        record(&mut view, "page new", Revision::External("e".into()), true);
        view.upsert(
            MessageKey::new("turn", "tail", Part::Text),
            Revision::Durable(1),
            Kind::Assistant,
            || "later\n\n".repeat(30).into(),
        );
        draw(&mut view);
        assert!(view.motion_wait().is_none(), "hidden content owns no timer");
    }
}
