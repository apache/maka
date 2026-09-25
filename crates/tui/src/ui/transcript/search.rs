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
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};

mod bar;

const MAX_MATCHES: usize = 4096;
#[cfg(test)]
const MATCH_BACKGROUND: Color = Color::Rgb(75, 66, 47);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open,
    Close,
    Next,
    Previous,
    Scope,
    Restart,
    Pick(u64),
    PreviewToggle(MessageKey),
}

#[derive(Clone, PartialEq, Eq)]
struct Match {
    key: MessageKey,
    source: usize,
}

/// Transient find state; history previews never replace the live transcript.
pub struct Search {
    pub history: bool,
    pub editor: crate::editor::Editor,
    matches: Vec<Match>,
    active: Option<Match>,
    pub limited: bool,
    pub(crate) bar: crate::ui::Surface<Command>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Saved {
    query: String,
    history: bool,
    active: Option<(MessageKey, usize)>,
}
impl Saved {
    pub(super) fn valid(&self) -> bool {
        self.query.len() <= 512
            && !self.query.chars().any(char::is_control)
            && self
                .active
                .as_ref()
                .is_none_or(|(key, source)| key.valid() && *source <= 64 * 1024 * 1024)
    }
    pub(super) fn bytes(&self) -> usize {
        self.query.len() * 2 + self.active.as_ref().map_or(0, |(key, _)| key.budget()) + 128
    }
    pub(super) fn restore(self) -> Search {
        let mut search = Search {
            history: self.history,
            ..Search::default()
        };
        search.editor.insert(&self.query);
        search.active = self.active.map(|(key, source)| Match { key, source });
        search
    }
}
impl Default for Search {
    fn default() -> Self {
        Self {
            history: false,
            editor: crate::editor::Editor::bounded(512, "chat-search-too-long"),
            matches: vec![],
            active: None,
            limited: false,
            bar: Default::default(),
        }
    }
}
impl Search {
    pub(super) fn saved(&self) -> Saved {
        Saved {
            query: self.editor.text().into(),
            history: self.history,
            active: self
                .active
                .as_ref()
                .map(|found| (found.key.clone(), found.source)),
        }
    }
    pub(super) fn suspend(&mut self) {
        self.invalidate_geometry();
        self.matches = Vec::new();
    }
    pub fn invalidate_geometry(&mut self) {
        self.editor.invalidate_geometry();
        self.bar.invalidate();
    }
    pub(super) fn retained_bytes(&self) -> usize {
        self.editor.retained_bytes()
            + self.editor.text().len()
            + self.active.as_ref().map_or(0, |found| found.key.bytes())
    }
    pub(super) fn highlight(
        &self,
        key: &MessageKey,
        visual: &layout::VisualLine,
        line: &mut Line<'static>,
        colors: crate::theme::Palette,
    ) {
        let (start, end) = visual
            .mapping
            .iter()
            .fold((usize::MAX, 0), |(start, end), span| {
                (start.min(span.source.start), end.max(span.source.end))
            });
        let length = self.editor.text().len();
        let ranges: Vec<_> = self
            .matches
            .iter()
            .filter(|found| {
                &found.key == key && found.source < end && found.source + length > start
            })
            .map(|found| {
                (
                    found.source..found.source + length,
                    self.active.as_ref() == Some(found),
                )
            })
            .collect();
        highlight(line, &visual.mapping, &ranges, colors);
    }
    pub fn count(&self) -> String {
        let current = self
            .active
            .as_ref()
            .and_then(|active| self.matches.iter().position(|item| item == active))
            .map_or(0, |index| index + 1);
        format!(
            "{current}/{}{}",
            self.matches.len(),
            if self.limited { "+" } else { "" }
        )
    }
}

impl Transcript {
    pub fn take_search_commands(&mut self) -> Vec<Command> {
        std::mem::take(&mut self.search_commands)
    }
    pub fn search_command(&mut self, command: Command) {
        match command {
            Command::Open => {
                self.search.get_or_insert_with(Search::default);
                self.selected = None;
            }
            Command::Close => self.search = None,
            Command::Scope => {
                let search = self.search.get_or_insert_with(Search::default);
                search.history = !search.history;
                self.search_commands.push(Command::Scope);
                self.refresh_search(true);
            }
            Command::Restart | Command::Pick(_) | Command::PreviewToggle(_) => {
                self.search_commands.push(command);
            }
            Command::Next | Command::Previous => {
                let Some(search) = &mut self.search else {
                    return;
                };
                if search.history {
                    self.search_commands.push(command);
                    return;
                }
                if search.matches.is_empty() {
                    return;
                }
                let current = search
                    .active
                    .as_ref()
                    .and_then(|active| search.matches.iter().position(|item| item == active))
                    .unwrap_or(0);
                let next = if command == Command::Next {
                    (current + 1) % search.matches.len()
                } else {
                    (current + search.matches.len() - 1) % search.matches.len()
                };
                search.active = Some(search.matches[next].clone());
                self.reveal_match();
            }
        }
    }

    pub(super) fn refresh_search(&mut self, reveal: bool) {
        let Some(search) = &mut self.search else {
            return;
        };
        if search.history {
            return;
        }
        search.matches.clear();
        search.limited = false;
        let query = search.editor.text();
        if !query.is_empty() {
            'blocks: for key in &self.source_order {
                let block = &self.blocks[key];
                if matches!(block.kind, Kind::Meta | Kind::Timing) {
                    continue;
                }
                for (source, _) in block.text.match_indices(query) {
                    if search.matches.len() == MAX_MATCHES {
                        search.limited = true;
                        break 'blocks;
                    }
                    search.matches.push(Match {
                        key: key.clone(),
                        source,
                    });
                }
            }
        }
        if reveal
            || !search
                .active
                .as_ref()
                .is_some_and(|active| search.matches.contains(active))
        {
            search.active = search.matches.first().cloned();
        }
        // Appends/prepends update the count, but never move the user's viewport.
        if reveal {
            self.reveal_match();
        }
    }

    fn reveal_match(&mut self) {
        let Some(found) = self
            .search
            .as_ref()
            .and_then(|search| search.active.clone())
        else {
            return;
        };
        if let Some(block) = self.blocks.get_mut(&found.key) {
            block.folded = false;
            block.layout = None;
        }
        self.arrange_groups();
        self.selected = None;
        self.anchor = Some(Anchor {
            key: found.key,
            source: found.source,
            screen_row: self.height / 3,
        });
    }

    /// Search owns text entry, not global navigation or modal authority.
    pub fn search_input(&mut self, event: &Event) -> Option<bool> {
        let search = self.search.as_mut()?;
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && matches!(key.code, KeyCode::Char('q' | 'p' | 'b'))
                    || key.modifiers.contains(KeyModifiers::ALT)
                        && matches!(key.code, KeyCode::Left | KeyCode::Right)
                    || matches!(key.code, KeyCode::F(1 | 11))
                {
                    return None;
                }
                match key.code {
                    KeyCode::Char('r')
                        if key.modifiers.contains(KeyModifiers::CONTROL) && search.history =>
                    {
                        self.search_command(Command::Restart)
                    }
                    KeyCode::Up | KeyCode::Down if search.history => {
                        self.search_command(if key.code == KeyCode::Down {
                            Command::Next
                        } else {
                            Command::Previous
                        });
                    }
                    KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab => {
                        self.search_command(Command::Close);
                    }
                    KeyCode::Enter | KeyCode::F(3) => {
                        self.search_command(if key.modifiers.contains(KeyModifiers::SHIFT) {
                            Command::Previous
                        } else {
                            Command::Next
                        });
                    }
                    KeyCode::Char('f') if key.modifiers.contains(KeyModifiers::CONTROL) => {}
                    _ => {
                        let before = search.editor.text().to_owned();
                        search.editor.key(*key);
                        if before != search.editor.text() {
                            self.refresh_search(true);
                        }
                    }
                }
                Some(true)
            }
            Event::Paste(text) => {
                // Single-line find: pasting can neither submit a message nor add hidden rows.
                search.editor.insert(&text.replace(['\r', '\n', '\t'], " "));
                self.refresh_search(true);
                Some(true)
            }
            Event::Mouse(mouse) => {
                let point = ratatui::layout::Position::new(mouse.column, mouse.row);
                if search.editor.contains(point) || search.editor.dragging() {
                    return Some(search.editor.mouse(*mouse));
                }
                let outcome = search.bar.input(event);
                if outcome.consumed {
                    if let Some(command) = outcome.message {
                        self.search_command(command);
                    }
                    return Some(outcome.redraw);
                }
                None
            }
            _ => None,
        }
    }
}

/// Split styled spans only in visible rows; preserve Markdown emphasis and links.
fn highlight(
    line: &mut Line<'static>,
    mapping: &[layout::SourceSpan],
    matches: &[(std::ops::Range<usize>, bool)],
    colors: crate::theme::Palette,
) {
    if matches.is_empty() {
        return;
    }
    let mapped: Vec<_> = mapping
        .iter()
        .flat_map(|span| {
            matches.iter().filter_map(|(range, active)| {
                span.intersection(range).map(|range| (range, *active))
            })
        })
        .collect();
    paint(
        line,
        &mapped,
        [
            Style::default().bg(colors.search).fg(colors.foreground),
            Style::default()
                .bg(colors.search_active)
                .fg(colors.search_text),
        ],
    );
}

pub(super) fn paint(
    line: &mut Line<'static>,
    mapped: &[(std::ops::Range<usize>, bool)],
    styles: [Style; 2],
) {
    let text = line.to_string();
    let mut ranges: Vec<(std::ops::Range<usize>, bool)> = vec![];
    // Expand to complete displayed graphemes: a combining mark or ZWJ must not be split.
    for (start, grapheme) in text.grapheme_indices(true) {
        let end = start + grapheme.len();
        let mut active = None;
        for (range, current) in mapped {
            if range.start < end && range.end > start {
                active = Some(active.unwrap_or(false) || *current);
            }
        }
        if let Some(active) = active {
            if let Some((last, last_active)) = ranges.last_mut()
                && last.end == start
                && *last_active == active
            {
                last.end = end;
            } else {
                ranges.push((start..end, active));
            }
        }
    }
    if ranges.is_empty() {
        return;
    }
    let mut offset = 0;
    let mut spans = vec![];
    for span in std::mem::take(&mut line.spans) {
        let end = offset + span.content.len();
        let mut at = offset;
        for (range, active) in ranges
            .iter()
            .filter(|(range, _)| range.start < end && range.end > offset)
        {
            let start = range.start.max(offset);
            let stop = range.end.min(end);
            if start > at {
                spans.push(Span::styled(
                    span.content[at - offset..start - offset].to_owned(),
                    span.style,
                ));
            }
            spans.push(Span::styled(
                span.content[start - offset..stop - offset].to_owned(),
                span.style.patch(styles[usize::from(*active)]),
            ));
            at = stop;
        }
        if at < end {
            spans.push(Span::styled(
                span.content[at - offset..].to_owned(),
                span.style,
            ));
        }
        offset = end;
    }
    line.spans = spans;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::{Action, App},
        i18n::{I18n, Locale, LocalePreference},
        navigation::Route,
    };
    use crossterm::event::{KeyEvent, MouseButton, MouseEvent, MouseEventKind};
    use ratatui::{Terminal, backend::TestBackend};
    use serde_json::json;

    fn key(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(code, modifiers))
    }
    fn frame(view: &mut Transcript, width: u16) {
        Terminal::new(TestBackend::new(width, 8))
            .unwrap()
            .draw(|frame| {
                view.draw(frame, frame.area(), false).unwrap();
            })
            .unwrap();
    }

    #[test]
    fn find_opens_nested_results_and_keeps_identity_through_prepend_stream_and_reflow() {
        let i18n = I18n::new(LocalePreference::Explicit(Locale::ZhCn), Locale::En);
        let mut rows = BTreeMap::from([
            (
                10,
                json!({"type":"user","turnId":"t","id":"u","text":"中文🦀 question"}),
            ),
            (
                20,
                json!({"type":"assistant","turnId":"t","id":"a","text":"A long answer\n".repeat(20)}),
            ),
        ]);
        for (seq, id) in [(30, "one"), (40, "two")] {
            rows.insert(seq, json!({"type":"tool_call","turnId":"t","id":id,"toolName":"Read","origin":"code_mode","args":{"path":id}}));
            rows.insert(seq + 50, json!({"type":"tool_result","turnId":"t","id":format!("r-{id}"),"toolUseId":id,"origin":"code_mode","isError":false,"content":{"kind":"text","text":"Result\n中文🦀"}}));
        }
        let mut view = Transcript::default();
        view.sync(&rows, &[], 0, &i18n, false);
        frame(&mut view, 50);
        view.search_command(Command::Open);
        assert_eq!(
            view.search_input(&Event::Paste("中文🦀".into())),
            Some(true)
        );
        assert_eq!(view.search.as_ref().unwrap().count(), "1/3");
        view.search_command(Command::Next);
        let found = view.search.as_ref().unwrap().active.clone().unwrap();
        assert_eq!(found.key.message, "one");
        assert!(!view.folded(&found.key));
        assert!(view.order.contains(&found.key));
        frame(&mut view, 25);
        let anchor = view.anchor.clone().unwrap();
        rows.insert(
            1,
            json!({"type":"user","turnId":"old","id":"old","text":"中文🦀"}),
        );
        let mut stream = LiveText::default();
        stream.text = "中文🦀".into();
        let live = vec![(
            SessionAssistantStreamIdentity {
                kind: AssistantStreamKind::Text,
                turn_id: "t".into(),
                message_id: "new".into(),
            },
            stream,
        )];
        view.sync(&rows, &live, 1, &i18n, false);
        frame(&mut view, 45);
        assert_eq!(view.search.as_ref().unwrap().count(), "3/5");
        assert!(view.search.as_ref().unwrap().active.as_ref() == Some(&found));
        assert_eq!(view.anchor.as_ref().unwrap().key, anchor.key);
        assert_eq!(view.anchor.as_ref().unwrap().source, anchor.source);
        view.search_command(Command::Previous);
        assert_eq!(view.search.as_ref().unwrap().count(), "2/5");
        view.search_command(Command::Previous);
        view.search_command(Command::Previous);
        assert_eq!(view.search.as_ref().unwrap().count(), "5/5");
        let selected_live = view.search.as_ref().unwrap().active.clone();
        rows.insert(
            100,
            json!({"type":"assistant","turnId":"t","id":"new","text":"中文🦀"}),
        );
        view.sync(&rows, &[], 2, &i18n, false);
        assert!(view.search.as_ref().unwrap().active == selected_live);
        assert_eq!(view.search.as_ref().unwrap().count(), "5/5");

        let mut line = Line::from(vec![
            Span::raw("a 中"),
            Span::styled("文🦀 z", Style::default().add_modifier(Modifier::BOLD)),
        ]);
        highlight(
            &mut line,
            &[layout::SourceSpan {
                display: 0.."a 中文🦀 z".len(),
                source: 0.."a 中文🦀 z".len(),
                logical: 0.."a 中文🦀 z".len(),
                exact: true,
            }],
            &[(2..2 + "中文🦀".len(), true)],
            crate::theme::Palette::default(),
        );
        assert_eq!(line.to_string(), "a 中文🦀 z");
        assert_eq!(
            line.spans
                .iter()
                .filter(|s| s.style.bg == Some(crate::theme::Palette::default().search_active))
                .map(|s| s.content.as_ref())
                .collect::<String>(),
            "中文🦀"
        );
        assert!(
            line.spans
                .iter()
                .any(|s| s.content == "文🦀" && s.style.add_modifier.contains(Modifier::BOLD))
        );
        rows.insert(101, json!({"type":"assistant","turnId":"t","id":"many","text":"中文🦀".repeat(MAX_MATCHES)}));
        view.sync(&rows, &[], 2, &i18n, false);
        assert_eq!(view.search.as_ref().unwrap().matches.len(), MAX_MATCHES);
        assert!(view.search.as_ref().unwrap().limited);
    }

    #[test]
    fn source_highlights_cross_soft_wrap_without_coloring_gutters_and_follow_the_current_match() {
        let i18n = I18n::new(LocalePreference::Explicit(Locale::En), Locale::En);
        let mut view = Transcript::default();
        view.sync(
            &BTreeMap::from([(
                1,
                json!({"type":"assistant","id":"m","turnId":"t","text":"**中文🦀** then 中文🦀"}),
            )]),
            &[],
            0,
            &i18n,
            false,
        );
        view.search_command(Command::Open);
        view.search_input(&Event::Paste("中文🦀".into()));
        for width in [6, 10, 80] {
            let mut terminal = Terminal::new(TestBackend::new(width, 20)).unwrap();
            for _ in 0..2 {
                terminal
                    .draw(|frame| {
                        view.draw(frame, frame.area(), false).unwrap();
                    })
                    .unwrap();
                let highlighted = |color| {
                    terminal
                        .backend()
                        .buffer()
                        .content
                        .iter()
                        .filter(|cell| cell.bg == color)
                        .map(|cell| cell.symbol())
                        .collect::<String>()
                };
                assert_eq!(
                    highlighted(crate::theme::Palette::default().search_active),
                    "中文🦀"
                );
                assert_eq!(highlighted(MATCH_BACKGROUND), "中文🦀");
                view.search_command(Command::Next);
            }
        }
        // Table visual rows interleave columns. An anchor in a later column must use its
        // source span, not the first column's line-start offset.
        view.sync(&BTreeMap::from([(2, json!({"type":"assistant","id":"table","turnId":"t","text":"| Short | Long |\n|---|---|\n| x | abcdefghijklmnopqrstuvwxyz needle |\n"}))]), &[], 1, &i18n, false);
        view.search_command(Command::Close);
        view.search_command(Command::Open);
        view.search_input(&Event::Paste("needle".into()));
        let mut terminal = Terminal::new(TestBackend::new(20, 3)).unwrap();
        terminal
            .draw(|frame| {
                view.draw(frame, frame.area(), false).unwrap();
            })
            .unwrap();
        let highlighted = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .filter(|cell| cell.bg == crate::theme::Palette::default().search_active)
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert_eq!(highlighted, "needle");
        view.sync(
            &BTreeMap::from([(
                3,
                json!({"type":"user","id":"unicode","turnId":"t","text":"e\u{301} 👩‍💻"}),
            )]),
            &[],
            2,
            &i18n,
            false,
        );
        for (query, expected) in [("\u{301}", "e\u{301}"), ("💻", "👩‍💻")] {
            view.search_command(Command::Close);
            view.search_command(Command::Open);
            view.search_input(&Event::Paste(query.into()));
            terminal
                .draw(|frame| {
                    view.draw(frame, frame.area(), false).unwrap();
                })
                .unwrap();
            let highlighted = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .filter(|cell| cell.bg == crate::theme::Palette::default().search_active)
                .map(|cell| cell.symbol())
                .collect::<String>();
            assert_eq!(
                highlighted, expected,
                "partial source matches highlight complete graphemes"
            );
        }
    }

    #[test]
    fn find_keyboard_mouse_and_paste_are_isolated_from_composer_and_hidden_modals() {
        for locale in Locale::ALL {
            let mut app = App::new(
                "/fixture".into(),
                I18n::new(LocalePreference::Explicit(locale), locale),
            );
            app.apply(Action::Visit(Route::Session("chat".into())));
            app.chat.select(&Route::Session("chat".into()));
            app.input(Event::Paste("keep draft".into()));
            app.chat.view.sync(
                &BTreeMap::from([(
                    1,
                    json!({"type":"user","turnId":"t","id":"u","text":"中文 first 中文 second"}),
                )]),
                &[],
                0,
                &app.i18n,
                false,
            );
            // Opening find after a header action retains the outer focus.
            // Its Enter must still navigate matches, never activate Header Back.
            Terminal::new(TestBackend::new(80, 24))
                .unwrap()
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            app.focus = crate::app::Focus::Header;
            app.chrome.header.focus("header/left/back".into());
            let location = app.navigation.location().clone();
            app.input(key(KeyCode::Char('f'), KeyModifiers::CONTROL));
            app.input(Event::Paste("中文".into()));
            assert_eq!(app.chat.view.search.as_ref().unwrap().count(), "1/2");
            assert!(
                app.input(key(KeyCode::Enter, KeyModifiers::NONE))
                    .1
                    .is_none()
            );
            assert_eq!(app.chat.view.search.as_ref().unwrap().count(), "2/2");
            assert_eq!(app.navigation.location(), &location);
            assert_eq!(app.drafts["chat"].text(), "keep draft");
            for width in [30, 80, 120] {
                app.input(Event::Resize(width, 20));
                let mut terminal = Terminal::new(TestBackend::new(width, 20)).unwrap();
                terminal
                    .draw(|frame| crate::view::draw(frame, &mut app))
                    .unwrap();
                let area = app
                    .chat
                    .view
                    .search
                    .as_ref()
                    .unwrap()
                    .bar
                    .rect("find/previous")
                    .unwrap();
                assert!(area.right() <= width);
                app.input(Event::Mouse(MouseEvent {
                    kind: MouseEventKind::Moved,
                    column: area.x,
                    row: area.y,
                    modifiers: KeyModifiers::NONE,
                }));
                assert!(app.hover.is_none(), "find controls keep one hit registry");
                assert!(
                    app.tooltip_wait().is_some(),
                    "fresh hover after resize {width}"
                );
                app.hover_since =
                    Some(std::time::Instant::now() - std::time::Duration::from_millis(500));
                assert!(app.tooltip_visible());
                app.input(Event::Mouse(MouseEvent {
                    kind: MouseEventKind::Down(MouseButton::Left),
                    column: area.x,
                    row: area.y,
                    modifiers: KeyModifiers::NONE,
                }));
                assert_eq!(app.drafts["chat"].text(), "keep draft");
            }
            app.input(key(KeyCode::Char('f'), KeyModifiers::ALT));
            {
                let history = app.chat.history.as_mut().unwrap();
                history.matches = [10, 20]
                    .into_iter()
                    .map(
                        |sequence| maka_protocol::transcript::TranscriptSearchMatch {
                            sequence,
                            preview: format!("中文 {sequence}"),
                        },
                    )
                    .collect();
                history.scanning = false;
            }
            for width in [30, 80, 120] {
                let mut terminal = Terminal::new(TestBackend::new(width, 20)).unwrap();
                terminal
                    .draw(|frame| crate::view::draw(frame, &mut app))
                    .unwrap();
                let history = app.chat.history.as_ref().unwrap();
                if width < 100 {
                    assert!(
                        usize::from(history.list_area.unwrap().height) <= history.matches.len(),
                        "compact result list leaves space for the message"
                    );
                }
                let area = history
                    .reader_surface
                    .rect("history/matches/rows/20")
                    .unwrap();
                app.input(Event::Mouse(MouseEvent {
                    kind: MouseEventKind::Down(MouseButton::Left),
                    column: area.x,
                    row: area.y,
                    modifiers: KeyModifiers::NONE,
                }));
                assert_eq!(app.chat.history.as_ref().unwrap().selected, 1);
                app.input(key(KeyCode::Up, KeyModifiers::NONE));
                assert_eq!(app.chat.history.as_ref().unwrap().selected, 0);
                assert_eq!(app.drafts["chat"].text(), "keep draft");
            }
            app.chat
                .history
                .as_mut()
                .unwrap()
                .fail("history-detail-only".into());
            let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
            let text = |terminal: &Terminal<TestBackend>| {
                terminal
                    .backend()
                    .buffer()
                    .content
                    .iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
            };
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            assert!(!text(&terminal).contains("history-detail-only"));
            app.apply(Action::ToggleDetails);
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            assert!(text(&terminal).contains("history-detail-only"));
            app.input(Event::Paste("not a search edit".into()));
            assert_eq!(app.chat.view.search.as_ref().unwrap().editor.text(), "中文");
            assert_eq!(app.drafts["chat"].text(), "keep draft");
            assert_eq!(
                app.chat.history.as_ref().unwrap().error.as_deref(),
                Some("history-detail-only")
            );
            app.apply(Action::ToggleDetails);
            app.apply(Action::Palette);
            app.input(key(KeyCode::Esc, KeyModifiers::NONE));
            assert!(
                app.chat.view.search.is_some(),
                "palette consumes its own Escape"
            );
            app.input(key(KeyCode::Esc, KeyModifiers::NONE));
            assert!(app.chat.view.search.is_none());
            app.input(key(KeyCode::Char('f'), KeyModifiers::CONTROL));
            app.input(Event::Paste("a\nb".into()));
            assert_eq!(app.chat.view.search.as_ref().unwrap().editor.text(), "a b");
            app.input(Event::Paste("x".repeat(513)));
            assert_eq!(
                app.chat.view.search.as_ref().unwrap().editor.error,
                Some("chat-search-too-long")
            );
            app.chat.select(&Route::Session("other".into()));
            assert!(
                app.chat.view.search.is_none(),
                "find never leaks across sessions"
            );
            assert!(app.i18n.diagnostics().is_empty());
        }
    }
}
