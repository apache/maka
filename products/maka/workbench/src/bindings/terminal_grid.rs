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

//! Presentation of one original Host PTY stream. No PTY, IO or control authority.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_plugin_core::terminal::{
    TerminalSize,
    display::{Assembly, Display, Part},
};
use maka_process::terminal::{Screen, display::Viewport};
use maka_workspace_api::terminal::OutputEvent as Output;
use nsh_core::JsonValue;
use nsh_core::prelude::*;
use serde_json::json;

/// Native styled cells for a single terminal; the Host retains process ownership.
#[class]
pub struct TerminalGrid {
    content: Content,
    after: u64,
    transfer: Option<Assembly>,
}

enum Content {
    Live(Box<Live>),
    Settled(Box<Display>),
}
struct Live {
    screen: Screen,
    decoder: Decoder,
    initial_size: Option<TerminalSize>,
    status: Status,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Live,
    Closed,
    Unavailable,
}
impl Status {
    fn name(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Closed => "closed",
            Self::Unavailable => "unavailable",
        }
    }
}
impl Live {
    fn new(size: TerminalSize) -> Self {
        Self {
            screen: Screen::new(size),
            decoder: Decoder::default(),
            initial_size: None,
            status: Status::Live,
        }
    }
    fn geometry(&mut self, initial: TerminalSize, size: TerminalSize) -> Result<(), String> {
        if let Some(previous) = self.initial_size {
            if initial != previous {
                return Err("Terminal stream changed its original geometry; reset it first".into());
            }
        } else {
            // The original stream, rather than a presentation's provisional size,
            // supplies the geometry from which every retained record is replayed.
            self.screen = Screen::new(initial);
            self.initial_size = Some(initial);
        }
        if self.screen.size() != size {
            self.screen
                .resize(size)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    fn write(&mut self, bytes: &[u8], eof: bool) -> Result<(), String> {
        let text = self.decoder.decode(bytes, eof);
        // The original Host parser owns replies to DA/CPR and other PTY queries.
        // A viewing client's emulator must never send its own generated replies.
        self.screen
            .write(&text)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[class]
impl TerminalGrid {
    pub fn new(size: JsonValue) -> Result<Self, String> {
        let size: TerminalSize = serde_json::from_value(size).map_err(|error| error.to_string())?;
        Ok(Self {
            content: Content::Live(Box::new(Live::new(size))),
            after: 0,
            transfer: None,
        })
    }

    /// Begin replaying a different original stream from sequence zero.
    pub fn reset(&mut self, size: JsonValue) -> Result<(), String> {
        *self = Self::new(size)?;
        Ok(())
    }

    /// Apply the unwrapped original watchOutput event; duplicates never repeat text.
    pub fn apply(&mut self, event: JsonValue) -> Result<JsonValue, String> {
        let event: Output = serde_json::from_value(event).map_err(|error| error.to_string())?;
        if self.transfer.is_some() {
            return Err("A retained terminal display is being received".into());
        }
        let Content::Live(live) = &mut self.content else {
            return Err(
                "A retained display is not a parser checkpoint; reset before raw replay".into(),
            );
        };
        let terminal_duplicate = match (&event, live.status) {
            (Output::Closed { after, .. }, Status::Closed) => *after == self.after,
            (Output::Unavailable { .. }, Status::Unavailable) => true,
            _ => false,
        };
        if terminal_duplicate {
            return Ok(json!({"after": self.after, "status": live.status.name()}));
        }
        if live.status != Status::Live {
            return Err("Terminal output ended; reset before starting another stream".into());
        }
        let closed = matches!(&event, Output::Closed { .. });
        match event {
            Output::Data {
                sequence,
                size,
                initial_size,
                data_base64,
            } => {
                validate_sequence(sequence, false)?;
                if sequence > self.after {
                    let bytes = STANDARD
                        .decode(data_base64)
                        .map_err(|_| "Invalid terminal output base64")?;
                    if bytes.is_empty() {
                        return Err("Empty terminal Data event".into());
                    }
                    live.geometry(initial_size, size)?;
                    live.write(&bytes, false)?;
                    self.after = sequence;
                }
            }
            Output::Resize {
                sequence,
                size,
                initial_size,
            } => {
                validate_sequence(sequence, false)?;
                if sequence > self.after {
                    live.geometry(initial_size, size)?;
                    self.after = sequence;
                }
            }
            Output::Pending {
                after,
                size,
                initial_size,
            }
            | Output::Closed {
                after,
                size,
                initial_size,
            } => {
                validate_sequence(after, true)?;
                if after != self.after {
                    return Err("Terminal output cursor does not match the applied stream".into());
                }
                live.geometry(initial_size, size)?;
                if closed {
                    live.write(&[], true)?;
                    live.status = Status::Closed;
                }
            }
            Output::Unavailable { .. } => live.status = Status::Unavailable,
        }
        Ok(json!({"after": self.after, "status": live.status.name()}))
    }

    /// Capture only the requested physical rows. Offset zero follows the bottom;
    /// positive offsets scroll upward. A taller presentation fits the current
    /// original PTY height until its own resize is observed in the raw stream.
    pub fn display(&self, offset: u32, rows: u16) -> Result<JsonValue, String> {
        let (viewport, status) = match &self.content {
            Content::Live(live) => (
                live.screen.viewport(
                    offset as usize,
                    usize::from(rows.min(live.screen.size().rows())),
                )?,
                live.status.name(),
            ),
            Content::Settled(display) => (
                Viewport::from_display(
                    display,
                    offset as usize,
                    usize::from(rows.min(display.metadata.size.rows())),
                )?,
                "settled",
            ),
        };
        let mut value = serde_json::to_value(viewport).map_err(|error| error.to_string())?;
        value["after"] = json!(self.after);
        value["status"] = json!(status);
        Ok(value)
    }

    /// Receive the original readDisplay parts privately. Only a complete End
    /// replaces the old view. An installed display cannot resume raw parsing.
    pub fn display_part(&mut self, part: JsonValue) -> Result<bool, String> {
        let part: Part = match serde_json::from_value(part) {
            Ok(part) => part,
            Err(error) => {
                self.transfer = None;
                return Err(error.to_string());
            }
        };
        let result = match part {
            Part::Begin {
                metadata,
                scrollback_rows,
                last_alternate_size,
                ..
            } => {
                self.transfer = None;
                Assembly::begin(metadata, scrollback_rows, last_alternate_size).map(|assembly| {
                    self.transfer = Some(assembly);
                    false
                })
            }
            Part::Rows { parts } => self
                .transfer
                .as_mut()
                .ok_or("Terminal rows arrived without Begin")
                .and_then(|assembly| assembly.rows(parts))
                .map(|()| false),
            Part::End => self
                .transfer
                .take()
                .ok_or("Terminal End arrived without Begin")
                .and_then(Assembly::finish)
                .map(|display| {
                    self.content = Content::Settled(Box::new(display));
                    true
                }),
        };
        if result.is_err() {
            self.transfer = None;
        }
        result.map_err(str::to_owned)
    }

    /// Cancel an unfinished retained transfer without replacing the current view.
    pub fn discard_display(&mut self) {
        self.transfer = None;
    }
}

fn validate_sequence(value: u64, zero: bool) -> Result<(), String> {
    if value > 9_007_199_254_740_991 || (!zero && value == 0) {
        return Err("Invalid terminal output sequence".into());
    }
    Ok(())
}

/// Keep at most the incomplete UTF-8 suffix between original native records.
/// Malformed bytes and incomplete EOF use replacement, matching the Host decoder.
#[derive(Default)]
struct Decoder {
    pending: Vec<u8>,
}
impl Decoder {
    fn decode(&mut self, bytes: &[u8], eof: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::new();
        let mut consumed = 0;
        while consumed < self.pending.len() {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(valid) => {
                    text.push_str(valid);
                    consumed = self.pending.len();
                }
                Err(error) => {
                    let end = consumed + error.valid_up_to();
                    text.push_str(std::str::from_utf8(&self.pending[consumed..end]).unwrap());
                    consumed = end;
                    match error.error_len() {
                        Some(length) => {
                            text.push('\u{fffd}');
                            consumed += length;
                        }
                        None if eof => {
                            text.push('\u{fffd}');
                            consumed = self.pending.len();
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        text
    }
}
