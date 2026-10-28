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

//! Fixed index candidates are authorized only by exact original identity bytes.
use super::*;
use crate::artifacts::identity;
use sha2::Digest;

struct InterruptRead<'a> {
    raw: &'a RawConnection,
    read: &'a mut dyn Read,
}
impl Read for InterruptRead<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if self.raw.is_interrupted() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "artifact identity read interrupted",
            ));
        }
        self.read.read(bytes)
    }
}
fn with_range<T>(
    raw: &RawConnection,
    backing: &Backing,
    range: Range<u64>,
    consume: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let length = range.end - range.start;
    match *backing {
        Backing::Row { rowid, .. } => with_blob(
            raw,
            "context_semantic_rows",
            "row_json",
            rowid,
            range.start,
            length,
            consume,
        ),
        Backing::Canonical { key, offset, bytes } => {
            check_canonical(raw, key, offset, bytes)?;
            with_blob(
                raw,
                "event_log",
                "event_json",
                key.source_sequence as i64,
                offset
                    .checked_add(range.start)
                    .ok_or_else(|| invalid("identity range overflow"))?,
                length,
                consume,
            )
        }
        Backing::Pieces { key, .. } => {
            check_pieces(raw, key)?;
            let mut reader = PieceReader {
                raw,
                key,
                piece: (range.start / (32 * 1024)) as i64,
                offset: range.start % (32 * 1024),
                failed: None,
            };
            let result = consume(&mut (&mut reader).take(length));
            match reader.failed {
                Some(error) => Err(error),
                None => result,
            }
        }
        Backing::Artifact {
            rowid,
            bytes,
            digest,
        } => {
            check_artifact(raw, rowid, bytes, &digest)?;
            with_blob(
                raw,
                "artifacts",
                "payload",
                rowid,
                range.start,
                length,
                consume,
            )
        }
        Backing::ArtifactMetadata {
            rowid,
            payload_bytes,
            digest,
            ..
        } => {
            check_artifact(raw, rowid, payload_bytes, &digest)?;
            with_blob(
                raw,
                "artifacts",
                "record_json",
                rowid,
                range.start,
                length,
                consume,
            )
        }
        Backing::PartText { .. } => Err(invalid("identity requires addressable encoded source")),
    }
}
struct Input<'a> {
    reader: &'a mut dyn Read,
    buffer: &'a mut [u8],
    at: usize,
    end: usize,
}
impl Input<'_> {
    fn next(&mut self) -> Result<Option<u8>, StoreError> {
        if self.at == self.end {
            self.end = self.reader.read(self.buffer)?;
            self.at = 0;
            if self.end == 0 {
                return Ok(None);
            }
        }
        let byte = self.buffer[self.at];
        self.at += 1;
        Ok(Some(byte))
    }
    fn required(&mut self) -> Result<u8, StoreError> {
        self.next()?
            .ok_or_else(|| invalid("incomplete identity string token"))
    }
}
fn hex_quad(input: &mut Input<'_>) -> Result<u16, StoreError> {
    let mut code = 0u16;
    for _ in 0..4 {
        let digit = input.required()?;
        let value = match digit {
            b'0'..=b'9' => digit - b'0',
            b'a'..=b'f' => digit - b'a' + 10,
            b'A'..=b'F' => digit - b'A' + 10,
            _ => return Err(invalid("invalid identity unicode escape")),
        };
        code = code * 16 + u16::from(value);
    }
    Ok(code)
}
fn character(input: &mut Input<'_>, first: u8) -> Result<char, StoreError> {
    if first == b'\\' {
        return Ok(match input.required()? {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\u{8}',
            b'f' => '\u{c}',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => {
                let first = hex_quad(input)?;
                let code = if (0xd800..=0xdbff).contains(&first) {
                    if input.required()? != b'\\' || input.required()? != b'u' {
                        return Err(invalid("invalid identity surrogate pair"));
                    }
                    let second = hex_quad(input)?;
                    if !(0xdc00..=0xdfff).contains(&second) {
                        return Err(invalid("invalid identity surrogate pair"));
                    }
                    0x10000 + (u32::from(first) - 0xd800) * 0x400 + (u32::from(second) - 0xdc00)
                } else {
                    u32::from(first)
                };
                char::from_u32(code).ok_or_else(|| invalid("invalid identity unicode scalar"))?
            }
            _ => return Err(invalid("invalid identity escape")),
        });
    }
    if first < 0x20 {
        return Err(invalid("unescaped control in identity string"));
    }
    if first.is_ascii() {
        return Ok(char::from(first));
    }
    let len = match first {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return Err(invalid("invalid identity UTF-8")),
    };
    let mut bytes = [0; 4];
    bytes[0] = first;
    for byte in &mut bytes[1..len] {
        *byte = input.required()?;
    }
    let text = std::str::from_utf8(&bytes[..len]).map_err(|_| invalid("invalid identity UTF-8"))?;
    Ok(text
        .chars()
        .next()
        .expect("validated UTF-8 scalar is nonempty"))
}
fn decode(
    reader: &mut dyn Read,
    work: &mut [u8],
    mut emit: impl FnMut(&[u8]) -> Result<(), StoreError>,
) -> Result<ArtifactIdentityValidity, StoreError> {
    let middle = work.len() / 2;
    let (input, output) = work.split_at_mut(middle);
    let mut input = Input {
        reader,
        buffer: input,
        at: 0,
        end: 0,
    };
    if input.required()? != b'"' {
        return Err(invalid("artifact identity is not a JSON string"));
    }
    let mut count = 0;
    let mut any = false;
    let mut validity = ArtifactIdentityValidity::Valid;
    loop {
        let first = input.required()?;
        if first == b'"' {
            break;
        }
        let value = character(&mut input, first)?;
        any = true;
        if !(value.is_ascii_alphanumeric() || value == '_' || value == '-') {
            validity = ArtifactIdentityValidity::Invalid;
            continue;
        }
        output[count] = value as u8;
        count += 1;
        if count == output.len() {
            emit(&output[..count])?;
            count = 0;
        }
    }
    if input.next()?.is_some() {
        return Err(invalid("identity token has trailing bytes"));
    }
    if !any {
        validity = ArtifactIdentityValidity::Invalid;
    }
    if count != 0 {
        emit(&output[..count])?;
    }
    Ok(validity)
}
fn token(
    raw: &RawConnection,
    source: &PayloadSource,
    range: Range<u64>,
    work: &mut [u8],
    emit: impl FnMut(&[u8]) -> Result<(), StoreError>,
) -> Result<ArtifactIdentityValidity, StoreError> {
    with_range(raw, &source.backing, range, |read| {
        decode(&mut InterruptRead { raw, read }, work, emit)
    })
}
pub(super) fn validate(
    raw: &RawConnection,
    lookup: &mut ArtifactLookup<impl SourceBuffer>,
) -> Result<ArtifactIdentityValidity, StoreError> {
    let session = token(
        raw,
        &lookup.source,
        lookup.session_token.clone(),
        lookup.work.as_mut(),
        |_| Ok(()),
    )?;
    let artifact = token(
        raw,
        &lookup.source,
        lookup.artifact_token.clone(),
        lookup.work.as_mut(),
        |_| Ok(()),
    )?;
    Ok(
        if session == ArtifactIdentityValidity::Valid && artifact == ArtifactIdentityValidity::Valid
        {
            ArtifactIdentityValidity::Valid
        } else {
            ArtifactIdentityValidity::Invalid
        },
    )
}

fn blob_bytes(
    raw: &RawConnection,
    table: &str,
    column: &str,
    row: i64,
    consume: impl FnOnce(&mut dyn Read) -> Result<bool, StoreError>,
) -> Result<bool, StoreError> {
    let mut blob = raw.blob_open("main", table, column, row, true)?;
    let result = consume(&mut InterruptRead {
        raw,
        read: &mut blob,
    });
    close_blob(result, blob.close())
}
fn same_slice(
    raw: &RawConnection,
    table: &str,
    column: &str,
    row: i64,
    expected: &[u8],
    work: &mut [u8],
) -> Result<bool, StoreError> {
    blob_bytes(raw, table, column, row, |read| {
        let mut offset = 0;
        loop {
            let n = read.read(work)?;
            if n == 0 {
                return Ok(offset == expected.len());
            }
            if expected.get(offset..offset + n) != Some(&work[..n]) {
                return Ok(false);
            }
            offset += n;
        }
    })
}
fn same_token(
    raw: &RawConnection,
    table: &str,
    column: &str,
    row: i64,
    lookup: &mut ArtifactLookup<impl SourceBuffer>,
    session: bool,
) -> Result<bool, StoreError> {
    let range = if session {
        lookup.session_token.clone()
    } else {
        lookup.artifact_token.clone()
    };
    blob_bytes(raw, table, column, row, |read| {
        let mut equal = true;
        let validity = token(raw, &lookup.source, range, lookup.work.as_mut(), |bytes| {
            // Compare in fixed stack chunks, never materialize a candidate ID.
            let mut actual = [0; 256];
            for expected in bytes.chunks(actual.len()) {
                let mut count = 0;
                while count < expected.len() {
                    let n = read.read(&mut actual[count..expected.len()])?;
                    if n == 0 {
                        equal = false;
                        break;
                    }
                    count += n;
                }
                if count != expected.len() || actual[..count] != expected[..count] {
                    equal = false;
                }
            }
            Ok(())
        })?;
        let mut extra = [0];
        Ok(validity == ArtifactIdentityValidity::Valid && equal && read.read(&mut extra)? == 0)
    })
}
fn same_columns(
    raw: &RawConnection,
    left: (&str, &str, i64),
    right: (&str, &str, i64),
    work: &mut [u8],
) -> Result<bool, StoreError> {
    let (left_table, left_column, left) = left;
    let (right_table, right_column, right) = right;
    blob_bytes(raw, left_table, left_column, left, |a| {
        blob_bytes(raw, right_table, right_column, right, |b| {
            let middle = work.len() / 2;
            let (x, y) = work.split_at_mut(middle);
            let y = &mut y[..x.len()];
            loop {
                let n = a.read(x)?;
                let mut count = 0;
                while count < n {
                    let got = b.read(&mut y[count..n])?;
                    if got == 0 {
                        return Ok(false);
                    }
                    count += got;
                }
                if x[..n] != y[..n] {
                    return Ok(false);
                }
                if n == 0 {
                    let mut end = [0];
                    return Ok(b.read(&mut end)? == 0);
                }
            }
        })
    })
}
fn candidates(
    raw: &RawConnection,
    sql: &str,
    digest: &[u8; 32],
    mut check: impl FnMut(i64) -> Result<bool, StoreError>,
) -> Result<Option<i64>, StoreError> {
    let mut statement = raw.prepare(sql)?;
    let mut rows = statement.query([digest.as_slice()])?;
    while let Some(row) = rows.next()? {
        let rowid = row.get(0)?;
        if check(rowid)? {
            return Ok(Some(rowid));
        }
    }
    Ok(None)
}
const ARTIFACTS: &str =
    "SELECT rowid FROM artifacts INDEXED BY artifacts_lookup_digest WHERE lookup_digest=?";
const ALIASES: &str = "SELECT rowid FROM session_history_artifacts INDEXED BY history_artifacts_lookup_digest WHERE lookup_digest=?";
const TARGETS: &str = "SELECT rowid FROM session_history_artifacts INDEXED BY history_artifacts_target_digest WHERE target_digest=?";
pub(super) fn resolve(
    raw: &RawConnection,
    owner: &str,
    lookup: &mut ArtifactLookup<impl SourceBuffer>,
) -> Result<ArtifactLookupResult<(i64, bool)>, StoreError> {
    let mut artifact_hash = identity::artifact_hasher();
    let mut alias_hash = identity::history_hasher();
    alias_hash.update(owner.as_bytes());
    alias_hash.update([0]);
    let mut local = true;
    let mut offset = 0;
    let session_validity = token(
        raw,
        &lookup.source,
        lookup.session_token.clone(),
        lookup.work.as_mut(),
        |bytes| {
            artifact_hash.update(bytes);
            alias_hash.update(bytes);
            if owner.as_bytes().get(offset..offset + bytes.len()) != Some(bytes) {
                local = false;
            }
            offset += bytes.len();
            Ok(())
        },
    )?;
    local &= offset == owner.len();
    artifact_hash.update([0]);
    alias_hash.update([0]);
    let artifact_validity = token(
        raw,
        &lookup.source,
        lookup.artifact_token.clone(),
        lookup.work.as_mut(),
        |bytes| {
            artifact_hash.update(bytes);
            alias_hash.update(bytes);
            Ok(())
        },
    )?;
    if session_validity == ArtifactIdentityValidity::Invalid
        || artifact_validity == ArtifactIdentityValidity::Invalid
    {
        return Ok(ArtifactLookupResult::InvalidIdentity);
    }
    let digest: [u8; 32] = artifact_hash.finalize().into();
    let target = if local {
        candidates(raw, ARTIFACTS, &digest, |row| {
            Ok(same_slice(
                raw,
                "artifacts",
                "session_id",
                row,
                owner.as_bytes(),
                lookup.work.as_mut(),
            )? && same_token(raw, "artifacts", "id", row, lookup, false)?)
        })?
        .map(|row| (row, false))
    } else {
        let alias_digest: [u8; 32] = alias_hash.finalize().into();
        let alias = candidates(raw, ALIASES, &alias_digest, |row| {
            Ok(same_slice(
                raw,
                "session_history_artifacts",
                "session_id",
                row,
                owner.as_bytes(),
                lookup.work.as_mut(),
            )? && same_token(
                raw,
                "session_history_artifacts",
                "source_session_id",
                row,
                lookup,
                true,
            )? && same_token(
                raw,
                "session_history_artifacts",
                "source_artifact_id",
                row,
                lookup,
                false,
            )?)
        })?;
        let Some(alias) = alias else {
            return Ok(ArtifactLookupResult::Missing);
        };
        let target_digest: [u8; 32] = raw.query_row(
            "SELECT target_digest FROM session_history_artifacts WHERE rowid=?",
            [alias],
            |r| r.get(0),
        )?;
        candidates(raw, ARTIFACTS, &target_digest, |row| {
            Ok(same_slice(
                raw,
                "artifacts",
                "session_id",
                row,
                owner.as_bytes(),
                lookup.work.as_mut(),
            )? && same_columns(
                raw,
                ("artifacts", "id", row),
                ("session_history_artifacts", "artifact_id", alias),
                lookup.work.as_mut(),
            )?)
        })?
        .map(|row| (row, true))
    };
    let Some((row, protected)) = target else {
        return Ok(ArtifactLookupResult::Missing);
    };
    if protected {
        return Ok(ArtifactLookupResult::Captured((row, true)));
    }
    let protected = candidates(raw, TARGETS, &digest, |alias| {
        Ok(same_slice(
            raw,
            "session_history_artifacts",
            "session_id",
            alias,
            owner.as_bytes(),
            lookup.work.as_mut(),
        )? && same_columns(
            raw,
            ("artifacts", "id", row),
            ("session_history_artifacts", "artifact_id", alias),
            lookup.work.as_mut(),
        )?)
    })?
    .is_some();
    Ok(ArtifactLookupResult::Captured((row, protected)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_decoder_handles_escape_boundaries_without_identity_sized_work() {
        let raw = br#""a\u0042_-09""#;
        let mut work = [0; 2];
        let mut got = Vec::new();
        assert_eq!(
            decode(&mut raw.as_slice(), &mut work, |bytes| {
                got.extend_from_slice(bytes);
                Ok(())
            })
            .unwrap(),
            ArtifactIdentityValidity::Valid
        );
        assert_eq!(got, b"aB_-09");
        for raw in [
            br#""""#.as_slice(),
            br#""a/b""#,
            br#""\u00e9""#,
            br#""\ud83d\ude00""#,
            br#""\n""#,
            br#""a\/b""#,
            br#""a\\b""#,
            br#""a\"b""#,
            "\"世界\"".as_bytes(),
        ] {
            let mut input = raw;
            assert_eq!(
                decode(&mut input, &mut work, |_| Ok(())).unwrap(),
                ArtifactIdentityValidity::Invalid
            );
        }
    }
    #[test]
    fn identity_decoder_preserves_json_corruption_and_read_failures_after_invalid_entity() {
        let mut work = [0; 2];
        for raw in [
            br#""\ud800""#.as_slice(),
            br#""\udc00""#,
            br#""\ud800\u0041""#,
            br#""bad/\z""#,
            br#""bad/\u00q0""#,
            br#""ok"x"#,
            b"\"bad/\xf0\x80\x80\x80\"",
            b"\"bad/\n\"",
            b"\"bad/",
        ] {
            let mut input = raw;
            assert!(matches!(
                decode(&mut input, &mut work, |_| Ok(())),
                Err(StoreError::InvalidTransition(_))
            ));
        }
        struct Failing<'a>(&'a [u8]);
        impl Read for Failing<'_> {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                if self.0.is_empty() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "original read failure",
                    ));
                }
                self.0.read(bytes)
            }
        }
        let error = decode(&mut Failing(b"\"bad/"), &mut work, |_| Ok(())).unwrap_err();
        assert!(
            matches!(error,StoreError::Io(error) if error.kind()==std::io::ErrorKind::PermissionDenied)
        );
    }
}
