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

//! Lossless display capture and installation. This is not a parser checkpoint.
use super::{Events, Screen};
use alacritty_terminal::{
    Term,
    event::EventListener,
    grid::Dimensions,
    index::{Column, Line, Point},
    term::{
        TermMode,
        cell::{Cell, Flags},
        color,
    },
    vte::ansi::{self, Handler},
};
use maka_plugin_core::terminal::{
    TerminalCursor,
    display::{self, Color, Display, Metadata, Row, Run, Style},
};

/// A physical viewport into the original styled grid. Capturing it visits only
/// the requested rows, irrespective of the amount of retained scrollback.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub metadata: Metadata,
    pub rows: Vec<Row>,
    /// Rows above the bottom of the grid, clamped to the retained extent.
    pub offset: usize,
    pub total_rows: usize,
    pub scrollback_rows: usize,
    /// Original grid coordinate: current screen starts at zero, history is negative.
    pub first_line: i32,
}

impl Viewport {
    /// Read a validated, settled display (for example from `Assembly::finish`)
    /// without cloning its other rows or alternate buffer. This is not an input
    /// validation boundary: validating again would walk the entire history.
    pub fn from_display(
        display: &Display,
        offset: usize,
        count: usize,
    ) -> Result<Self, &'static str> {
        let history = display.scrollback.len();
        let (offset, first_line) = viewport_range(display.metadata.size, history, offset, count)?;
        let first = (first_line + history as i32) as usize;
        let rows = (first..first + count)
            .map(|line| {
                if line < history {
                    display.scrollback[line].clone()
                } else {
                    display.screen[line - history].clone()
                }
            })
            .collect();
        Ok(Self {
            metadata: display.metadata.clone(),
            rows,
            offset,
            total_rows: history + usize::from(display.metadata.size.rows()),
            scrollback_rows: history,
            first_line,
        })
    }
}

fn viewport_range(
    size: maka_plugin_core::terminal::TerminalSize,
    history: usize,
    offset: usize,
    count: usize,
) -> Result<(usize, i32), &'static str> {
    let screen_rows = usize::from(size.rows());
    if count == 0 || count > screen_rows {
        return Err("terminal viewport must contain between one and the screen's rows");
    }
    let offset = offset.min(history + screen_rows - count);
    Ok((offset, (screen_rows - count) as i32 - offset as i32))
}

impl Screen {
    /// Capture at most one screen of original styled cells, without walking or
    /// encoding the retained history. Offset zero follows the live bottom.
    pub fn viewport(&self, offset: usize, count: usize) -> Result<Viewport, &'static str> {
        let term = &self.state.term;
        let history = term.history_size();
        let (offset, first_line) = viewport_range(self.size(), history, offset, count)?;
        let mut metadata = metadata(term, self);
        metadata.truncated |= self.failed;
        Ok(Viewport {
            metadata,
            rows: rows(term, first_line..first_line + count as i32),
            offset,
            total_rows: history + term.screen_lines(),
            scrollback_rows: history,
            first_line,
        })
    }

    /// Capture even a sticky-failed parser's structurally valid grid. The failed
    /// display includes only the applied prefix, and is explicitly incomplete.
    pub fn display(&self) -> Display {
        let mut metadata = metadata(&self.state.term, self);
        metadata.truncated |= self.failed;
        let mut display = Display {
            metadata,
            screen: rows(&self.state.term, 0..self.state.term.screen_lines() as i32),
            scrollback: Vec::new(),
            last_alternate_screen: self.state.last_alternate.clone(),
        };
        let mut remaining = display::MAX_DISPLAY_BYTES
            .checked_sub(display.encoded_size())
            .expect("bounded native viewports fit the display allowance");
        for line in (-(self.state.term.history_size() as i32)..0).rev() {
            let row = row(&self.state.term, line);
            let bytes = serde_json::to_vec(&row).expect("serializable row").len()
                + usize::from(!display.scrollback.is_empty());
            let Some(rest) = remaining.checked_sub(bytes) else {
                display.metadata.truncated = true;
                break;
            };
            remaining = rest;
            display.scrollback.push(row);
        }
        display.scrollback.reverse();
        display
    }
}

fn metadata(term: &Term<Events>, screen: &Screen) -> Metadata {
    let point = term.grid().cursor.point;
    let style = term.cursor_style();
    Metadata {
        size: screen.size(),
        cursor: TerminalCursor {
            x: point.column.0 as u16,
            y: point.line.0.max(0) as u16,
            visible: term.mode().contains(TermMode::SHOW_CURSOR),
        },
        cursor_shape: match style.shape {
            ansi::CursorShape::Block => display::CursorShape::Block,
            ansi::CursorShape::Underline => display::CursorShape::Underline,
            ansi::CursorShape::Beam => display::CursorShape::Beam,
            ansi::CursorShape::HollowBlock => display::CursorShape::HollowBlock,
            ansi::CursorShape::Hidden => display::CursorShape::Hidden,
        },
        cursor_blinking: style.blinking,
        alternate_screen: term.mode().contains(TermMode::ALT_SCREEN),
        truncated: screen.state.truncated,
        input: screen.input_modes(),
        palette: (0..color::COUNT)
            .filter_map(|index| {
                term.colors()[index].map(|rgb| (index as u16, [rgb.r, rgb.g, rgb.b]))
            })
            .collect(),
    }
}

pub(super) fn rows(term: &Term<Events>, lines: std::ops::Range<i32>) -> Vec<Row> {
    lines.map(|line| row(term, line)).collect()
}
fn row(term: &Term<Events>, line: i32) -> Row {
    let mut out: Row = Vec::new();
    let mut columns = 0;
    for column in 0..term.columns() {
        let cell = &term.grid()[Line(line)][Column(column)];
        let style = Style {
            foreground: color(cell.fg),
            background: color(cell.bg),
            flags: cell.flags.bits(),
            underline: cell.underline_color().map(color),
        };
        if out.last().is_none_or(|run| run.style != style) {
            out.push(Run {
                style,
                text: String::new(),
                lengths: Vec::new(),
            });
            columns = 0;
        }
        let run = out.last_mut().unwrap();
        let extra = cell.zerowidth().unwrap_or_default();
        if !extra.is_empty() && run.lengths.is_empty() {
            run.lengths.resize(columns, 1);
        }
        if !run.lengths.is_empty() || !extra.is_empty() {
            run.lengths.push((extra.len() + 1) as u8);
        }
        run.text.push(cell.c);
        run.text.extend(extra);
        columns += 1;
    }
    out
}
fn color(color: ansi::Color) -> Color {
    match color {
        ansi::Color::Named(color) => Color::Named(color as u16),
        ansi::Color::Indexed(index) => Color::Indexed(index),
        ansi::Color::Spec(rgb) => Color::Rgb([rgb.r, rgb.g, rgb.b]),
    }
}

fn native_color(color: Color) -> Result<ansi::Color, &'static str> {
    use ansi::NamedColor::*;
    Ok(match color {
        Color::Rgb([r, g, b]) => ansi::Color::Spec(ansi::Rgb { r, g, b }),
        Color::Indexed(index) => ansi::Color::Indexed(index),
        Color::Named(index) => ansi::Color::Named(match index {
            0 => Black,
            1 => Red,
            2 => Green,
            3 => Yellow,
            4 => Blue,
            5 => Magenta,
            6 => Cyan,
            7 => White,
            8 => BrightBlack,
            9 => BrightRed,
            10 => BrightGreen,
            11 => BrightYellow,
            12 => BrightBlue,
            13 => BrightMagenta,
            14 => BrightCyan,
            15 => BrightWhite,
            256 => Foreground,
            257 => Background,
            258 => Cursor,
            259 => DimBlack,
            260 => DimRed,
            261 => DimGreen,
            262 => DimYellow,
            263 => DimBlue,
            264 => DimMagenta,
            265 => DimCyan,
            266 => DimWhite,
            267 => BrightForeground,
            268 => DimForeground,
            _ => return Err("invalid named terminal color"),
        }),
    })
}

/// Install into a fresh display-only Term, retaining exact physical cells for
/// scroll and selection. Callers must never continue a raw parser from this grid.
pub fn install<T: EventListener>(
    term: &mut Term<T>,
    display: &Display,
) -> Result<(), &'static str> {
    display.validate()?;
    let meta = &display.metadata;
    if term.columns() != usize::from(meta.size.cols())
        || term.screen_lines() != usize::from(meta.size.rows())
    {
        return Err("terminal display geometry mismatch");
    }
    if meta.alternate_screen != term.mode().contains(TermMode::ALT_SCREEN) {
        term.swap_alt();
    }
    term.grid_mut().update_history(display.scrollback.len());
    term.grid_mut().initialize_all();
    let history = display.scrollback.len() as i32;
    for (line, row) in display.scrollback.iter().chain(&display.screen).enumerate() {
        install_row(term, Line(line as i32 - history), row)?;
    }
    for &(index, [r, g, b]) in &meta.palette {
        if usize::from(index) >= color::COUNT {
            return Err("invalid terminal palette index");
        }
        term.set_color(usize::from(index), ansi::Rgb { r, g, b });
    }
    term.grid_mut().cursor.point = Point::new(
        Line(i32::from(meta.cursor.y)),
        Column(usize::from(meta.cursor.x)),
    );
    term.set_cursor_style(Some(ansi::CursorStyle {
        shape: match meta.cursor_shape {
            display::CursorShape::Block => ansi::CursorShape::Block,
            display::CursorShape::Underline => ansi::CursorShape::Underline,
            display::CursorShape::Beam => ansi::CursorShape::Beam,
            display::CursorShape::HollowBlock => ansi::CursorShape::HollowBlock,
            display::CursorShape::Hidden => ansi::CursorShape::Hidden,
        },
        blinking: meta.cursor_blinking,
    }));
    let show = ansi::NamedPrivateMode::ShowCursor.into();
    if meta.cursor.visible {
        term.set_private_mode(show);
    } else {
        term.unset_private_mode(show);
    }
    Ok(())
}
fn install_row<T: EventListener>(
    term: &mut Term<T>,
    line: Line,
    row: &Row,
) -> Result<(), &'static str> {
    let mut column = 0;
    for run in row {
        let mut text = run.text.chars();
        let mut lengths = run.lengths.iter();
        while let Some(c) = text.next() {
            let length = if run.lengths.is_empty() {
                1
            } else {
                usize::from(*lengths.next().ok_or("terminal run lengths exhausted")?)
            };
            if !(1..=33).contains(&length) || column >= term.columns() {
                return Err("invalid terminal cell count");
            }
            let mut cell = Cell {
                c,
                fg: native_color(run.style.foreground)?,
                bg: native_color(run.style.background)?,
                flags: Flags::from_bits(run.style.flags).ok_or("invalid terminal cell flags")?,
                extra: None,
            };
            cell.set_underline_color(run.style.underline.map(native_color).transpose()?);
            for _ in 1..length {
                cell.push_zerowidth(text.next().ok_or("terminal cell text exhausted")?);
            }
            term.grid_mut()[line][Column(column)] = cell;
            column += 1;
        }
        if lengths.next().is_some() {
            return Err("excess terminal run lengths");
        }
    }
    if column != term.columns() {
        return Err("terminal row geometry mismatch");
    }
    Ok(())
}
