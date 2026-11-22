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

use crate::{Error, Fingerprint};
use maka_capabilities::filesystem::PinnedReader;
use maka_capabilities::filesystem::ReadRange;
use serde::Deserialize;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

pub(crate) fn decode<'a, T: Deserialize<'a>>(value: &'a RawValue, line: u64) -> Result<T, Error> {
    serde_json::from_str(value.get()).map_err(|source| Error::Decode { line, source })
}

pub(crate) struct Line<'a> {
    pub number: u64,
    pub json: &'a RawValue,
}
impl Line<'_> {
    pub fn decode<'a, T: Deserialize<'a>>(&'a self) -> Result<T, Error> {
        serde_json::from_str(self.json.get()).map_err(|source| Error::Decode {
            line: self.number,
            source,
        })
    }
}

/// All formats get strict interior parsing, chunked reads and a source digest.
/// Only a syntactically unfinished final write is ignored, never a corrupt row.
pub(crate) fn scan(
    reader: &mut PinnedReader<'_>,
    length: u64,
    mut accept: impl FnMut(Line<'_>) -> Result<(), Error>,
) -> Result<Fingerprint, Error> {
    let mut digest = Sha256::new();
    let mut pending = Vec::new();
    let mut offset = 0;
    let mut number = 0;
    loop {
        let page = reader.read(ReadRange {
            offset,
            limit: 64 * 1024,
        })?;
        digest.update(&page.bytes);
        for segment in page.bytes.split_inclusive(|byte| *byte == b'\n') {
            pending.extend_from_slice(segment);
            if segment.last() == Some(&b'\n') {
                number += 1;
                parse(&pending, number, false, &mut accept)?;
                pending.clear();
            }
        }
        match page.next_offset {
            Some(next) => offset = next,
            None => break,
        }
    }
    let incomplete_tail = if pending.is_empty() {
        false
    } else {
        number += 1;
        parse(&pending, number, true, &mut accept)?
    };
    Ok(Fingerprint {
        bytes: length,
        sha256: hex::encode(digest.finalize()),
        incomplete_tail,
    })
}
fn parse(
    bytes: &[u8],
    number: u64,
    last: bool,
    accept: &mut impl FnMut(Line<'_>) -> Result<(), Error>,
) -> Result<bool, Error> {
    let bytes = if number == 1 {
        bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes)
    } else {
        bytes
    };
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(false);
    }
    match serde_json::from_slice::<&RawValue>(bytes) {
        Ok(json) => {
            accept(Line { number, json })?;
            Ok(false)
        }
        Err(error) if last && error.is_eof() => Ok(true),
        Err(source) => Err(Error::Decode {
            line: number,
            source,
        }),
    }
}
