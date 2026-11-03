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

//! Bounded serde number decoding for already validated JSON lexemes.

use std::io;

// Binary64 fractional midpoints have a significand below 2^54 times at most
// 5^1075, hence at most 768 significant decimal digits. One extra retained
// digit plus a sticky tail distinguishes every rounding interval.
const SIGNIFICANT_DIGITS: usize = 769;
const EXPONENT_SATURATION: i128 = u64::MAX as i128 + 2048;
const I128_TEXT_BYTES: usize = 40;
const SHORT_NUMBER_BYTES: usize = 1 + SIGNIFICANT_DIGITS + 1 + 4 + I128_TEXT_BYTES;

/// Tracks numeric semantics without retaining an unbounded numeric token.
///
/// The caller validates JSON number grammar and feeds the complete lexeme.
/// Short lexemes retain their exact serde representation. Long lexemes produce
/// a bounded representative preserving serde's typed f64 decoding and buffered
/// primitive/map category, rather than the exact arbitrary-precision value.
#[derive(Debug)]
pub struct NumberValidator {
    original: [u8; SIGNIFICANT_DIGITS],
    original_len: usize,
    digits: [u8; SIGNIFICANT_DIGITS + 1],
    retained: usize,
    significant: u64,
    fractional: u64,
    fraction: bool,
    exponent_part: bool,
    exponent_negative: bool,
    exponent: i128,
    negative: bool,
    sticky: bool,
}
impl Default for NumberValidator {
    fn default() -> Self {
        Self::new()
    }
}
impl NumberValidator {
    /// Starts a new already syntax-checked numeric lexeme.
    pub fn new() -> Self {
        Self {
            original: [0; SIGNIFICANT_DIGITS],
            original_len: 0,
            digits: [0; SIGNIFICANT_DIGITS + 1],
            retained: 0,
            significant: 0,
            fractional: 0,
            fraction: false,
            exponent_part: false,
            exponent_negative: false,
            exponent: 0,
            negative: false,
            sticky: false,
        }
    }
    /// Adds one lexeme byte after the caller's JSON grammar check.
    ///
    /// # Errors
    /// Returns invalid data for unexpected bytes or source positions beyond u64.
    pub fn push(&mut self, byte: u8) -> io::Result<()> {
        if self.original_len < self.original.len() {
            self.original[self.original_len] = byte;
        }
        self.original_len = self.original_len.saturating_add(1);
        match byte {
            b'-' if self.exponent_part => self.exponent_negative = true,
            b'-' => self.negative = true,
            b'+' => {}
            b'.' => self.fraction = true,
            b'e' | b'E' => self.exponent_part = true,
            byte @ b'0'..=b'9' if self.exponent_part => {
                self.exponent =
                    (self.exponent * 10 + i128::from(byte - b'0')).min(EXPONENT_SATURATION);
            }
            byte @ b'0'..=b'9' => {
                if self.fraction {
                    self.fractional = self
                        .fractional
                        .checked_add(1)
                        .ok_or_else(position_overflow)?;
                }
                if byte != b'0' || self.significant != 0 {
                    self.significant = self
                        .significant
                        .checked_add(1)
                        .ok_or_else(position_overflow)?;
                    if self.retained < SIGNIFICANT_DIGITS {
                        self.digits[self.retained] = byte;
                        self.retained += 1;
                    } else {
                        self.sticky |= byte != b'0';
                    }
                }
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid numeric lexeme byte",
                ));
            }
        }
        Ok(())
    }
    /// Decodes a bounded representative for Value admission and typed buffering.
    ///
    /// Long lexemes preserve serde's typed f64 decoding and buffered primitive/map
    /// category. Their exact arbitrary-precision numeric value is not preserved;
    /// arbitrary-precision `Value::as_f64` uses a different parser and may round
    /// differently from serde's typed f64 decoder.
    ///
    /// # Errors
    /// Returns invalid data when the configured serde `Value` decoder rejects it.
    pub fn into_representative_value(self) -> io::Result<serde_json::Value> {
        let mut buffer = [0u8; SHORT_NUMBER_BYTES];
        serde_json::from_slice(self.write_representative(&mut buffer)?)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    fn write_representative(mut self, buffer: &mut [u8; SHORT_NUMBER_BYTES]) -> io::Result<&[u8]> {
        use io::Write as _;
        if self.original_len <= self.original.len() {
            buffer[..self.original_len].copy_from_slice(&self.original[..self.original_len]);
            return Ok(&buffer[..self.original_len]);
        }
        if self.significant == 0 {
            self.digits[0] = b'0';
            self.retained = 1;
            self.exponent = 0;
            self.fractional = 0;
            self.significant = 1;
        }
        if self.exponent_negative {
            self.exponent = -self.exponent;
        }
        self.exponent +=
            i128::from(self.significant) - self.retained as i128 - i128::from(self.fractional);
        if self.sticky {
            self.digits[self.retained] = b'1';
            self.retained += 1;
            self.exponent -= 1;
        }
        let coefficient =
            std::str::from_utf8(&self.digits[..self.retained]).expect("decimal digits are ASCII");
        let sign = if self.negative { "-" } else { "" };
        let mut remaining = buffer.as_mut_slice();
        // Preserve the integer/fraction parser lane for float_roundtrip. Every
        // finite f64 Display/serde spelling is at most 327 bytes, so fits in
        // `original`; a longer token is a noncanonical Number under
        // arbitrary_precision. The exponent's
        // leading zero preserves that distinction through serde buffering.
        if self.fraction {
            write!(
                &mut remaining,
                "{sign}{}.{}e{}0{}",
                &coefficient[..1],
                if self.retained == 1 {
                    "0"
                } else {
                    &coefficient[1..]
                },
                if self.exponent + self.retained as i128 - 1 < 0 {
                    "-"
                } else {
                    "+"
                },
                (self.exponent + self.retained as i128 - 1).abs()
            )?;
        } else {
            write!(
                &mut remaining,
                "{sign}{coefficient}e{}0{}",
                if self.exponent < 0 { "-" } else { "+" },
                self.exponent.abs()
            )?;
        }
        let written = SHORT_NUMBER_BYTES - remaining.len();
        Ok(&buffer[..written])
    }
}
fn position_overflow() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "numeric source position overflow",
    )
}
