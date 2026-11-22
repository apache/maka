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

//! Anthropic source-backed block planning and encoded text boundary inspection.

use super::source::{FragmentCursor, SourceFragment};
use maka_agent_facts::model::prompt_source::source::{SourceBudget, TextSource};
use std::{io, ops::Range, sync::Arc};
mod compile;
mod hosted;
pub(super) use compile::Compiler;

/// Byte ranges are relative to escaped text, excluding its surrounding quotes.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct TextBounds {
    pub encoded_len: u64,
    pub leading: Range<u64>,
    pub trailing: Range<u64>,
}

pub(super) async fn inspect_text(
    text: TextSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<TextBounds> {
    let mut cursor = FragmentCursor::new(SourceFragment::Text(text));
    let mut inspection = TextInspection::default();
    while let Some(bytes) = cursor.next(budget.clone()).await? {
        inspection.push(&bytes)?;
    }
    inspection.finish()
}

#[derive(Default)]
struct TextInspection {
    pending: [u8; 6],
    pending_len: usize,
    encoded_len: u64,
    first_nonwhite: Option<u64>,
    last_nonwhite_end: u64,
}
impl TextInspection {
    fn push(&mut self, bytes: &[u8]) -> io::Result<()> {
        for &byte in bytes {
            self.pending[self.pending_len] = byte;
            self.pending_len += 1;
            let expected = match self.pending[0] {
                b'\\' if self.pending_len < 2 => continue,
                b'\\' if self.pending[1] == b'u' => 6,
                b'\\' => 2,
                0..=127 => 1,
                192..=223 => 2,
                224..=239 => 3,
                240..=247 => 4,
                _ => return Err(invalid_text()),
            };
            if self.pending_len != expected {
                continue;
            }
            let character = if self.pending[0] == b'\\' {
                match self.pending[1] {
                    b'"' => '"',
                    b'\\' => '\\',
                    b'/' => '/',
                    b'b' => '\u{8}',
                    b'f' => '\u{c}',
                    b'n' => '\n',
                    b'r' => '\r',
                    b't' => '\t',
                    b'u' => {
                        let digits =
                            std::str::from_utf8(&self.pending[2..6]).map_err(|_| invalid_text())?;
                        let scalar = u32::from_str_radix(digits, 16).map_err(|_| invalid_text())?;
                        char::from_u32(scalar).ok_or_else(invalid_text)?
                    }
                    _ => return Err(invalid_text()),
                }
            } else {
                std::str::from_utf8(&self.pending[..expected])
                    .map_err(|_| invalid_text())?
                    .chars()
                    .next()
                    .ok_or_else(invalid_text)?
            };
            if !character.is_whitespace() {
                self.first_nonwhite.get_or_insert(self.encoded_len);
                self.last_nonwhite_end = self.encoded_len + expected as u64;
            }
            self.encoded_len += expected as u64;
            self.pending_len = 0;
        }
        Ok(())
    }
    fn finish(self) -> io::Result<TextBounds> {
        if self.pending_len != 0 {
            return Err(invalid_text());
        }
        let first = self.first_nonwhite.unwrap_or(self.encoded_len);
        // Empty/all-whitespace text has disjoint deletion ranges, too.
        let last = self.last_nonwhite_end.max(first);
        Ok(TextBounds {
            encoded_len: self.encoded_len,
            leading: 0..first,
            trailing: last..self.encoded_len,
        })
    }
}
fn invalid_text() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid escaped Anthropic text")
}

/// Sort the prepaid digest table without allocating a second directory or detaching work.
pub(super) async fn sort_source_identities(values: &mut Vec<[u8; 32]>) {
    fn sift(values: &mut [[u8; 32]], mut root: usize, end: usize) {
        loop {
            let Some(left) = root.checked_mul(2).and_then(|index| index.checked_add(1)) else {
                return;
            };
            if left >= end {
                return;
            }
            let mut child = left;
            if left + 1 < end && values[left] < values[left + 1] {
                child = left + 1
            }
            if values[root] >= values[child] {
                return;
            }
            values.swap(root, child);
            root = child;
        }
    }
    const QUANTUM: usize = 64;
    let mut work = 0usize;
    let len = values.len();
    for root in (0..len / 2).rev() {
        sift(values, root, len);
        work += 1;
        if work.is_multiple_of(QUANTUM) {
            tokio::task::yield_now().await;
        }
    }
    for end in (1..len).rev() {
        values.swap(0, end);
        sift(values, 0, end);
        work += 1;
        if work.is_multiple_of(QUANTUM) {
            tokio::task::yield_now().await;
        }
    }
    let mut kept = 0;
    for read in 0..len {
        let identity = values[read];
        if kept == 0 || values[kept - 1] != identity {
            values[kept] = identity;
            kept += 1
        }
        work += 1;
        if work.is_multiple_of(QUANTUM) {
            tokio::task::yield_now().await;
        }
    }
    values.truncate(kept);
}
