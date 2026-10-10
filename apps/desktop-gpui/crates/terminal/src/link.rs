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

//! The links a terminal's grid holds: web addresses in its text and OSC 8
//! hyperlinks a program wrote. Only `http:` and `https:` targets are links,
//! as in Maka Desktop (`terminalWebUrl` in
//! `apps/desktop/src/renderer/features/workbar/tools/terminal/terminal-interaction-policy.ts`):
//! no file paths and no other schemes.
//!
//! Zed's terminal (GPL-3.0) informed the practice, not the code: the text of
//! the line under the pointer, its wrapped rows joined, is matched against a
//! URL pattern, and an OSC 8 hyperlink spans the cells that carry it.

use std::sync::LazyLock;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::Term;
use alacritty_terminal::term::cell::{Flags, Hyperlink};
use regex::Regex;

/// Rows of a wrapped line read either side of the pointer's: a line longer
/// than that (a minified file, say) is cut, and a link across the cut is not
/// found.
const WRAPPED_ROWS: i32 = 50;

/// A link in the grid: where it opens and the cells it covers, from its
/// first cell to its last (both included), in grid coordinates (line 0 is
/// the top of the screen, negative lines are scrollback).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TerminalLink {
    pub url: String,
    pub start: Point,
    pub end: Point,
}

impl TerminalLink {
    /// Whether the link covers the cell at `point`.
    pub fn contains(&self, point: Point) -> bool {
        self.start <= point && point <= self.end
    }
}

/// `text` as a web address to open, normalized, when it is one: it parses
/// as a URL whose scheme is `http` or `https` and that names a host.
pub fn web_url(text: &str) -> Option<String> {
    let url = url::Url::parse(text).ok()?;
    let web = matches!(url.scheme(), "http" | "https") && url.host_str().is_some();
    web.then(|| url.into())
}

/// An address in text: the scheme, then everything up to a space, a
/// control character, or a character an address does not hold unescaped.
static URL_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)https?://[^\s\x00-\x1f\x7f<>"'`{}|\\^⟨⟩]+"#).expect("the URL pattern")
});

/// `found` without the punctuation a sentence puts after an address: a
/// final full stop, comma, colon, semicolon, question or exclamation mark,
/// and a closing bracket that the address does not open.
fn trim_trailing(found: &str) -> &str {
    let mut text = found;
    while let Some(last) = text.chars().last() {
        let unbalanced =
            |open: char, close: char| text.matches(close).count() > text.matches(open).count();
        let trailing = match last {
            '.' | ',' | ':' | ';' | '!' | '?' => true,
            ')' => unbalanced('(', ')'),
            ']' => unbalanced('[', ']'),
            _ => false,
        };
        if !trailing {
            break;
        }
        text = &text[..text.len() - last.len_utf8()];
    }
    text
}

/// One character of a line and the cell it came from.
struct LineChar {
    offset: usize,
    point: Point,
    hyperlink: Option<Hyperlink>,
}

/// The line under a point as the program wrote it: its rows joined where
/// they wrapped.
struct WrappedLine {
    text: String,
    chars: Vec<LineChar>,
}

impl WrappedLine {
    fn around<T>(term: &Term<T>, point: Point) -> Self {
        let grid = term.grid();
        let columns = grid.columns();
        let wraps = |line: i32| {
            columns > 0 && grid[Line(line)][Column(columns - 1)].flags.contains(Flags::WRAPLINE)
        };
        let (top, bottom) = (grid.topmost_line().0, grid.bottommost_line().0);
        let mut first = point.line.0;
        while first > top && first > point.line.0 - WRAPPED_ROWS && wraps(first - 1) {
            first -= 1;
        }
        let mut last = point.line.0;
        while last < bottom && last < point.line.0 + WRAPPED_ROWS && wraps(last) {
            last += 1;
        }
        let mut line = Self { text: String::new(), chars: Vec::new() };
        for row in first..=last {
            for column in 0..columns {
                let cell = &grid[Line(row)][Column(column)];
                if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                let point = Point::new(Line(row), Column(column));
                let hyperlink = cell.hyperlink();
                for c in std::iter::once(cell.c)
                    .chain(cell.zerowidth().unwrap_or_default().iter().copied())
                {
                    line.chars.push(LineChar {
                        offset: line.text.len(),
                        point,
                        hyperlink: hyperlink.clone(),
                    });
                    line.text.push(c);
                }
            }
        }
        line
    }

    /// The index in `chars` of the first character of the cell at `point`.
    fn char_at(&self, point: Point) -> Option<usize> {
        self.chars.iter().position(|each| each.point == point)
    }

    /// The index in `chars` of the character at byte `offset`.
    fn char_of_offset(&self, offset: usize) -> usize {
        self.chars.partition_point(|each| each.offset <= offset).saturating_sub(1)
    }

    /// The OSC 8 hyperlink at `point`, over the cells around it that carry
    /// the same one.
    fn hyperlink_at(&self, at: usize) -> Option<TerminalLink> {
        let hyperlink = self.chars[at].hyperlink.clone()?;
        let same = |each: &LineChar| each.hyperlink.as_ref() == Some(&hyperlink);
        let first = self.chars[..at].iter().rposition(|each| !same(each)).map_or(0, |ix| ix + 1);
        let last = self.chars[at..]
            .iter()
            .position(|each| !same(each))
            .map_or(self.chars.len() - 1, |ix| at + ix - 1);
        Some(TerminalLink {
            url: web_url(hyperlink.uri())?,
            start: self.chars[first].point,
            end: self.chars[last].point,
        })
    }

    /// The address in the text over the character `at`.
    fn address_at(&self, at: usize) -> Option<TerminalLink> {
        let offset = self.chars[at].offset;
        URL_PATTERN.find_iter(&self.text).find_map(|found| {
            let text = trim_trailing(found.as_str());
            let end = found.start() + text.len();
            if !(found.start()..end).contains(&offset) {
                return None;
            }
            Some(TerminalLink {
                url: web_url(text)?,
                start: self.chars[self.char_of_offset(found.start())].point,
                end: self.chars[self.char_of_offset(end - 1)].point,
            })
        })
    }
}

/// The link at the cell `point` of `term`'s grid, if it is in one: an OSC 8
/// hyperlink to a web address, or a web address in the text. A cell with a
/// hyperlink to anything else is no link, whatever its text says.
pub(crate) fn link_at<T>(term: &Term<T>, point: Point) -> Option<TerminalLink> {
    let grid = term.grid();
    let in_grid = (grid.topmost_line()..=grid.bottommost_line()).contains(&point.line)
        && point.column.0 < grid.columns();
    if !in_grid {
        return None;
    }
    // The right half of a wide character is the character's.
    let mut point = point;
    if point.column.0 > 0 && grid[point].flags.contains(Flags::WIDE_CHAR_SPACER) {
        point.column -= 1;
    }
    let line = WrappedLine::around(term, point);
    let at = line.char_at(point)?;
    if line.chars[at].hyperlink.is_some() {
        return line.hyperlink_at(at);
    }
    line.address_at(at)
}

#[cfg(test)]
mod tests {
    use host_protocol::PtySize;

    use super::*;
    use crate::emulator::Emulator;

    fn point(line: i32, column: usize) -> Point {
        Point::new(Line(line), Column(column))
    }

    fn written(text: &str) -> Emulator {
        let mut emulator = Emulator::new(PtySize::new(20, 4).expect("size"));
        emulator.advance(text);
        emulator
    }

    fn url_at(emulator: &Emulator, at: Point) -> Option<String> {
        link_at(emulator.term(), at).map(|link| link.url)
    }

    #[test]
    fn a_web_address_is_found_under_the_pointer_and_over_a_wrap() {
        // 20 columns: the address wraps onto the second row.
        let emulator = written("see https://example.com/a/b, ok");
        let link = link_at(emulator.term(), point(0, 10)).expect("a link");
        assert_eq!(link.url, "https://example.com/a/b");
        assert_eq!((link.start, link.end), (point(0, 4), point(1, 6)), "the comma is not in it");
        assert_eq!(url_at(&emulator, point(1, 2)).as_deref(), Some("https://example.com/a/b"));
        assert_eq!(url_at(&emulator, point(0, 1)), None, "\"see\" is no link");
        assert_eq!(url_at(&emulator, point(1, 7)), None, "nor the comma after it");
    }

    #[test]
    fn only_web_addresses_are_links() {
        for text in ["file:///etc/hosts", "/usr/local/bin", "ftp://example.com", "mailto:a@b.c"] {
            let emulator = written(text);
            assert_eq!(url_at(&emulator, point(0, 2)), None, "{text}");
        }
        assert_eq!(web_url("HTTPS://Example.com").as_deref(), Some("https://example.com/"));
        assert_eq!(web_url("http://"), None);
    }

    #[test]
    fn brackets_and_punctuation_around_an_address_stay_out_of_it() {
        assert_eq!(trim_trailing("https://a.b/c)."), "https://a.b/c");
        assert_eq!(trim_trailing("https://a.b/(c)"), "https://a.b/(c)");
        assert_eq!(trim_trailing("https://a.b/x?"), "https://a.b/x");
        let emulator = written("(https://a.io)");
        let link = link_at(emulator.term(), point(0, 5)).expect("a link");
        assert_eq!((link.url.as_str(), link.end), ("https://a.io/", point(0, 12)));
    }

    #[test]
    fn an_osc_8_hyperlink_opens_its_target_and_spans_its_cells() {
        let emulator = written("a \x1b]8;;https://example.com/docs\x1b\\the docs\x1b]8;;\x1b\\ b");
        let link = link_at(emulator.term(), point(0, 4)).expect("a hyperlink");
        assert_eq!(link.url, "https://example.com/docs");
        assert_eq!((link.start, link.end), (point(0, 2), point(0, 9)));
        assert_eq!(url_at(&emulator, point(0, 11)), None);
        // A hyperlink to a file is no link, nor is its text.
        let emulator = written("\x1b]8;;file:///tmp/x\x1b\\https://a.io\x1b]8;;\x1b\\");
        assert_eq!(url_at(&emulator, point(0, 3)), None);
    }
}
