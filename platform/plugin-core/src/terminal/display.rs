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

//! Retained terminal display, independent of parser continuation and model text.
use super::{TerminalCursor, TerminalInputModes, TerminalScreen, TerminalSize};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Actual encoded display allocation. Two maximum visible buffers, including
/// 33 scalars and independent RGB styles per cell, fit below 47 MiB; 64 MiB
/// preserves both and leaves history headroom. History is counted row by row.
pub const MAX_DISPLAY_BYTES: usize = 64 * 1024 * 1024;

/// Named colors retain their ANSI role (including default foreground/background),
/// while indexed colors retain their exact palette entry even under bold/dim.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Color {
    Named(u16),
    Indexed(u8),
    Rgb([u8; 3]),
}

/// Cell flags use the terminal's fixed bit layout: inverse=1, bold=2, italic=4,
/// underline=8, wrap=16, wide=32, wide spacer=64, dim=128, hidden=256,
/// strike=512, leading wide spacer=1024, double/curl/dotted/dashed underline
/// =2048/4096/8192/16384. Geometry flags remain attached to their original cell.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Style {
    pub foreground: Color,
    pub background: Color,
    pub flags: u16,
    pub underline: Option<Color>,
}

/// Consecutive cells with the same style. `text` includes every blank and
/// combining character. Empty `lengths` means one Unicode scalar per cell;
/// otherwise each entry is the scalar count of one cell, including its base.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    pub style: Style,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lengths: Vec<u8>,
}
impl Run {
    pub fn columns(&self) -> usize {
        if self.lengths.is_empty() {
            self.text.chars().count()
        } else {
            self.lengths.len()
        }
    }
}

pub type Row = Vec<Run>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Alternate {
    pub size: TerminalSize,
    pub rows: Vec<Row>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CursorShape {
    Block,
    Underline,
    Beam,
    HollowBlock,
    Hidden,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub size: TerminalSize,
    pub cursor: TerminalCursor,
    pub cursor_shape: CursorShape,
    pub cursor_blinking: bool,
    pub alternate_screen: bool,
    pub truncated: bool,
    pub input: TerminalInputModes,
    /// Palette overrides only; absence preserves the viewing client's theme.
    pub palette: Vec<(u16, [u8; 3])>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Display {
    pub metadata: Metadata,
    pub screen: Vec<Row>,
    pub scrollback: Vec<Row>,
    pub last_alternate_screen: Option<Arc<Alternate>>,
}
impl Display {
    pub fn new(size: TerminalSize) -> Self {
        let plain = TerminalScreen::new(size);
        Self {
            metadata: Metadata {
                size,
                cursor: plain.cursor,
                cursor_shape: CursorShape::Block,
                cursor_blinking: false,
                alternate_screen: false,
                truncated: false,
                input: plain.input,
                palette: Vec::new(),
            },
            screen: vec![
                vec![Run {
                    style: Style {
                        foreground: Color::Named(256),
                        background: Color::Named(257),
                        flags: 0,
                        underline: None
                    },
                    text: " ".repeat(usize::from(size.cols())),
                    lengths: Vec::new(),
                }];
                usize::from(size.rows())
            ],
            scrollback: Vec::new(),
            last_alternate_screen: None,
        }
    }

    /// A bounded plain projection. Charge visited scalars before trimming blanks,
    /// so work depends on the model budget, not the retained history length.
    pub fn text(&self, budget: usize) -> TerminalScreen {
        let mut remaining = budget;
        let mut clipped = false;
        let screen = text_rows(&self.screen, false, &mut remaining, &mut clipped);
        let alternate = self
            .last_alternate_screen
            .as_ref()
            .map(|rows| text_rows(&rows.rows, false, &mut remaining, &mut clipped));
        let scrollback = text_rows(&self.scrollback, true, &mut remaining, &mut clipped);
        TerminalScreen {
            screen,
            scrollback,
            last_alternate_screen: alternate.filter(|s| !s.is_empty()),
            size: self.metadata.size,
            cursor: self.metadata.cursor.clone(),
            alternate_screen: self.metadata.alternate_screen,
            truncated: self.metadata.truncated || clipped,
            input: self.metadata.input,
        }
    }
}

pub fn text_rows(rows: &[Row], history: bool, remaining: &mut usize, clipped: &mut bool) -> String {
    let mut retained = Vec::new();
    let indices: Box<dyn Iterator<Item = usize>> = if history {
        Box::new((0..rows.len()).rev())
    } else {
        Box::new(0..rows.len())
    };
    for index in indices {
        if *remaining == 0 {
            *clipped = true;
            break;
        }
        *remaining -= 1;
        let mut line = String::new();
        let mut wrapped = false;
        for run in &rows[index] {
            wrapped = run.style.flags & 16 != 0;
            for c in run.text.chars() {
                if c.len_utf8() > *remaining {
                    *clipped = true;
                    *remaining = 0;
                    break;
                }
                *remaining -= c.len_utf8();
                if run.style.flags & (64 | 1024) == 0 {
                    line.push(c);
                }
            }
            if *remaining == 0 {
                break;
            }
        }
        line.truncate(line.trim_end_matches(' ').len());
        retained.push((line, wrapped));
    }
    if history {
        retained.reverse();
    }
    let mut out = String::new();
    let mut previous_wrapped = true;
    for (index, (line, wrapped)) in retained.into_iter().enumerate() {
        if index != 0 && (!history || !previous_wrapped) {
            out.push('\n');
        }
        out.push_str(&line);
        previous_wrapped = wrapped;
    }
    if !history {
        out.truncate(out.trim_end_matches('\n').len());
    }
    out
}

/// A finite transfer of one captured durable display. End installs it; these
/// parts never claim an original-output cursor or a parser continuation point.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "TerminalDisplayPart")]
pub enum Part {
    Begin {
        #[schemars(range(max = 9007199254740991u64))]
        revision: u64,
        metadata: Metadata,
        scrollback_rows: u32,
        last_alternate_size: Option<TerminalSize>,
    },
    Rows {
        parts: Vec<RowPart>,
    },
    End,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Buffer {
    Scrollback,
    Screen,
    LastAlternate,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowPart {
    pub buffer: Buffer,
    pub row: u32,
    pub column: u16,
    pub runs: Row,
}

/// Private transfer staging. Rows arrive in buffer/row/column order; canceled
/// or invalid transfers can be discarded without modifying a displayed view.
pub struct Assembly {
    display: Display,
    counts: [usize; 3],
    next_buffer: usize,
    next_row: usize,
    next_column: usize,
    bytes: usize,
}
impl Assembly {
    pub fn begin(
        metadata: Metadata,
        scrollback_rows: u32,
        last_alternate_size: Option<TerminalSize>,
    ) -> Result<Self, &'static str> {
        metadata.validate()?;
        if scrollback_rows as usize > super::history_rows(metadata.size.cols()) {
            return Err("terminal display history exceeds cell capacity");
        }
        let rows = usize::from(metadata.size.rows());
        let alternate_rows = last_alternate_size.map_or(0, |size| usize::from(size.rows()));
        let mut assembly = Self {
            display: Display {
                metadata,
                screen: Vec::new(),
                scrollback: Vec::new(),
                last_alternate_screen: last_alternate_size.map(|size| {
                    Arc::new(Alternate {
                        size,
                        rows: Vec::new(),
                    })
                }),
            },
            counts: [scrollback_rows as usize, rows, alternate_rows],
            next_buffer: 0,
            next_row: 0,
            next_column: 0,
            bytes: 0,
        };
        assembly.bytes = assembly.display.encoded_size();
        Ok(assembly)
    }
    pub fn rows(&mut self, parts: Vec<RowPart>) -> Result<(), &'static str> {
        for part in parts {
            while self.next_buffer < 3 && self.next_row == self.counts[self.next_buffer] {
                self.next_buffer += 1;
                self.next_row = 0;
            }
            let buffer = match part.buffer {
                Buffer::Scrollback => 0,
                Buffer::Screen => 1,
                Buffer::LastAlternate => 2,
            };
            if buffer != self.next_buffer
                || part.row as usize != self.next_row
                || usize::from(part.column) != self.next_column
                || part.runs.is_empty()
            {
                return Err("out-of-order terminal display row");
            }
            let columns = match part.buffer {
                Buffer::LastAlternate => usize::from(
                    self.display
                        .last_alternate_screen
                        .as_ref()
                        .ok_or("unexpected alternate display")?
                        .size
                        .cols(),
                ),
                _ => usize::from(self.display.metadata.size.cols()),
            };
            let rows = match part.buffer {
                Buffer::Scrollback => &mut self.display.scrollback,
                Buffer::Screen => &mut self.display.screen,
                Buffer::LastAlternate => {
                    &mut Arc::make_mut(self.display.last_alternate_screen.as_mut().unwrap()).rows
                }
            };
            if self.next_column == 0 {
                self.bytes += 2 + usize::from(!rows.is_empty());
                rows.push(Vec::new());
            }
            let row = rows.last_mut().unwrap();
            let before = crate::json::encoded_size(row, usize::MAX).unwrap();
            for run in part.runs {
                let count = run.validate()?;
                self.next_column = self
                    .next_column
                    .checked_add(count)
                    .filter(|n| *n <= columns)
                    .ok_or("terminal display row too wide")?;
                if let Some(last) = row.last_mut()
                    && last.style == run.style
                {
                    last.append(run);
                } else {
                    row.push(run);
                }
            }
            let after = crate::json::encoded_size(row, usize::MAX).unwrap();
            self.bytes += after - before;
            if self.bytes > MAX_DISPLAY_BYTES {
                return Err("terminal display exceeds encoded capacity");
            }
            if self.next_column == columns {
                self.next_row += 1;
                self.next_column = 0;
            }
        }
        Ok(())
    }
    pub fn finish(self) -> Result<Display, &'static str> {
        if self.next_column != 0
            || self.display.scrollback.len() != self.counts[0]
            || self.display.screen.len() != self.counts[1]
            || self
                .display
                .last_alternate_screen
                .as_ref()
                .map_or(0, |alt| alt.rows.len())
                != self.counts[2]
        {
            return Err("incomplete terminal display");
        }
        self.display.validate()?;
        Ok(self.display)
    }
}
impl Color {
    fn valid(self) -> bool {
        match self {
            Self::Named(index) => index < 16 || (256..=268).contains(&index),
            _ => true,
        }
    }
}
impl Run {
    pub fn validate(&self) -> Result<usize, &'static str> {
        let scalars = self.text.chars().count();
        if scalars == 0
            || !self.style.foreground.valid()
            || !self.style.background.valid()
            || self.style.underline.is_some_and(|color| !color.valid())
            || self.style.flags & !0x7fff != 0
        {
            return Err("invalid terminal display run");
        }
        if self.lengths.is_empty() {
            return Ok(scalars);
        }
        if self.lengths.iter().any(|n| !(1..=33).contains(n))
            || self.lengths.iter().map(|n| usize::from(*n)).sum::<usize>() != scalars
        {
            return Err("invalid terminal cell lengths");
        }
        Ok(self.lengths.len())
    }
    fn append(&mut self, other: Run) {
        if !self.lengths.is_empty() || !other.lengths.is_empty() {
            if self.lengths.is_empty() {
                self.lengths.resize(self.text.chars().count(), 1);
            }
            if other.lengths.is_empty() {
                self.lengths
                    .extend(std::iter::repeat_n(1, other.text.chars().count()));
            } else {
                self.lengths.extend(other.lengths);
            }
        }
        self.text.push_str(&other.text);
    }
    pub fn split_at(&self, columns: usize) -> (Self, Self) {
        let scalars = if self.lengths.is_empty() {
            columns
        } else {
            self.lengths[..columns]
                .iter()
                .map(|n| usize::from(*n))
                .sum()
        };
        let byte = self
            .text
            .char_indices()
            .nth(scalars)
            .map_or(self.text.len(), |(byte, _)| byte);
        let (left, right) = self.text.split_at(byte);
        let (left_lengths, right_lengths) = if self.lengths.is_empty() {
            (&[][..], &[][..])
        } else {
            self.lengths.split_at(columns)
        };
        (
            Self {
                style: self.style.clone(),
                text: left.into(),
                lengths: left_lengths.into(),
            },
            Self {
                style: self.style.clone(),
                text: right.into(),
                lengths: right_lengths.into(),
            },
        )
    }
}
impl Display {
    pub fn encoded_size(&self) -> usize {
        crate::json::encoded_size(self, usize::MAX)
            .expect("display contains only serializable values")
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        let size = self.metadata.size;
        self.metadata.validate()?;
        if self.screen.len() != usize::from(size.rows())
            || self.scrollback.len() > super::history_rows(size.cols())
        {
            return Err("invalid terminal display geometry");
        }
        if crate::json::encoded_size(self, MAX_DISPLAY_BYTES).is_err() {
            return Err("terminal display exceeds encoded capacity");
        }
        for row in self.screen.iter().chain(&self.scrollback) {
            validate_row(row, size)?;
        }
        if let Some(alternate) = &self.last_alternate_screen {
            if alternate.rows.len() != usize::from(alternate.size.rows()) {
                return Err("invalid alternate display geometry");
            }
            for row in &alternate.rows {
                validate_row(row, alternate.size)?;
            }
        }
        Ok(())
    }
}
fn validate_row(row: &Row, size: TerminalSize) -> Result<(), &'static str> {
    let mut columns = 0usize;
    for run in row {
        columns = columns
            .checked_add(run.validate()?)
            .ok_or("invalid terminal row width")?;
    }
    if columns != usize::from(size.cols()) {
        return Err("invalid terminal row width");
    }
    Ok(())
}

impl Metadata {
    fn validate(&self) -> Result<(), &'static str> {
        if self.cursor.x >= self.size.cols()
            || self.cursor.y >= self.size.rows()
            || self.palette.len() > 269
        {
            return Err("invalid terminal display metadata");
        }
        let mut seen = [false; 269];
        for (index, _) in &self.palette {
            let entry = seen
                .get_mut(usize::from(*index))
                .ok_or("invalid terminal palette index")?;
            if *entry {
                return Err("duplicate terminal palette entry");
            }
            *entry = true;
        }
        Ok(())
    }
}
