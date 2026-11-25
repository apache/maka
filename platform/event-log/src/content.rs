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

//! Immutable bytes are shared; domain bindings retain ownership and access policy.
//!
//! Blobs in `contents` are stored in one of four encodings:
//! - `encoding = 0` (`ENCODING_RAW`): raw uncompressed bytes (`logical_bytes IS NULL`).
//! - `encoding = 1` (`ENCODING_ZSTD`): single zstd frame for payloads `256 B..=64 KiB`
//!   (`logical_bytes = uncompressed byte count`).
//! - `encoding = 2` (`ENCODING_ZSTD_SEEKABLE`): independent `64 KiB` zstd frames followed
//!   by a standard Zstd Seekable Format skippable footer (`0x184D2A5E` / `0x8F92EAB1`) for
//!   payloads `> 64 KiB`, enabling bounded `O(64 KiB)` random-access reads over SQLite
//!   incremental Blob I/O without loading or decompressing the entire blob.
//! - `encoding = 3` (`ENCODING_ZSTD_DICT_V1`): single zstd frame compressed with the
//!   bundled 32 KiB schema-only dictionary (`content/dict_v1.bin`) for small JSON-like
//!   payloads (`128 B..=4 KiB`) when smaller than plain zstd and raw.
//!
//! `content_sha256` always digests the uncompressed bytes.

use crate::StoreError;
use rusqlite::functions::FunctionFlags;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{OptionalExtension, params};
use std::borrow::Cow;
use std::cell::RefCell;
use std::io::{self, Cursor, Read, Seek, SeekFrom};
use std::sync::OnceLock;

pub const ENCODING_RAW: i64 = 0;
pub const ENCODING_ZSTD: i64 = 1;
pub const ENCODING_ZSTD_SEEKABLE: i64 = 2;
pub const ENCODING_ZSTD_DICT_V1: i64 = 3;
pub const DICT_MIN_BYTES: usize = 128;
pub const DICT_MAX_BYTES: usize = 4 * 1024;
pub const COMPRESS_THRESHOLD_BYTES: usize = 256;
pub const SEEKABLE_FRAME_BYTES: usize = 64 * 1024;
pub const ZSTD_LEVEL: i32 = 3;
pub const RECOMPRESS_DEFAULT_BATCH_BYTES: usize = 8 * 1024 * 1024;
const RECOMPRESS_MAX_BATCH_ROWS: i64 = 512;

static DICT_V1_BYTES: &[u8] = include_bytes!("content/dict_v1.bin");
static ENCODER_DICT_V1: OnceLock<zstd::dict::EncoderDictionary<'static>> = OnceLock::new();
static DECODER_DICT_V1: OnceLock<zstd::dict::DecoderDictionary<'static>> = OnceLock::new();

fn encoder_dict_v1() -> &'static zstd::dict::EncoderDictionary<'static> {
    ENCODER_DICT_V1.get_or_init(|| zstd::dict::EncoderDictionary::copy(DICT_V1_BYTES, ZSTD_LEVEL))
}

fn decoder_dict_v1() -> &'static zstd::dict::DecoderDictionary<'static> {
    DECODER_DICT_V1.get_or_init(|| zstd::dict::DecoderDictionary::copy(DICT_V1_BYTES))
}

const SKIPPABLE_MAGIC_SEEKABLE: u32 = 0x184D_2A5E;
const SEEKABLE_FOOTER_MAGIC: u32 = 0x8F92_EAB1;
const SKIPPABLE_HEADER_SIZE: usize = 8;
const SEEKABLE_FOOTER_SIZE: usize = 9;
const SEEK_ENTRY_SIZE: usize = 8;
const MAX_SEEKABLE_FRAME_BYTES: usize = 16 * 1024 * 1024;

const INSERT: &str = "INSERT INTO contents(content_sha256,payload,encoding,logical_bytes) VALUES(?1,?2,?3,?4) ON CONFLICT(content_sha256) DO NOTHING RETURNING id";
const READ_ID: &str = "SELECT id FROM contents WHERE content_sha256=?";

thread_local! {
    static COMPRESSOR: RefCell<Option<zstd::bulk::Compressor<'static>>> = const { RefCell::new(None) };
    static DECOMPRESSOR: RefCell<Option<zstd::bulk::Decompressor<'static>>> = const { RefCell::new(None) };
    static DICT_COMPRESSOR: RefCell<Option<zstd::bulk::Compressor<'static>>> = const { RefCell::new(None) };
    static DICT_DECOMPRESSOR: RefCell<Option<zstd::bulk::Decompressor<'static>>> = const { RefCell::new(None) };
}

#[cfg(test)]
#[derive(Default, Clone, Copy, Debug)]
struct SeekableReadStats {
    decompressed_bytes: u64,
    frames_decompressed: u64,
    peak_frame_buf: usize,
}

#[cfg(test)]
thread_local! {
    static SEEKABLE_STATS: std::cell::Cell<SeekableReadStats> = const {
        std::cell::Cell::new(SeekableReadStats {
            decompressed_bytes: 0,
            frames_decompressed: 0,
            peak_frame_buf: 0,
        })
    };
}

pub(super) fn with_compressor<T>(
    f: impl FnOnce(&mut zstd::bulk::Compressor<'static>) -> io::Result<T>,
) -> io::Result<T> {
    COMPRESSOR.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(zstd::bulk::Compressor::new(ZSTD_LEVEL)?);
        }
        f(slot.as_mut().expect("compressor initialized"))
    })
}

pub(super) fn with_decompressor<T>(
    f: impl FnOnce(&mut zstd::bulk::Decompressor<'static>) -> io::Result<T>,
) -> io::Result<T> {
    DECOMPRESSOR.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(zstd::bulk::Decompressor::new()?);
        }
        f(slot.as_mut().expect("decompressor initialized"))
    })
}

fn with_dict_compressor<T>(
    f: impl FnOnce(&mut zstd::bulk::Compressor<'static>) -> io::Result<T>,
) -> io::Result<T> {
    DICT_COMPRESSOR.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(zstd::bulk::Compressor::with_prepared_dictionary(
                encoder_dict_v1(),
            )?);
        }
        f(slot.as_mut().expect("dict compressor initialized"))
    })
}

fn with_dict_decompressor<T>(
    f: impl FnOnce(&mut zstd::bulk::Decompressor<'static>) -> io::Result<T>,
) -> io::Result<T> {
    DICT_DECOMPRESSOR.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(zstd::bulk::Decompressor::with_prepared_dictionary(
                decoder_dict_v1(),
            )?);
        }
        f(slot.as_mut().expect("dict decompressor initialized"))
    })
}

/// Encoded representation ready to store in `contents`.
#[derive(Debug)]
pub struct EncodedContent<'a> {
    pub payload: Cow<'a, [u8]>,
    pub encoding: i64,
    pub logical_bytes: Option<i64>,
}

/// Encode bytes for storage in `contents`.
///
/// - `< 128 B`: stored raw (`ENCODING_RAW`, `logical_bytes = None`).
/// - `128 B..=4 KiB` JSON-like payloads (`{` or `[`): tries bundled schema dictionary v1
///   (`ENCODING_ZSTD_DICT_V1`) against plain zstd (`ENCODING_ZSTD` when `>= 256 B`) and
///   picks the smallest representation strictly smaller than raw.
/// - `256 B..=64 KiB`: single zstd frame (`ENCODING_ZSTD`) if strictly smaller, else raw.
/// - `> 64 KiB`: independent `64 KiB` zstd frames + standard Zstd Seekable Format footer
///   (`ENCODING_ZSTD_SEEKABLE`) if strictly smaller, else raw.
pub fn encode(bytes: &[u8]) -> Result<EncodedContent<'_>, StoreError> {
    if bytes.len() < DICT_MIN_BYTES {
        return Ok(EncodedContent {
            payload: Cow::Borrowed(bytes),
            encoding: ENCODING_RAW,
            logical_bytes: None,
        });
    }
    let logical = i64::try_from(bytes.len())
        .map_err(|_| StoreError::InvalidTransition("content byte length overflow".into()))?;
    let json_like = matches!(bytes.first(), Some(b'{' | b'['));
    if bytes.len() <= DICT_MAX_BYTES && json_like {
        let dict_compressed = with_dict_compressor(|compressor| compressor.compress(bytes))?;
        if bytes.len() >= COMPRESS_THRESHOLD_BYTES {
            let plain_compressed = with_compressor(|compressor| compressor.compress(bytes))?;
            if dict_compressed.len() <= plain_compressed.len()
                && dict_compressed.len() < bytes.len()
            {
                return Ok(EncodedContent {
                    payload: Cow::Owned(dict_compressed),
                    encoding: ENCODING_ZSTD_DICT_V1,
                    logical_bytes: Some(logical),
                });
            }
            if plain_compressed.len() < bytes.len() {
                return Ok(EncodedContent {
                    payload: Cow::Owned(plain_compressed),
                    encoding: ENCODING_ZSTD,
                    logical_bytes: Some(logical),
                });
            }
        } else if dict_compressed.len() < bytes.len() {
            return Ok(EncodedContent {
                payload: Cow::Owned(dict_compressed),
                encoding: ENCODING_ZSTD_DICT_V1,
                logical_bytes: Some(logical),
            });
        }
        return Ok(EncodedContent {
            payload: Cow::Borrowed(bytes),
            encoding: ENCODING_RAW,
            logical_bytes: None,
        });
    }
    if bytes.len() < COMPRESS_THRESHOLD_BYTES {
        return Ok(EncodedContent {
            payload: Cow::Borrowed(bytes),
            encoding: ENCODING_RAW,
            logical_bytes: None,
        });
    }
    if bytes.len() <= SEEKABLE_FRAME_BYTES {
        let compressed = with_compressor(|compressor| compressor.compress(bytes))?;
        if compressed.len() < bytes.len() {
            return Ok(EncodedContent {
                payload: Cow::Owned(compressed),
                encoding: ENCODING_ZSTD,
                logical_bytes: Some(logical),
            });
        }
        return Ok(EncodedContent {
            payload: Cow::Borrowed(bytes),
            encoding: ENCODING_RAW,
            logical_bytes: None,
        });
    }

    let num_frames = bytes.len().div_ceil(SEEKABLE_FRAME_BYTES);
    let table_body_len = num_frames
        .checked_mul(SEEK_ENTRY_SIZE)
        .and_then(|n| n.checked_add(SEEKABLE_FOOTER_SIZE))
        .ok_or_else(|| StoreError::InvalidTransition("seekable frame table overflow".into()))?;
    let table_body_u32 = u32::try_from(table_body_len)
        .map_err(|_| StoreError::InvalidTransition("seekable frame table exceeds u32".into()))?;
    let table_total_len = SKIPPABLE_HEADER_SIZE
        .checked_add(table_body_len)
        .ok_or_else(|| StoreError::InvalidTransition("seekable footer length overflow".into()))?;
    if table_total_len >= bytes.len() {
        return Ok(EncodedContent {
            payload: Cow::Borrowed(bytes),
            encoding: ENCODING_RAW,
            logical_bytes: None,
        });
    }
    let max_compressed_data = bytes.len() - table_total_len;

    let mut out = Vec::with_capacity((bytes.len() / 2).max(SEEKABLE_FRAME_BYTES));
    let mut entries = Vec::with_capacity(num_frames);
    let shrunk = with_compressor(|compressor| {
        for chunk in bytes.chunks(SEEKABLE_FRAME_BYTES) {
            let frame = compressor.compress(chunk)?;
            if out.len().saturating_add(frame.len()) >= max_compressed_data {
                return Ok(false);
            }
            let comp_size = u32::try_from(frame.len()).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "compressed frame exceeds u32")
            })?;
            let dec_size = u32::try_from(chunk.len()).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "decompressed frame exceeds u32")
            })?;
            out.extend_from_slice(&frame);
            entries.push((comp_size, dec_size));
        }
        Ok(true)
    })?;

    if !shrunk {
        return Ok(EncodedContent {
            payload: Cow::Borrowed(bytes),
            encoding: ENCODING_RAW,
            logical_bytes: None,
        });
    }

    let num_frames_u32 = u32::try_from(entries.len())
        .map_err(|_| StoreError::InvalidTransition("seekable frame count exceeds u32".into()))?;
    out.reserve(table_total_len);
    out.extend_from_slice(&SKIPPABLE_MAGIC_SEEKABLE.to_le_bytes());
    out.extend_from_slice(&table_body_u32.to_le_bytes());
    for (comp_size, dec_size) in entries {
        out.extend_from_slice(&comp_size.to_le_bytes());
        out.extend_from_slice(&dec_size.to_le_bytes());
    }
    out.extend_from_slice(&num_frames_u32.to_le_bytes());
    out.push(0_u8); // flags: checksum_flag = 0, reserved = 0
    out.extend_from_slice(&SEEKABLE_FOOTER_MAGIC.to_le_bytes());
    debug_assert!(out.len() < bytes.len());

    Ok(EncodedContent {
        payload: Cow::Owned(out),
        encoding: ENCODING_ZSTD_SEEKABLE,
        logical_bytes: Some(logical),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SeekEntry {
    comp_offset: u64,
    comp_size: u32,
    dec_offset: u64,
    dec_size: u32,
}

#[derive(Debug, Clone)]
struct SeekTable {
    entries: Vec<SeekEntry>,
    total_decompressed: u64,
}

impl SeekTable {
    fn parse_footer(
        footer: &[u8; SEEKABLE_FOOTER_SIZE],
        blob_len: u64,
    ) -> io::Result<(usize, u64, u32)> {
        let num_frames = u32::from_le_bytes(footer[0..4].try_into().expect("4-byte frame count"));
        let flags = footer[4];
        let magic = u32::from_le_bytes(footer[5..9].try_into().expect("4-byte footer magic"));
        if magic != SEEKABLE_FOOTER_MAGIC {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid zstd seekable footer magic",
            ));
        }
        if flags != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported zstd seekable footer flags {flags:#x}"),
            ));
        }
        if num_frames == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "zstd seekable table has zero frames",
            ));
        }
        let table_body_len = u64::from(num_frames)
            .checked_mul(SEEK_ENTRY_SIZE as u64)
            .and_then(|n| n.checked_add(SEEKABLE_FOOTER_SIZE as u64))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "zstd seekable table size overflow",
                )
            })?;
        let table_body_u32 = u32::try_from(table_body_len).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "zstd seekable table exceeds u32",
            )
        })?;
        let table_total_len = table_body_len
            .checked_add(SKIPPABLE_HEADER_SIZE as u64)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "zstd seekable footer size overflow",
                )
            })?;
        if table_total_len > blob_len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "zstd seekable table extends past payload boundary",
            ));
        }
        let num_frames_usize = usize::try_from(num_frames).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "zstd seekable frame count overflow",
            )
        })?;
        Ok((num_frames_usize, blob_len - table_total_len, table_body_u32))
    }

    fn parse_body(
        skippable_prefix: &[u8],
        num_frames: usize,
        expected_frame_size: u32,
        data_end: u64,
        expected_logical: Option<u64>,
    ) -> io::Result<Self> {
        let expected_prefix_len = SKIPPABLE_HEADER_SIZE + num_frames * SEEK_ENTRY_SIZE;
        if skippable_prefix.len() != expected_prefix_len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "zstd seekable table prefix length mismatch",
            ));
        }
        let magic = u32::from_le_bytes(
            skippable_prefix[0..4]
                .try_into()
                .expect("4-byte skippable magic"),
        );
        let frame_size = u32::from_le_bytes(
            skippable_prefix[4..8]
                .try_into()
                .expect("4-byte frame size"),
        );
        if magic != SKIPPABLE_MAGIC_SEEKABLE || frame_size != expected_frame_size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid zstd seekable skippable frame header",
            ));
        }
        let mut entries = Vec::with_capacity(num_frames);
        let mut comp_offset = 0_u64;
        let mut dec_offset = 0_u64;
        for chunk in skippable_prefix[SKIPPABLE_HEADER_SIZE..]
            .as_chunks::<SEEK_ENTRY_SIZE>()
            .0
        {
            let comp_size = u32::from_le_bytes(chunk[0..4].try_into().expect("4-byte comp_size"));
            let dec_size = u32::from_le_bytes(chunk[4..8].try_into().expect("4-byte dec_size"));
            if comp_size == 0 || dec_size == 0 || (dec_size as usize) > MAX_SEEKABLE_FRAME_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid zstd seekable frame dimensions",
                ));
            }
            let next_comp = comp_offset
                .checked_add(u64::from(comp_size))
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "compressed offset overflow")
                })?;
            let next_dec = dec_offset.checked_add(u64::from(dec_size)).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "decompressed offset overflow")
            })?;
            entries.push(SeekEntry {
                comp_offset,
                comp_size,
                dec_offset,
                dec_size,
            });
            comp_offset = next_comp;
            dec_offset = next_dec;
        }
        if comp_offset != data_end {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "zstd seekable frame sizes do not cover compressed payload",
            ));
        }
        if let Some(expected) = expected_logical
            && dec_offset != expected
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "zstd seekable logical length {dec_offset} differs from expected {expected}"
                ),
            ));
        }
        Ok(Self {
            entries,
            total_decompressed: dec_offset,
        })
    }

    fn from_slice(payload: &[u8], expected_logical: Option<u64>) -> io::Result<Self> {
        if payload.len() < SKIPPABLE_HEADER_SIZE + SEEKABLE_FOOTER_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "truncated zstd seekable payload",
            ));
        }
        let footer: [u8; SEEKABLE_FOOTER_SIZE] = payload[payload.len() - SEEKABLE_FOOTER_SIZE..]
            .try_into()
            .expect("9-byte seekable footer");
        let (num_frames, table_start, frame_size) =
            Self::parse_footer(&footer, payload.len() as u64)?;
        let start = usize::try_from(table_start).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "seekable table offset overflow")
        })?;
        let prefix = &payload[start..payload.len() - SEEKABLE_FOOTER_SIZE];
        Self::parse_body(
            prefix,
            num_frames,
            frame_size,
            table_start,
            expected_logical,
        )
    }

    fn from_blob(
        blob: &rusqlite::blob::Blob<'_>,
        expected_logical: Option<u64>,
    ) -> io::Result<Self> {
        let blob_len = blob.len();
        if blob_len < SKIPPABLE_HEADER_SIZE + SEEKABLE_FOOTER_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "truncated zstd seekable blob",
            ));
        }
        let mut footer = [0_u8; SEEKABLE_FOOTER_SIZE];
        blob.read_at_exact(&mut footer, blob_len - SEEKABLE_FOOTER_SIZE)
            .map_err(io::Error::other)?;
        let (num_frames, table_start, frame_size) = Self::parse_footer(&footer, blob_len as u64)?;
        let start = usize::try_from(table_start).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "seekable table offset overflow")
        })?;
        let prefix_len = blob_len - SEEKABLE_FOOTER_SIZE - start;
        let mut prefix = vec![0_u8; prefix_len];
        blob.read_at_exact(&mut prefix, start)
            .map_err(io::Error::other)?;
        Self::parse_body(
            &prefix,
            num_frames,
            frame_size,
            table_start,
            expected_logical,
        )
    }

    fn frame_index_for_offset(&self, offset: u64) -> Option<usize> {
        let idx = self
            .entries
            .partition_point(|e| e.dec_offset.saturating_add(u64::from(e.dec_size)) <= offset);
        (idx < self.entries.len()).then_some(idx)
    }
}

const MAX_SQL_UDF_DECODE_BYTES: usize = 64 * 1024 * 1024;
const RECOMPRESS_OVERSIZED_MAX_WRITE_BYTES: u64 = 16 * 1024 * 1024;

fn decode_zstd(payload: &[u8], expected_len: Option<usize>) -> io::Result<Vec<u8>> {
    let target = match expected_len {
        Some(len) => Some(len),
        None => match zstd::zstd_safe::get_frame_content_size(payload) {
            Ok(Some(size)) => {
                if size > MAX_SQL_UDF_DECODE_BYTES as u64 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "zstd frame exceeds SQL decode limit",
                    ));
                }
                let cap = payload.len().saturating_mul(64).max(64 * 1024) as u64;
                if size <= cap {
                    usize::try_from(size).ok()
                } else {
                    None
                }
            }
            Ok(None) => None,
            Err(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid zstd frame header",
                ));
            }
        },
    };
    if let Some(len) = target {
        let mut out = vec![0_u8; len];
        let written =
            with_decompressor(|decompressor| decompressor.decompress_to_buffer(payload, &mut out))?;
        if written != len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("decoded content length {written} differs from expected {len}"),
            ));
        }
        return Ok(out);
    }
    let decoder = zstd::stream::Decoder::new(payload)?;
    let mut limited = decoder.take((MAX_SQL_UDF_DECODE_BYTES + 1) as u64);
    let mut out = Vec::new();
    limited.read_to_end(&mut out)?;
    if out.len() > MAX_SQL_UDF_DECODE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "zstd stream exceeds SQL decode limit",
        ));
    }
    Ok(out)
}

fn decode_seekable(payload: &[u8], expected_len: Option<usize>) -> io::Result<Vec<u8>> {
    let table = SeekTable::from_slice(payload, expected_len.map(|n| n as u64))?;
    if expected_len.is_none() && table.total_decompressed > MAX_SQL_UDF_DECODE_BYTES as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "seekable content exceeds SQL decode limit",
        ));
    }
    let total = usize::try_from(table.total_decompressed).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "seekable content length overflow",
        )
    })?;
    let mut out = vec![0_u8; total];
    with_decompressor(|decompressor| {
        for entry in &table.entries {
            let comp_start = usize::try_from(entry.comp_offset).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "compressed offset overflow")
            })?;
            let comp_end = comp_start
                .checked_add(entry.comp_size as usize)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "compressed range overflow")
                })?;
            let dec_start = usize::try_from(entry.dec_offset).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "decompressed offset overflow")
            })?;
            let dec_end = dec_start
                .checked_add(entry.dec_size as usize)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "decompressed range overflow")
                })?;
            let written = decompressor.decompress_to_buffer(
                &payload[comp_start..comp_end],
                &mut out[dec_start..dec_end],
            )?;
            if written != entry.dec_size as usize {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "seekable frame decoded {written} bytes, expected {}",
                        entry.dec_size
                    ),
                ));
            }
        }
        Ok(())
    })?;
    Ok(out)
}

fn decode_zstd_dict_v1(payload: &[u8], expected_len: Option<usize>) -> io::Result<Vec<u8>> {
    let target = match expected_len {
        Some(len) => Some(len),
        None => match zstd::zstd_safe::get_frame_content_size(payload) {
            Ok(Some(size)) => {
                if size > MAX_SQL_UDF_DECODE_BYTES as u64 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "zstd dict frame exceeds SQL decode limit",
                    ));
                }
                let cap = payload.len().saturating_mul(64).max(64 * 1024) as u64;
                if size <= cap {
                    usize::try_from(size).ok()
                } else {
                    None
                }
            }
            Ok(None) => None,
            Err(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid zstd dict frame header",
                ));
            }
        },
    };
    if let Some(len) = target {
        let mut out = vec![0_u8; len];
        let written = with_dict_decompressor(|decompressor| {
            decompressor.decompress_to_buffer(payload, &mut out)
        })?;
        if written != len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("decoded dict content length {written} differs from expected {len}"),
            ));
        }
        return Ok(out);
    }
    let decoder = zstd::stream::Decoder::with_prepared_dictionary(payload, decoder_dict_v1())?;
    let mut limited = decoder.take((MAX_SQL_UDF_DECODE_BYTES + 1) as u64);
    let mut out = Vec::new();
    limited.read_to_end(&mut out)?;
    if out.len() > MAX_SQL_UDF_DECODE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "zstd dict stream exceeds SQL decode limit",
        ));
    }
    Ok(out)
}

fn decode_payload(
    payload: &[u8],
    encoding: i64,
    expected_len: Option<usize>,
) -> io::Result<Vec<u8>> {
    match encoding {
        ENCODING_RAW => Ok(payload.to_vec()),
        ENCODING_ZSTD => decode_zstd(payload, expected_len),
        ENCODING_ZSTD_SEEKABLE => decode_seekable(payload, expected_len),
        ENCODING_ZSTD_DICT_V1 => decode_zstd_dict_v1(payload, expected_len),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported content encoding {other}"),
        )),
    }
}

/// Decode a `contents` row's stored payload according to its `encoding` and `logical_bytes`.
pub fn decode(
    payload: Vec<u8>,
    encoding: i64,
    logical_bytes: Option<i64>,
) -> Result<Vec<u8>, StoreError> {
    match encoding {
        ENCODING_RAW => {
            if logical_bytes.is_some() {
                return Err(StoreError::InvalidTransition(
                    "raw content row must not carry logical_bytes".into(),
                ));
            }
            Ok(payload)
        }
        ENCODING_ZSTD | ENCODING_ZSTD_SEEKABLE | ENCODING_ZSTD_DICT_V1 => {
            let expected = logical_bytes
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| {
                    StoreError::InvalidTransition(
                        "compressed content row missing valid logical_bytes".into(),
                    )
                })?;
            Ok(decode_payload(&payload, encoding, Some(expected))?)
        }
        other => Err(StoreError::InvalidTransition(format!(
            "unsupported content encoding {other}"
        ))),
    }
}

/// Register SQLite scalar UDFs `maka_content_bytes(payload, encoding)` and
/// `maka_content_text(payload, encoding)` on `connection`.
///
/// Safe to call multiple times on the same connection.
pub fn register_sql_functions(connection: &rusqlite::Connection) -> Result<(), StoreError> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;

    connection.create_scalar_function("maka_content_bytes", 2, flags, |ctx| {
        let encoding = ctx.get::<Option<i64>>(1)?;
        match ctx.get_raw(0) {
            ValueRef::Null => Ok(Value::Null),
            ValueRef::Blob(bytes) => match encoding {
                Some(ENCODING_RAW) => Ok(Value::Blob(bytes.to_vec())),
                Some(enc @ (ENCODING_ZSTD | ENCODING_ZSTD_SEEKABLE | ENCODING_ZSTD_DICT_V1)) => {
                    let decoded = decode_payload(bytes, enc, None)
                        .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
                    Ok(Value::Blob(decoded))
                }
                other => Err(rusqlite::Error::UserFunctionError(
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("unsupported content encoding {other:?}"),
                    )
                    .into(),
                )),
            },
            ValueRef::Text(bytes) => match encoding {
                Some(ENCODING_RAW) => Ok(Value::Blob(bytes.to_vec())),
                other => Err(rusqlite::Error::UserFunctionError(
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("text payload with non-raw content encoding {other:?}"),
                    )
                    .into(),
                )),
            },
            other => Err(rusqlite::Error::UserFunctionError(
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unexpected payload storage class {:?}", other.data_type()),
                )
                .into(),
            )),
        }
    })?;

    connection.create_scalar_function("maka_content_text", 2, flags, |ctx| {
        let encoding = ctx.get::<Option<i64>>(1)?;
        match ctx.get_raw(0) {
            ValueRef::Null => Ok(Value::Null),
            ValueRef::Blob(bytes) => match encoding {
                Some(ENCODING_RAW) => {
                    let text = std::str::from_utf8(bytes).map_err(|err| {
                        rusqlite::Error::UserFunctionError(
                            io::Error::new(io::ErrorKind::InvalidData, err).into(),
                        )
                    })?;
                    Ok(Value::Text(text.to_owned()))
                }
                Some(enc @ (ENCODING_ZSTD | ENCODING_ZSTD_SEEKABLE | ENCODING_ZSTD_DICT_V1)) => {
                    let decoded = decode_payload(bytes, enc, None)
                        .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
                    let text = String::from_utf8(decoded).map_err(|err| {
                        rusqlite::Error::UserFunctionError(
                            io::Error::new(io::ErrorKind::InvalidData, err).into(),
                        )
                    })?;
                    Ok(Value::Text(text))
                }
                other => Err(rusqlite::Error::UserFunctionError(
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("unsupported content encoding {other:?}"),
                    )
                    .into(),
                )),
            },
            ValueRef::Text(bytes) => match encoding {
                Some(ENCODING_RAW) => {
                    let text = std::str::from_utf8(bytes).map_err(|err| {
                        rusqlite::Error::UserFunctionError(
                            io::Error::new(io::ErrorKind::InvalidData, err).into(),
                        )
                    })?;
                    Ok(Value::Text(text.to_owned()))
                }
                other => Err(rusqlite::Error::UserFunctionError(
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("text payload with non-raw content encoding {other:?}"),
                    )
                    .into(),
                )),
            },
            other => Err(rusqlite::Error::UserFunctionError(
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unexpected payload storage class {:?}", other.data_type()),
                )
                .into(),
            )),
        }
    })?;

    Ok(())
}

/// Returns whether migration 63 (`contents.encoding`) is present on `connection`.
///
/// Used by read-only inspection paths and historical upgrade checks that may open
/// pre-v63 databases without running forward migrations.
pub fn has_encoding_column(connection: &rusqlite::Connection) -> Result<bool, StoreError> {
    Ok(connection
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('contents') WHERE name = 'encoding')",
        )?
        .query_row([], |row| row.get(0))?)
}

/// Trusted native SQL content insertion; the domain owns the durable reference.
pub fn put(
    connection: &rusqlite::Connection,
    digest: &str,
    bytes: &[u8],
) -> Result<i64, StoreError> {
    if let Some(id) = connection
        .prepare_cached(READ_ID)?
        .query_row([digest], |row| row.get(0))
        .optional()?
    {
        return Ok(id);
    }
    let EncodedContent {
        payload: stored,
        encoding,
        logical_bytes,
    } = encode(bytes)?;
    Ok(connection.prepare_cached(INSERT)?.query_row(
        params![digest, stored.as_ref(), encoding, logical_bytes],
        |row| row.get(0),
    )?)
}

/// Read immutable bytes by digest in the caller's already authorized Root view.
pub fn read(
    connection: &rusqlite::Connection,
    digest: &str,
) -> Result<Option<Vec<u8>>, StoreError> {
    let row: Option<(Vec<u8>, i64, Option<i64>)> = connection
        .prepare_cached(
            "SELECT payload, encoding, logical_bytes FROM contents WHERE content_sha256=?",
        )?
        .query_row([digest], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    row.map(|(payload, encoding, logical_bytes)| decode(payload, encoding, logical_bytes))
        .transpose()
}

/// Random-access streaming reader over an `ENCODING_ZSTD_SEEKABLE` SQLite Blob.
///
/// Reads only the seek-table footer on open and decompresses at most one `<= 64 KiB`
/// frame at a time into a reused working buffer.
pub struct SeekableZstdReader<'c> {
    blob: rusqlite::blob::Blob<'c>,
    table: SeekTable,
    pos: u64,
    cached_frame: Option<usize>,
    comp_buf: Vec<u8>,
    frame_buf: Vec<u8>,
}

impl<'c> SeekableZstdReader<'c> {
    fn open(
        blob: rusqlite::blob::Blob<'c>,
        logical_bytes: Option<i64>,
    ) -> Result<Self, StoreError> {
        let expected = logical_bytes
            .and_then(|n| u64::try_from(n).ok())
            .ok_or_else(|| {
                StoreError::InvalidTransition(
                    "seekable compressed content row missing valid logical_bytes".into(),
                )
            })?;
        let table = SeekTable::from_blob(&blob, Some(expected))?;
        Ok(Self {
            blob,
            table,
            pos: 0,
            cached_frame: None,
            comp_buf: Vec::new(),
            frame_buf: Vec::new(),
        })
    }

    fn load_frame(&mut self, idx: usize) -> io::Result<()> {
        if self.cached_frame == Some(idx) {
            return Ok(());
        }
        // Invalidate cache before mutating working buffers so any mid-read or
        // decompression error never leaves cached_frame pointing to truncated/corrupt bytes.
        self.cached_frame = None;
        let entry = self.table.entries[idx];
        let comp_offset = usize::try_from(entry.comp_offset).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "compressed frame offset overflow",
            )
        })?;
        self.comp_buf.resize(entry.comp_size as usize, 0);
        self.blob
            .read_at_exact(&mut self.comp_buf, comp_offset)
            .map_err(io::Error::other)?;
        self.frame_buf.resize(entry.dec_size as usize, 0);
        let written = with_decompressor(|decompressor| {
            decompressor.decompress_to_buffer(&self.comp_buf, &mut self.frame_buf)
        })?;
        if written != entry.dec_size as usize {
            self.cached_frame = None;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "seekable frame decoded {written} bytes, expected {}",
                    entry.dec_size
                ),
            ));
        }
        #[cfg(test)]
        SEEKABLE_STATS.with(|cell| {
            let mut s = cell.get();
            s.decompressed_bytes = s.decompressed_bytes.saturating_add(written as u64);
            s.frames_decompressed = s.frames_decompressed.saturating_add(1);
            s.peak_frame_buf = s.peak_frame_buf.max(self.frame_buf.len());
            cell.set(s);
        });
        self.cached_frame = Some(idx);
        Ok(())
    }
}

impl Read for SeekableZstdReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.pos >= self.table.total_decompressed {
            return Ok(0);
        }
        let Some(idx) = self.table.frame_index_for_offset(self.pos) else {
            return Ok(0);
        };
        self.load_frame(idx)?;
        let entry = self.table.entries[idx];
        let within = (self.pos - entry.dec_offset) as usize;
        let available = self.frame_buf.len() - within;
        let take = available.min(buf.len());
        buf[..take].copy_from_slice(&self.frame_buf[within..within + take]);
        self.pos += take as u64;
        Ok(take)
    }
}

impl Seek for SeekableZstdReader<'_> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let next = match pos {
            SeekFrom::Start(offset) => offset,
            SeekFrom::End(delta) => self
                .table
                .total_decompressed
                .checked_add_signed(delta)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "invalid seek to a negative or overflowing position",
                    )
                })?,
            SeekFrom::Current(delta) => self.pos.checked_add_signed(delta).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid seek to a negative or overflowing position",
                )
            })?,
        };
        self.pos = next;
        Ok(self.pos)
    }
}

/// Read/seek handle over a `contents` row:
/// - `Raw`: zero-copy SQLite incremental Blob I/O (`encoding = 0`).
/// - `Decoded`: in-memory single-frame decoded bytes (`encoding = 1`, `<= 64 KiB`).
/// - `Seekable`: SQLite incremental Blob I/O + on-demand `<= 64 KiB` frame decompression
///   (`encoding = 2`, `> 64 KiB`).
pub enum ContentReader<'c> {
    Raw(rusqlite::blob::Blob<'c>),
    Decoded(Cursor<Vec<u8>>),
    Seekable(SeekableZstdReader<'c>),
}

impl ContentReader<'_> {
    #[must_use]
    pub fn len(&self) -> u64 {
        match self {
            Self::Raw(blob) => u64::try_from(blob.len()).unwrap_or(0),
            Self::Decoded(cursor) => cursor.get_ref().len() as u64,
            Self::Seekable(reader) => reader.table.total_decompressed,
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn close(self) -> Result<(), rusqlite::Error> {
        match self {
            Self::Raw(blob) => blob.close(),
            Self::Decoded(_) => Ok(()),
            Self::Seekable(reader) => reader.blob.close(),
        }
    }
}

impl Read for ContentReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Raw(blob) => blob.read(buf),
            Self::Decoded(cursor) => cursor.read(buf),
            Self::Seekable(reader) => reader.read(buf),
        }
    }
}

impl Seek for ContentReader<'_> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        match self {
            Self::Raw(blob) => blob.seek(pos),
            Self::Decoded(cursor) => cursor.seek(pos),
            Self::Seekable(reader) => reader.seek(pos),
        }
    }
}

/// Open a `contents` row by rowid for streaming/random-access reading.
///
/// For both raw (`encoding = 0`) and seekable zstd (`encoding = 2`) rows, this opens a
/// SQLite incremental Blob handle directly without reading the full `payload` into RAM.
pub fn open_by_id<'c>(
    connection: &'c rusqlite::Connection,
    id: i64,
) -> Result<ContentReader<'c>, StoreError> {
    let (encoding, payload, logical_bytes): (i64, Option<Vec<u8>>, Option<i64>) = connection
        .prepare_cached(
            "SELECT encoding, CASE WHEN encoding IN (1, 3) THEN payload ELSE NULL END, logical_bytes FROM contents WHERE id = ?1",
        )?
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    match encoding {
        ENCODING_RAW => {
            if logical_bytes.is_some() {
                return Err(StoreError::InvalidTransition(
                    "raw content row must not carry logical_bytes".into(),
                ));
            }
            let blob = connection.blob_open("main", "contents", "payload", id, true)?;
            Ok(ContentReader::Raw(blob))
        }
        ENCODING_ZSTD | ENCODING_ZSTD_DICT_V1 => {
            let bytes = payload.ok_or_else(|| {
                StoreError::InvalidTransition("compressed content row payload is missing".into())
            })?;
            let decoded = decode(bytes, encoding, logical_bytes)?;
            Ok(ContentReader::Decoded(Cursor::new(decoded)))
        }
        ENCODING_ZSTD_SEEKABLE => {
            let blob = connection.blob_open("main", "contents", "payload", id, true)?;
            Ok(ContentReader::Seekable(SeekableZstdReader::open(
                blob,
                logical_bytes,
            )?))
        }
        other => Err(StoreError::InvalidTransition(format!(
            "unsupported content encoding {other}"
        ))),
    }
}

/// Read an exact byte range `[offset, offset + min(len, remaining))` from a `contents` row
/// using bounded incremental I/O (`O(64 KiB)` working memory for seekable compressed blobs).
pub fn read_range_by_id(
    connection: &rusqlite::Connection,
    id: i64,
    offset: u64,
    len: u64,
) -> Result<Vec<u8>, StoreError> {
    let mut reader = open_by_id(connection, id)?;
    let total = reader.len();
    let result = if offset > total {
        Err(StoreError::InvalidTransition(
            "content range offset exceeds immutable payload length".into(),
        ))
    } else {
        let want = (total - offset).min(len);
        let cap = usize::try_from(want).map_err(|_| {
            StoreError::InvalidTransition("content range length exceeds addressable memory".into())
        })?;
        (|| -> Result<Vec<u8>, StoreError> {
            reader.seek(SeekFrom::Start(offset))?;
            let mut out = Vec::with_capacity(cap);
            reader.by_ref().take(want).read_to_end(&mut out)?;
            if out.len() != cap {
                return Err(StoreError::InvalidTransition(
                    "content range ended before expected immutable length".into(),
                ));
            }
            Ok(out)
        })()
    };
    let close = reader.close();
    let bytes = result?;
    close?;
    Ok(bytes)
}

/// Outcome of one bounded background recompression step over legacy raw `contents`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RecompressBatchReport {
    pub scanned: usize,
    pub recompressed: usize,
    pub raw_bytes_saved: u64,
    pub done: bool,
}

pub(crate) enum RecompressCandidates {
    Batch {
        rows: Vec<(i64, String, Vec<u8>)>,
        next_cursor: i64,
        target_max_id: i64,
    },
    Oversized {
        id: i64,
        content_sha256: String,
        raw_len: usize,
        next_cursor: i64,
        target_max_id: i64,
    },
}

pub(crate) struct RecompressedRow {
    pub id: i64,
    pub content_sha256: String,
    pub payload: Vec<u8>,
    pub encoding: i64,
    pub logical_bytes: i64,
    pub bytes_saved: u64,
}

pub(crate) enum PreparedRecompressBatch {
    Batch {
        scanned: usize,
        updates: Vec<RecompressedRow>,
        next_cursor: i64,
        target_max_id: i64,
    },
    Oversized {
        id: i64,
        content_sha256: String,
        raw_len: usize,
        staged: Option<stream::StagedSeekable>,
        next_cursor: i64,
        target_max_id: i64,
    },
    Cancelled,
}

/// Phase 1 (short read): select the next bounded batch of pre-v63 raw `contents` rows
/// using metadata (`octet_length(payload)`) BEFORE loading any payload bytes so rejected
/// or oversized rows never blow writer-actor memory.
pub(crate) fn fetch_recompress_candidates(
    connection: &rusqlite::Connection,
    max_raw_bytes: usize,
) -> Result<Option<RecompressCandidates>, StoreError> {
    let budget = max_raw_bytes.max(1);
    let state: Option<(i64, i64)> = connection
        .prepare_cached(
            "SELECT cursor_id, target_max_id FROM content_recompression_state WHERE singleton = 1",
        )?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    let Some((cursor_id, target_max_id)) = state else {
        return Ok(None);
    };
    if cursor_id >= target_max_id {
        return Ok(None);
    }

    let mut meta_stmt = connection.prepare_cached(
        "SELECT id, content_sha256, octet_length(payload)
         FROM contents
         WHERE id > ?1 AND id <= ?2 AND encoding = 0
         ORDER BY id
         LIMIT ?3",
    )?;
    let mut query =
        meta_stmt.query(params![cursor_id, target_max_id, RECOMPRESS_MAX_BATCH_ROWS])?;
    let mut selected: Vec<(i64, String)> = Vec::new();
    let mut raw_total = 0usize;
    let mut fetched = 0i64;
    let mut hit_budget = false;
    let mut last_id = cursor_id;
    while let Some(row) = query.next()? {
        let id: i64 = row.get(0)?;
        let digest: String = row.get(1)?;
        let len_i64: i64 = row.get(2)?;
        let len = usize::try_from(len_i64).map_err(|_| {
            StoreError::InvalidTransition("negative content length during recompression".into())
        })?;
        if selected.is_empty() && len > budget {
            return Ok(Some(RecompressCandidates::Oversized {
                id,
                content_sha256: digest,
                raw_len: len,
                next_cursor: id,
                target_max_id,
            }));
        }
        if !selected.is_empty() && raw_total.saturating_add(len) > budget {
            hit_budget = true;
            break;
        }
        fetched += 1;
        last_id = id;
        raw_total = raw_total.saturating_add(len);
        selected.push((id, digest));
        if raw_total >= budget {
            hit_budget = true;
            break;
        }
    }
    let next_cursor = if !hit_budget && fetched < RECOMPRESS_MAX_BATCH_ROWS {
        target_max_id
    } else {
        last_id
    };

    let mut rows = Vec::with_capacity(selected.len());
    let mut payload_stmt = connection.prepare_cached(
        "SELECT payload FROM contents WHERE id = ?1 AND content_sha256 = ?2 AND encoding = 0",
    )?;
    for (id, digest) in selected {
        if let Some(payload) = payload_stmt
            .query_row(params![id, &digest], |row| row.get::<_, Vec<u8>>(0))
            .optional()?
        {
            rows.push((id, digest, payload));
        }
    }
    Ok(Some(RecompressCandidates::Batch {
        rows,
        next_cursor,
        target_max_id,
    }))
}

/// Phase 2a (pure CPU, no DB lock): compress in-budget candidate rows using the current `encode` policy.
pub(crate) fn compress_candidates(
    rows: Vec<(i64, String, Vec<u8>)>,
    next_cursor: i64,
    target_max_id: i64,
) -> Result<PreparedRecompressBatch, StoreError> {
    let scanned = rows.len();
    let mut updates = Vec::with_capacity(scanned);
    for (id, content_sha256, raw) in rows {
        let raw_len = raw.len();
        let encoded = encode(&raw)?;
        if encoded.encoding != ENCODING_RAW
            && let Some(logical_bytes) = encoded.logical_bytes
            && encoded.payload.len() < raw_len
        {
            let bytes_saved = (raw_len - encoded.payload.len()) as u64;
            updates.push(RecompressedRow {
                id,
                content_sha256,
                payload: encoded.payload.into_owned(),
                encoding: encoded.encoding,
                logical_bytes,
                bytes_saved,
            });
        }
    }
    Ok(PreparedRecompressBatch::Batch {
        scanned,
        updates,
        next_cursor,
        target_max_id,
    })
}

/// Phase 2b (read-only connection, bounded RAM): stream-compress one oversized legacy raw row
/// via SQLite incremental Blob I/O into a seekable zstd staging sink (spilling beyond 2 MiB).
pub(crate) fn compress_oversized_candidate(
    connection: &rusqlite::Connection,
    id: i64,
    content_sha256: String,
    raw_len: usize,
    next_cursor: i64,
    target_max_id: i64,
    stop: Option<&tokio_util::sync::CancellationToken>,
) -> Result<PreparedRecompressBatch, StoreError> {
    // Keep identity check and incremental Blob open inside one DEFERRED read snapshot so
    // concurrent package/content reclamation cannot remove or reuse the rowid in between.
    let read_tx =
        rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Deferred)?;
    let still_raw: Option<i64> = read_tx
        .prepare_cached(
            "SELECT octet_length(payload)
             FROM contents
             WHERE id = ?1 AND content_sha256 = ?2 AND encoding = 0",
        )?
        .query_row(params![id, &content_sha256], |row| row.get(0))
        .optional()?;
    if let Some(current_len) = still_raw
        && usize::try_from(current_len).ok() == Some(raw_len)
    {
        if raw_len <= SEEKABLE_FRAME_BYTES {
            let raw: Option<Vec<u8>> = read_tx
                .prepare_cached(
                    "SELECT payload FROM contents WHERE id = ?1 AND content_sha256 = ?2 AND encoding = 0",
                )?
                .query_row(params![id, &content_sha256], |row| row.get(0))
                .optional()?;
            drop(read_tx);
            let rows = raw
                .map(|bytes| vec![(id, content_sha256, bytes)])
                .unwrap_or_default();
            return compress_candidates(rows, next_cursor, target_max_id);
        }
        let blob = read_tx.blob_open(rusqlite::MAIN_DB, "contents", "payload", id, true)?;
        let staged = stream::stage_seekable_from_blob(
            &blob,
            raw_len,
            RECOMPRESS_OVERSIZED_MAX_WRITE_BYTES,
            stop,
        );
        let close = blob.close();
        drop(read_tx);
        let outcome = staged?;
        close?;
        return match outcome {
            stream::StageOversizedOutcome::Staged(sink) => Ok(PreparedRecompressBatch::Oversized {
                id,
                content_sha256,
                raw_len,
                staged: Some(sink),
                next_cursor,
                target_max_id,
            }),
            stream::StageOversizedOutcome::Skipped => Ok(PreparedRecompressBatch::Oversized {
                id,
                content_sha256,
                raw_len,
                staged: None,
                next_cursor,
                target_max_id,
            }),
            stream::StageOversizedOutcome::Cancelled => Ok(PreparedRecompressBatch::Cancelled),
        };
    }
    Ok(PreparedRecompressBatch::Oversized {
        id,
        content_sha256,
        raw_len,
        staged: None,
        next_cursor,
        target_max_id,
    })
}

fn verify_seekable_blob_digest(
    connection: &rusqlite::Connection,
    id: i64,
    expected_len: usize,
    expected_sha256: &str,
) -> Result<(), StoreError> {
    use sha2::Digest as _;
    let blob = connection.blob_open(rusqlite::MAIN_DB, "contents", "payload", id, true)?;
    let verify_res = (|| -> Result<(), StoreError> {
        let table = SeekTable::from_blob(&blob, Some(expected_len as u64))?;
        let mut hash = sha2::Sha256::new();
        let mut comp_buf = Vec::new();
        let mut dec_buf = vec![0_u8; SEEKABLE_FRAME_BYTES];
        let mut decoded_total = 0usize;
        for entry in &table.entries {
            let comp_off = usize::try_from(entry.comp_offset).map_err(|_| {
                StoreError::InvalidTransition("seekable compressed offset overflow".into())
            })?;
            let comp_len = entry.comp_size as usize;
            let dec_len = entry.dec_size as usize;
            if dec_len > dec_buf.len() {
                dec_buf.resize(dec_len, 0);
            }
            comp_buf.resize(comp_len, 0);
            blob.read_at_exact(&mut comp_buf, comp_off)?;
            let written = with_decompressor(|decompressor| {
                decompressor.decompress_to_buffer(&comp_buf, &mut dec_buf[..dec_len])
            })?;
            if written != dec_len {
                return Err(StoreError::InvalidTransition(
                    "oversized seekable frame decoded length mismatch".into(),
                ));
            }
            hash.update(&dec_buf[..dec_len]);
            decoded_total = decoded_total.checked_add(dec_len).ok_or_else(|| {
                StoreError::InvalidTransition("decoded byte count overflow".into())
            })?;
        }
        if decoded_total != expected_len {
            return Err(StoreError::InvalidTransition(
                "oversized seekable recompression logical length mismatch".into(),
            ));
        }
        let actual = format!("sha256:{}", hex::encode(hash.finalize()));
        if actual != expected_sha256 {
            return Err(StoreError::InvalidTransition(
                "oversized seekable recompression SHA-256 mismatch".into(),
            ));
        }
        Ok(())
    })();
    let close_res = blob.close();
    verify_res?;
    close_res?;
    Ok(())
}

/// Phase 3 (short IMMEDIATE write txn): apply content-preserving encoding upgrades guarded
/// by `WHERE id = ? AND content_sha256 = ? AND encoding = 0` (preventing ABA rowid-reuse
/// corruption) and advance `content_recompression_state.cursor_id`.
pub(crate) fn apply_recompressed_batch(
    connection: &rusqlite::Connection,
    batch: PreparedRecompressBatch,
) -> Result<RecompressBatchReport, StoreError> {
    if matches!(batch, PreparedRecompressBatch::Cancelled) {
        return Ok(RecompressBatchReport {
            done: true,
            ..Default::default()
        });
    }
    let tx =
        rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
    let mut recompressed = 0usize;
    let mut raw_bytes_saved = 0u64;
    let (scanned, next_cursor, target_max_id) = match batch {
        PreparedRecompressBatch::Batch {
            scanned,
            updates,
            next_cursor,
            target_max_id,
        } => {
            let mut update = tx.prepare_cached(
                "UPDATE contents
                 SET payload = ?1, encoding = ?2, logical_bytes = ?3
                 WHERE id = ?4 AND content_sha256 = ?5 AND encoding = 0",
            )?;
            for row in updates {
                let changed = update.execute(params![
                    row.payload,
                    row.encoding,
                    row.logical_bytes,
                    row.id,
                    row.content_sha256,
                ])?;
                if changed == 1 {
                    recompressed += 1;
                    raw_bytes_saved = raw_bytes_saved.saturating_add(row.bytes_saved);
                }
            }
            (scanned, next_cursor, target_max_id)
        }
        PreparedRecompressBatch::Oversized {
            id,
            content_sha256,
            raw_len,
            mut staged,
            next_cursor,
            target_max_id,
        } => {
            if let Some(ref mut sink) = staged {
                let staged_len = i64::try_from(sink.len()).map_err(|_| {
                    StoreError::InvalidTransition("staged seekable blob exceeds i64".into())
                })?;
                let logical_bytes = i64::try_from(raw_len).map_err(|_| {
                    StoreError::InvalidTransition("logical content length exceeds i64".into())
                })?;
                let changed = tx
                    .prepare_cached(
                        "UPDATE contents
                         SET payload = zeroblob(?1), encoding = ?2, logical_bytes = ?3
                         WHERE id = ?4 AND content_sha256 = ?5 AND encoding = 0",
                    )?
                    .execute(params![
                        staged_len,
                        ENCODING_ZSTD_SEEKABLE,
                        logical_bytes,
                        id,
                        &content_sha256,
                    ])?;
                if changed == 1 {
                    let mut blob =
                        tx.blob_open(rusqlite::MAIN_DB, "contents", "payload", id, false)?;
                    let write_res = sink.write_to_blob(&mut blob);
                    let close_res = blob.close();
                    write_res?;
                    close_res?;
                    verify_seekable_blob_digest(&tx, id, raw_len, &content_sha256)?;
                    recompressed = 1;
                    raw_bytes_saved = (raw_len as u64).saturating_sub(sink.len());
                }
            }
            (1, next_cursor, target_max_id)
        }
        PreparedRecompressBatch::Cancelled => unreachable!("handled before opening write tx"),
    };
    tx.prepare_cached(
        "UPDATE content_recompression_state
         SET cursor_id = ?1
         WHERE singleton = 1 AND cursor_id < ?1",
    )?
    .execute([next_cursor])?;
    tx.commit().map_err(StoreError::CommitUnknown)?;
    Ok(RecompressBatchReport {
        scanned,
        recompressed,
        raw_bytes_saved,
        done: next_cursor >= target_max_id,
    })
}

/// Synchronously recompress one bounded batch of legacy raw `contents` rows in place.
///
/// Production Root maintenance calls the split phases so CPU compression executes outside
/// the SQLite writer actor; this wrapper shares the exact same logic for deterministic
/// testing and offline compaction passes.
pub fn recompress_legacy_batch(
    connection: &rusqlite::Connection,
    max_raw_bytes: usize,
) -> Result<RecompressBatchReport, StoreError> {
    let Some(candidates) = fetch_recompress_candidates(connection, max_raw_bytes)? else {
        return Ok(RecompressBatchReport {
            done: true,
            ..Default::default()
        });
    };
    let prepared = match candidates {
        RecompressCandidates::Batch {
            rows,
            next_cursor,
            target_max_id,
        } => compress_candidates(rows, next_cursor, target_max_id)?,
        RecompressCandidates::Oversized {
            id,
            content_sha256,
            raw_len,
            next_cursor,
            target_max_id,
        } => compress_oversized_candidate(
            connection,
            id,
            content_sha256,
            raw_len,
            next_cursor,
            target_max_id,
            None,
        )?,
    };
    apply_recompressed_batch(connection, prepared)
}

#[cfg(test)]
mod dict_corpus;
mod stream;
pub use stream::{
    PreparedStreamBatch, PreparedStreamContent, prepare_stream, put_prepared_stream, put_stream,
};

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::migration::run(&conn, crate::ROOT_MIGRATIONS).unwrap();
        conn
    }

    fn sha256_ref(bytes: &[u8]) -> String {
        format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
    }

    fn reset_seekable_stats() {
        SEEKABLE_STATS.with(|c| c.set(SeekableReadStats::default()));
    }

    fn take_seekable_stats() -> SeekableReadStats {
        SEEKABLE_STATS.with(|c| c.get())
    }

    #[test]
    fn put_encodes_three_tiers_and_skips_incompressible_blobs() {
        let conn = setup_db();

        // 1. Small payload (< 256 B) stays raw
        let small = b"{\"ok\":true}";
        let small_digest = sha256_ref(small);
        let small_id = put(&conn, &small_digest, small).unwrap();
        let (enc, logical): (i64, Option<i64>) = conn
            .query_row(
                "SELECT encoding, logical_bytes FROM contents WHERE id=?",
                [small_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(enc, ENCODING_RAW);
        assert_eq!(logical, None);
        assert_eq!(
            read(&conn, &small_digest).unwrap().as_deref(),
            Some(&small[..])
        );

        // 2a. Small Maka JSON envelope (128 B..=4 KiB) uses ENCODING_ZSTD_DICT_V1
        let small_envelope = br#"{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000001","run":"00000000-0000-4000-8000-000000000002","revision":7,"at":1760000000000,"fact":{"kind":"cell","event":{"kind":"child_admitted","cell":"00000000-0000-4000-8000-000000000003","operation":"00000000-0000-4000-8000-000000000004"}}}"#;
        let env_digest = sha256_ref(small_envelope);
        let env_id = put(&conn, &env_digest, small_envelope).unwrap();
        let (env_enc, env_logical, env_stored): (i64, Option<i64>, i64) = conn
            .query_row(
                "SELECT encoding, logical_bytes, length(payload) FROM contents WHERE id=?",
                [env_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(env_enc, ENCODING_ZSTD_DICT_V1);
        assert_eq!(env_logical, Some(small_envelope.len() as i64));
        assert!(env_stored < small_envelope.len() as i64);
        assert_eq!(
            read(&conn, &env_digest).unwrap().as_deref(),
            Some(&small_envelope[..])
        );
        assert_eq!(
            read_range_by_id(&conn, env_id, 1, 15).unwrap(),
            &small_envelope[1..16]
        );
        let udf_env: String = conn
            .query_row(
                "SELECT json_extract(maka_content_text(payload, encoding), '$.fact.event.kind') FROM contents WHERE id=?",
                [env_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(udf_env, "child_admitted");

        // 2b. Medium compressible payload (> 4 KiB..=64 KiB) uses single-frame ENCODING_ZSTD
        let med_json = format!(
            "{{\"kind\":\"tool_result\",\"lines\":[{}]}}",
            (0..140)
                .map(|i| format!("\"line-{i}: repeated log payload for compression\""))
                .collect::<Vec<_>>()
                .join(",")
        );
        let med_bytes = med_json.as_bytes();
        assert!(med_bytes.len() > DICT_MAX_BYTES && med_bytes.len() <= SEEKABLE_FRAME_BYTES);
        let med_digest = sha256_ref(med_bytes);
        let med_id = put(&conn, &med_digest, med_bytes).unwrap();
        let (enc, logical, stored_len): (i64, Option<i64>, i64) = conn
            .query_row(
                "SELECT encoding, logical_bytes, length(payload) FROM contents WHERE id=?",
                [med_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(enc, ENCODING_ZSTD);
        assert_eq!(logical, Some(med_bytes.len() as i64));
        assert!(stored_len < med_bytes.len() as i64);
        assert_eq!(
            read(&conn, &med_digest).unwrap().as_deref(),
            Some(med_bytes)
        );
        assert_eq!(put(&conn, &med_digest, med_bytes).unwrap(), med_id);

        // 3. Large compressible payload (> 64 KiB) uses ENCODING_ZSTD_SEEKABLE (standard format)
        let mut large = Vec::with_capacity(200 * 1024);
        for i in 0..4000 {
            large.extend_from_slice(
                format!(
                    "{{\"seq\":{i},\"msg\":\"compressible seekable frame record alpha beta\"}}\n"
                )
                .as_bytes(),
            );
        }
        assert!(large.len() > SEEKABLE_FRAME_BYTES * 3);
        let large_digest = sha256_ref(&large);
        let large_id = put(&conn, &large_digest, &large).unwrap();
        let (enc, logical, stored_payload): (i64, Option<i64>, Vec<u8>) = conn
            .query_row(
                "SELECT encoding, logical_bytes, payload FROM contents WHERE id=?",
                [large_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(enc, ENCODING_ZSTD_SEEKABLE);
        assert_eq!(logical, Some(large.len() as i64));
        assert!(stored_payload.len() < large.len());
        assert_eq!(
            read(&conn, &large_digest).unwrap().as_deref(),
            Some(large.as_slice())
        );
        // Standard zstd stream decoder must also decode the seekable blob verbatim.
        let std_decoded = zstd::stream::decode_all(&stored_payload[..]).unwrap();
        assert_eq!(std_decoded, large);

        // 4. Incompressible payloads (> 64 KiB) stay raw
        let mut prng = 0x9e37_79b9_7f4a_7c15_u64;
        let random: Vec<u8> = (0..(SEEKABLE_FRAME_BYTES + 4096))
            .map(|_| {
                prng ^= prng << 13;
                prng ^= prng >> 7;
                prng ^= prng << 17;
                (prng & 0xff) as u8
            })
            .collect();
        let rand_digest = sha256_ref(&random);
        let rand_id = put(&conn, &rand_digest, &random).unwrap();
        let rand_enc: i64 = conn
            .query_row("SELECT encoding FROM contents WHERE id=?", [rand_id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(rand_enc, ENCODING_RAW);
        assert_eq!(
            read(&conn, &rand_digest).unwrap().as_deref(),
            Some(random.as_slice())
        );
    }

    #[test]
    fn sql_udfs_decode_all_three_encodings_and_preserve_json_extract() {
        let conn = setup_db();
        let medium = format!(
            "{{\"kind\":\"cell\",\"event\":{{\"kind\":\"completed\",\"tag\":\"{}\"}}}}",
            "x".repeat(400)
        );
        let large = format!(
            "{{\"kind\":\"cell\",\"event\":{{\"kind\":\"large_seekable\",\"pad\":\"{}\"}}}}",
            "abcd1234".repeat(12_000)
        );
        let med_id = put(&conn, &sha256_ref(medium.as_bytes()), medium.as_bytes()).unwrap();
        let large_id = put(&conn, &sha256_ref(large.as_bytes()), large.as_bytes()).unwrap();

        for (id, expected_kind, expected_text) in [
            (med_id, "completed", &medium),
            (large_id, "large_seekable", &large),
        ] {
            let kind: String = conn
                .query_row(
                    "SELECT json_extract(maka_content_text(payload, encoding), '$.event.kind') FROM contents WHERE id=?",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(kind, expected_kind);

            let raw_bytes: Vec<u8> = conn
                .query_row(
                    "SELECT maka_content_bytes(payload, encoding) FROM contents WHERE id=?",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(raw_bytes, expected_text.as_bytes());
        }

        let null_res: Option<Vec<u8>> = conn
            .query_row("SELECT maka_content_bytes(NULL, 0)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(null_res, None);
    }

    #[test]
    fn seekable_4mib_chunked_reads_keep_decompression_bounded_and_exact() {
        let conn = setup_db();
        let total_len = 4 * 1024 * 1024;
        let mut payload = Vec::with_capacity(total_len);
        let mut idx = 0_u32;
        while payload.len() < total_len {
            let line =
                format!("row={idx:08x};payload=seekable_zstd_chunked_streaming_benchmark;\n");
            payload.extend_from_slice(line.as_bytes());
            idx += 1;
        }
        payload.truncate(total_len);
        let expected_digest = sha256_ref(&payload);
        let id = put(&conn, &expected_digest, &payload).unwrap();

        let (enc, logical, stored_len): (i64, Option<i64>, i64) = conn
            .query_row(
                "SELECT encoding, logical_bytes, length(payload) FROM contents WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(enc, ENCODING_ZSTD_SEEKABLE);
        assert_eq!(logical, Some(total_len as i64));
        assert!(stored_len < (total_len / 2) as i64);

        // Read all 4 MiB in 128 x 32 KiB chunks, reopening ContentReader on every chunk.
        reset_seekable_stats();
        let chunk_size = 32 * 1024_u64;
        let mut reassembled = Vec::with_capacity(total_len);
        for chunk_idx in 0..128_u64 {
            let offset = chunk_idx * chunk_size;
            let chunk = read_range_by_id(&conn, id, offset, chunk_size).unwrap();
            assert_eq!(chunk.len(), chunk_size as usize);
            reassembled.extend_from_slice(&chunk);
        }
        let stats = take_seekable_stats();
        assert_eq!(sha256_ref(&reassembled), expected_digest);
        assert_eq!(reassembled, payload);
        // 128 x 32 KiB aligned reads decompress exactly 1 x 64 KiB frame per call
        // = 8 MiB (2.0x) instead of 128 x 4 MiB = 512 MiB (128x).
        assert_eq!(stats.frames_decompressed, 128);
        assert_eq!(stats.decompressed_bytes, 8 * 1024 * 1024);
        assert_eq!(stats.peak_frame_buf, SEEKABLE_FRAME_BYTES);

        // Unaligned cross-frame read touches only the 2 straddled frames.
        reset_seekable_stats();
        let unaligned_off = (SEEKABLE_FRAME_BYTES as u64) - 100;
        let cross = read_range_by_id(&conn, id, unaligned_off, 250).unwrap();
        assert_eq!(
            cross,
            &payload[unaligned_off as usize..unaligned_off as usize + 250]
        );
        let cross_stats = take_seekable_stats();
        assert_eq!(cross_stats.frames_decompressed, 2);

        let mut reader = open_by_id(&conn, id).unwrap();
        assert_eq!(reader.len(), total_len as u64);
        assert_eq!(
            reader.seek(SeekFrom::End(-64)).unwrap(),
            (total_len - 64) as u64
        );
        let mut tail = [0_u8; 64];
        reader.read_exact(&mut tail).unwrap();
        assert_eq!(&tail[..], &payload[total_len - 64..]);
        assert_eq!(
            reader.seek(SeekFrom::Start(total_len as u64 + 10)).unwrap(),
            total_len as u64 + 10
        );
        assert_eq!(reader.read(&mut tail).unwrap(), 0);
        assert!(reader.seek(SeekFrom::Start(0)).is_ok());
        assert!(reader.seek(SeekFrom::Current(-1)).is_err());
        reader.close().unwrap();
    }

    #[test]
    fn corrupted_seekable_payloads_are_rejected() {
        let mut large = vec![b'A'; SEEKABLE_FRAME_BYTES * 2 + 1024];
        for (i, b) in large.iter_mut().enumerate() {
            *b = b'a' + (i % 26) as u8;
        }
        let encoded = encode(&large).unwrap();
        assert_eq!(encoded.encoding, ENCODING_ZSTD_SEEKABLE);
        let valid = encoded.payload.into_owned();

        let mut bad_magic = valid.clone();
        *bad_magic.last_mut().unwrap() ^= 0xff;
        assert!(decode(bad_magic, ENCODING_ZSTD_SEEKABLE, Some(large.len() as i64)).is_err());

        let mut bad_flags = valid.clone();
        let flags_idx = bad_flags.len() - 5;
        bad_flags[flags_idx] = 0x80;
        assert!(decode(bad_flags, ENCODING_ZSTD_SEEKABLE, Some(large.len() as i64)).is_err());

        assert!(
            decode(
                valid.clone(),
                ENCODING_ZSTD_SEEKABLE,
                Some((large.len() + 1) as i64)
            )
            .is_err()
        );
        assert!(
            decode(
                valid[..10].to_vec(),
                ENCODING_ZSTD_SEEKABLE,
                Some(large.len() as i64)
            )
            .is_err()
        );
    }

    #[test]
    fn content_immutable_trigger_allows_only_shrinking_raw_to_compressed_upgrade() {
        let conn = setup_db();
        let raw_body = "immutable raw blob ".repeat(40);
        let raw_bytes = raw_body.as_bytes();
        let digest = sha256_ref(raw_bytes);
        conn.execute(
            "INSERT INTO contents(content_sha256, payload, encoding, logical_bytes) VALUES(?1, ?2, 0, NULL)",
            params![&digest, raw_bytes],
        )
        .unwrap();
        let id = conn.last_insert_rowid();

        let encoded = encode(raw_bytes).unwrap();
        assert_eq!(encoded.encoding, ENCODING_ZSTD);

        // Mutations to digest, wrong logical_bytes, raw-to-raw, or non-shrinking payload MUST fail.
        assert!(
            conn.execute(
                "UPDATE contents SET content_sha256=?1, payload=?2, encoding=?3, logical_bytes=?4 WHERE id=?5",
                params!["sha256:0000000000000000000000000000000000000000000000000000000000000000", encoded.payload.as_ref(), encoded.encoding, encoded.logical_bytes, id],
            )
            .is_err(),
            "content_immutable must reject changing content_sha256"
        );
        assert!(
            conn.execute(
                "UPDATE contents SET payload=?1, encoding=?2, logical_bytes=?3 WHERE id=?4",
                params![
                    encoded.payload.as_ref(),
                    encoded.encoding,
                    raw_bytes.len() as i64 + 1,
                    id
                ],
            )
            .is_err(),
            "content_immutable must reject mismatched logical_bytes"
        );
        assert!(
            conn.execute(
                "UPDATE contents SET payload=?1 WHERE id=?2",
                params![b"different".as_slice(), id],
            )
            .is_err(),
            "content_immutable must reject raw payload mutation"
        );

        // Forged shorter zstd frame decompressing to DIFFERENT bytes of the same length MUST fail.
        let different_body = "different raw blob ".repeat(40);
        let different_same_len = &different_body.as_bytes()[..raw_bytes.len()];
        let forged_encoded = encode(different_same_len).unwrap();
        assert_eq!(forged_encoded.encoding, ENCODING_ZSTD);
        assert!(forged_encoded.payload.len() < raw_bytes.len());
        assert!(
            conn.execute(
                "UPDATE contents SET payload=?1, encoding=?2, logical_bytes=?3 WHERE id=?4",
                params![
                    forged_encoded.payload.as_ref(),
                    forged_encoded.encoding,
                    raw_bytes.len() as i64,
                    id
                ],
            )
            .is_err(),
            "content_immutable must reject compressed payload decoding to different bytes"
        );
        // NULL encoding / logical_bytes bypass and small-row encoding=2 MUST fail.
        assert!(
            conn.execute(
                "UPDATE contents SET payload=?1, encoding=2, logical_bytes=?2 WHERE id=?3",
                params![forged_encoded.payload.as_ref(), raw_bytes.len() as i64, id],
            )
            .is_err(),
            "content_immutable must reject encoding=2 on <= 64 KiB rows"
        );
        assert!(
            conn.execute(
                "UPDATE contents SET logical_bytes=NULL, encoding=1, payload=?1 WHERE id=?2",
                params![encoded.payload.as_ref(), id],
            )
            .is_err(),
            "content_immutable must reject NULL three-valued trigger bypass"
        );
        // maka_content_text must fail closed on invalid UTF-8 instead of silently replacing bytes.
        let bad_utf8: &[u8] = &[0xff, 0xfe, 0x80];
        let bad_res: Result<String, _> =
            conn.query_row("SELECT maka_content_text(?1, 0)", [bad_utf8], |r| r.get(0));
        assert!(
            bad_res.is_err(),
            "maka_content_text must reject invalid UTF-8"
        );

        // Exact content-preserving encoding upgrade from raw -> compressed succeeds once...
        conn.execute(
            "UPDATE contents SET payload=?1, encoding=?2, logical_bytes=?3 WHERE id=?4",
            params![
                encoded.payload.as_ref(),
                encoded.encoding,
                encoded.logical_bytes,
                id
            ],
        )
        .unwrap();
        assert_eq!(read(&conn, &digest).unwrap().as_deref(), Some(raw_bytes));

        // ...and any further UPDATE on the now-compressed row is permanently rejected!
        assert!(
            conn.execute(
                "UPDATE contents SET payload=?1, encoding=?2, logical_bytes=?3 WHERE id=?4",
                params![b"x".as_slice(), ENCODING_ZSTD, raw_bytes.len() as i64, id],
            )
            .is_err(),
            "content_immutable must reject any second update once compressed"
        );

        // content_encoding_valid trigger rejects every invalid (encoding, logical_bytes) pair on INSERT.
        for (enc, logical, label) in [
            (0_i64, Some(10_i64), "raw with logical_bytes"),
            (1_i64, None, "zstd without logical_bytes"),
            (1_i64, Some(-1_i64), "zstd with negative logical_bytes"),
            (2_i64, None, "seekable without logical_bytes"),
            (3_i64, None, "dict v1 without logical_bytes"),
            (4_i64, Some(10_i64), "unknown encoding"),
        ] {
            assert!(
                conn.execute(
                    "INSERT INTO contents(content_sha256, payload, encoding, logical_bytes) VALUES(?1, ?2, ?3, ?4)",
                    params![format!("sha256:bad-{label}"), b"x".as_slice(), enc, logical],
                )
                .is_err(),
                "content_encoding_valid must reject {label}"
            );
        }
    }

    #[test]
    fn seekable_reader_invalidates_cached_frame_on_mid_frame_error() {
        let conn = setup_db();
        let mut large = vec![0_u8; SEEKABLE_FRAME_BYTES * 2 + 128];
        for (i, b) in large.iter_mut().enumerate() {
            *b = b'a' + (i % 26) as u8;
        }
        let encoded = encode(&large).unwrap();
        assert_eq!(encoded.encoding, ENCODING_ZSTD_SEEKABLE);
        let mut corrupted = encoded.payload.into_owned();
        let table = SeekTable::from_slice(&corrupted, Some(large.len() as u64)).unwrap();
        assert!(table.entries.len() >= 2);
        // Corrupt frame 1 bytes inside the compressed stream while keeping frame 0 & footer valid.
        let f1_start = table.entries[1].comp_offset as usize;
        for byte in &mut corrupted[f1_start..f1_start + 8] {
            *byte ^= 0xff;
        }
        let digest = sha256_ref(&large);
        conn.execute(
            "INSERT INTO contents(content_sha256, payload, encoding, logical_bytes) VALUES(?1, ?2, ?3, ?4)",
            params![&digest, &corrupted, ENCODING_ZSTD_SEEKABLE, large.len() as i64],
        )
        .unwrap();
        let id = conn.last_insert_rowid();

        let mut reader = open_by_id(&conn, id).unwrap();
        // Read frame 0 successfully (populates cached_frame = Some(0)).
        let mut head = [0_u8; 32];
        reader.read_exact(&mut head).unwrap();
        assert_eq!(&head[..], &large[..32]);

        // Seek into corrupted frame 1 (shorter than frame 0 if frame 2, or corrupt frame 1):
        // reading must fail AND clear cached_frame so retrying never reads stale frame_buf or panics.
        reader
            .seek(SeekFrom::Start(SEEKABLE_FRAME_BYTES as u64 + 10))
            .unwrap();
        let mut scratch = [0_u8; 16];
        assert!(reader.read(&mut scratch).is_err());

        // Seeking back to frame 0 must reload frame 0 cleanly (not assume frame 0 stayed intact).
        reader.seek(SeekFrom::Start(0)).unwrap();
        let mut head_again = [0_u8; 32];
        reader.read_exact(&mut head_again).unwrap();
        assert_eq!(&head_again[..], &large[..32]);
        reader.close().unwrap();
    }

    #[test]
    fn put_stream_compresses_tiers_and_falls_back_to_raw() {
        let conn = setup_db();

        // 1. Dedup against existing compressed row.
        let body = "streaming content dedup test ".repeat(30);
        let digest = sha256_ref(body.as_bytes());
        let id1 = put(&conn, &digest, body.as_bytes()).unwrap();
        let id2 = put_stream(&conn, &digest, body.len() as u64, &mut body.as_bytes()).unwrap();
        assert_eq!(id1, id2);

        // 2. Medium compressible stream (<= 64 KiB) compresses to ENCODING_ZSTD.
        let body2 = "streamed compressible content ".repeat(20);
        let digest2 = sha256_ref(body2.as_bytes());
        let id3 = put_stream(&conn, &digest2, body2.len() as u64, &mut body2.as_bytes()).unwrap();
        assert_eq!(
            read(&conn, &digest2).unwrap().as_deref(),
            Some(body2.as_bytes())
        );
        let enc2: i64 = conn
            .query_row("SELECT encoding FROM contents WHERE id=?", [id3], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(enc2, ENCODING_ZSTD);

        // 3. Large compressible stream (> 64 KiB) compresses to ENCODING_ZSTD_SEEKABLE and supports range reads.
        let large: Vec<u8> = (0..4000)
            .flat_map(|i| {
                format!(
                    "streamed-seekable-line-{i:05}-alpha-beta-gamma
"
                )
                .into_bytes()
            })
            .collect();
        assert!(large.len() > SEEKABLE_FRAME_BYTES * 2);
        let large_digest = sha256_ref(&large);
        let large_id =
            put_stream(&conn, &large_digest, large.len() as u64, &mut &large[..]).unwrap();
        let (large_enc, large_logical, large_stored): (i64, Option<i64>, i64) = conn
            .query_row(
                "SELECT encoding, logical_bytes, length(payload) FROM contents WHERE id=?",
                [large_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(large_enc, ENCODING_ZSTD_SEEKABLE);
        assert_eq!(large_logical, Some(large.len() as i64));
        assert!(large_stored < large.len() as i64);
        assert_eq!(
            read(&conn, &large_digest).unwrap().as_deref(),
            Some(large.as_slice())
        );
        let slice =
            read_range_by_id(&conn, large_id, SEEKABLE_FRAME_BYTES as u64 - 50, 120).unwrap();
        assert_eq!(
            slice,
            &large[SEEKABLE_FRAME_BYTES - 50..SEEKABLE_FRAME_BYTES + 70]
        );

        // 4. Large incompressible stream (> 64 KiB) falls back cleanly to ENCODING_RAW.
        let mut prng = 0x1234_5678_9abc_def0_u64;
        let random: Vec<u8> = (0..(SEEKABLE_FRAME_BYTES * 2 + 777))
            .map(|_| {
                prng ^= prng << 13;
                prng ^= prng >> 7;
                prng ^= prng << 17;
                (prng & 0xff) as u8
            })
            .collect();
        let rand_digest = sha256_ref(&random);
        let rand_id =
            put_stream(&conn, &rand_digest, random.len() as u64, &mut &random[..]).unwrap();
        let (rand_enc, rand_logical): (i64, Option<i64>) = conn
            .query_row(
                "SELECT encoding, logical_bytes FROM contents WHERE id=?",
                [rand_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(rand_enc, ENCODING_RAW);
        assert_eq!(rand_logical, None);
        assert_eq!(
            read(&conn, &rand_digest).unwrap().as_deref(),
            Some(random.as_slice())
        );
    }

    #[test]
    fn recompress_legacy_batch_upgrades_pre_v63_rows_and_preserves_digests() {
        let conn = Connection::open_in_memory().unwrap();
        let pre_v63: Vec<_> = crate::ROOT_MIGRATIONS
            .iter()
            .filter(|m| m.version < 63)
            .copied()
            .collect();
        crate::migration::run(&conn, &pre_v63).unwrap();

        let small_env = br#"{"schemaVersion":1,"id":"00000000-0000-4000-8000-000000000010","run":"00000000-0000-4000-8000-000000000011","revision":2,"at":1760000000000,"fact":{"kind":"cell","event":{"kind":"child_admitted","cell":"00000000-0000-4000-8000-000000000012","operation":"00000000-0000-4000-8000-000000000013"}}}"#.to_vec();
        let med_txt = "legacy raw text row for recompression "
            .repeat(60)
            .into_bytes();
        let large_txt: Vec<u8> = (0..3000)
            .flat_map(|i| {
                format!(
                    "legacy-large-row-{i:05}-compressible-bytes
"
                )
                .into_bytes()
            })
            .collect();
        let tiny_raw = br#"{"ok":true}"#.to_vec();

        let corpus = vec![
            (sha256_ref(&small_env), small_env, ENCODING_ZSTD_DICT_V1),
            (sha256_ref(&med_txt), med_txt, ENCODING_ZSTD),
            (sha256_ref(&large_txt), large_txt, ENCODING_ZSTD_SEEKABLE),
            (sha256_ref(&tiny_raw), tiny_raw, ENCODING_RAW),
        ];
        for (digest, bytes, _) in &corpus {
            conn.execute(
                "INSERT INTO contents(content_sha256, payload) VALUES(?1, ?2)",
                params![digest, bytes],
            )
            .unwrap();
        }

        // Apply migration 60: target_max_id captures all 4 legacy rows.
        crate::migration::run(&conn, crate::ROOT_MIGRATIONS).unwrap();
        let (cursor, target): (i64, i64) = conn
            .query_row(
                "SELECT cursor_id, target_max_id FROM content_recompression_state WHERE singleton = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(cursor, 0);
        assert_eq!(target, 4);

        // Drive recompression with a tiny byte budget so it spans multiple batches.
        let mut total_recompressed = 0usize;
        let mut total_saved = 0u64;
        let mut rounds = 0usize;
        loop {
            let report = recompress_legacy_batch(&conn, 1024).unwrap();
            total_recompressed += report.recompressed;
            total_saved += report.raw_bytes_saved;
            rounds += 1;
            if report.done {
                break;
            }
            assert!(
                rounds < 10,
                "recompression must converge in bounded batches"
            );
        }
        assert!(rounds >= 2, "small budget should execute multiple batches");
        assert_eq!(total_recompressed, 3);
        assert!(total_saved > 50_000);

        for (digest, original, expected_enc) in &corpus {
            let decoded = read(&conn, digest).unwrap().unwrap();
            assert_eq!(decoded, *original);
            assert_eq!(sha256_ref(&decoded), *digest);
            let enc: i64 = conn
                .query_row(
                    "SELECT encoding FROM contents WHERE content_sha256=?",
                    [digest],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(enc, *expected_enc);
        }

        // Subsequent call is a clean no-op.
        let noop = recompress_legacy_batch(&conn, RECOMPRESS_DEFAULT_BATCH_BYTES).unwrap();
        assert!(noop.done);
        assert_eq!(noop.scanned, 0);
        assert_eq!(noop.recompressed, 0);
    }

    #[test]
    fn recompress_skips_reused_rowid_with_different_digest_and_same_length() {
        let conn = setup_db();

        // 1. Normal batch ABA test: highest rowid is deleted and reused by a different
        //    raw row with identical byte length between Phase 1 and Phase 3.
        let payload_a = vec![b'A'; 4096];
        let digest_a = sha256_ref(&payload_a);
        conn.execute(
            "INSERT INTO contents(id, content_sha256, payload, encoding, logical_bytes)
             VALUES(10, ?1, ?2, 0, NULL)",
            params![digest_a, payload_a],
        )
        .unwrap();
        conn.execute(
            "UPDATE content_recompression_state SET cursor_id = 0, target_max_id = 10 WHERE singleton = 1",
            [],
        )
        .unwrap();

        let RecompressCandidates::Batch {
            rows,
            next_cursor,
            target_max_id,
        } = fetch_recompress_candidates(&conn, RECOMPRESS_DEFAULT_BATCH_BYTES)
            .unwrap()
            .unwrap()
        else {
            panic!("expected normal batch");
        };
        let prepared = compress_candidates(rows, next_cursor, target_max_id).unwrap();

        // Simulate concurrent delete + reinsert reusing the exact same rowid and byte length.
        let payload_b = vec![b'B'; 4096];
        let digest_b = sha256_ref(&payload_b);
        conn.execute("DELETE FROM contents WHERE id = 10", [])
            .unwrap();
        conn.execute(
            "INSERT INTO contents(id, content_sha256, payload, encoding, logical_bytes)
             VALUES(10, ?1, ?2, 0, NULL)",
            params![digest_b, payload_b],
        )
        .unwrap();

        let report = apply_recompressed_batch(&conn, prepared).unwrap();
        assert_eq!(
            report.recompressed, 0,
            "CAS guard on content_sha256 must skip reused rowid"
        );
        let (stored_digest, stored_enc): (String, i64) = conn
            .query_row(
                "SELECT content_sha256, encoding FROM contents WHERE id = 10",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored_digest, digest_b);
        assert_eq!(stored_enc, ENCODING_RAW);
        assert_eq!(read(&conn, &digest_b).unwrap().unwrap(), payload_b);

        // 2. Oversized streaming ABA test: same rowid + same length replaced between Phase 2 and Phase 3.
        let big_a = vec![b'X'; 150 * 1024];
        let big_digest_a = sha256_ref(&big_a);
        conn.execute(
            "INSERT INTO contents(id, content_sha256, payload, encoding, logical_bytes)
             VALUES(20, ?1, ?2, 0, NULL)",
            params![big_digest_a, big_a],
        )
        .unwrap();
        conn.execute(
            "UPDATE content_recompression_state SET cursor_id = 10, target_max_id = 20 WHERE singleton = 1",
            [],
        )
        .unwrap();
        let RecompressCandidates::Oversized {
            id,
            content_sha256,
            raw_len,
            next_cursor,
            target_max_id,
        } = fetch_recompress_candidates(&conn, 64 * 1024)
            .unwrap()
            .unwrap()
        else {
            panic!("expected oversized candidate");
        };
        let prepared_big = compress_oversized_candidate(
            &conn,
            id,
            content_sha256,
            raw_len,
            next_cursor,
            target_max_id,
            None,
        )
        .unwrap();

        let big_b = vec![b'Y'; 150 * 1024];
        let big_digest_b = sha256_ref(&big_b);
        conn.execute("DELETE FROM contents WHERE id = 20", [])
            .unwrap();
        conn.execute(
            "INSERT INTO contents(id, content_sha256, payload, encoding, logical_bytes)
             VALUES(20, ?1, ?2, 0, NULL)",
            params![big_digest_b, big_b],
        )
        .unwrap();
        let big_report = apply_recompressed_batch(&conn, prepared_big).unwrap();
        assert_eq!(big_report.recompressed, 0);
        assert_eq!(read(&conn, &big_digest_b).unwrap().unwrap(), big_b);
    }

    #[test]
    fn recompress_streams_oversized_raw_row_into_seekable_frames_with_strict_budget() {
        let conn = setup_db();
        let mut big = Vec::with_capacity(200 * 1024);
        for i in 0..4000u32 {
            big.extend_from_slice(format!("line-{i:05}-oversized-payload-data-block\n").as_bytes());
        }
        let big_digest = sha256_ref(&big);
        let small =
            br#"{"schemaVersion":1,"kind":"model_observed","text":"small row after oversized"}"#
                .repeat(8);
        let small_digest = sha256_ref(&small);
        conn.execute(
            "INSERT INTO contents(id, content_sha256, payload, encoding, logical_bytes) VALUES(1, ?1, ?2, 0, NULL)",
            params![big_digest, big],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO contents(id, content_sha256, payload, encoding, logical_bytes) VALUES(2, ?1, ?2, 0, NULL)",
            params![small_digest, small],
        )
        .unwrap();
        conn.execute(
            "UPDATE content_recompression_state SET cursor_id = 0, target_max_id = 2 WHERE singleton = 1",
            [],
        )
        .unwrap();

        // Budget smaller than row 1 triggers streaming Oversized path without loading row 1 into writer RAM.
        let budget = 64 * 1024;
        assert!(matches!(
            fetch_recompress_candidates(&conn, budget).unwrap(),
            Some(RecompressCandidates::Oversized { id: 1, .. })
        ));
        let r1 = recompress_legacy_batch(&conn, budget).unwrap();
        assert_eq!(r1.scanned, 1);
        assert_eq!(r1.recompressed, 1);
        assert!(r1.raw_bytes_saved > 100_000);
        assert!(!r1.done);

        let (enc1, logical1): (i64, Option<i64>) = conn
            .query_row(
                "SELECT encoding, logical_bytes FROM contents WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(enc1, ENCODING_ZSTD_SEEKABLE);
        assert_eq!(logical1, Some(big.len() as i64));
        assert_eq!(read(&conn, &big_digest).unwrap().unwrap(), big);

        // Second batch processes row 2 and finishes.
        let r2 = recompress_legacy_batch(&conn, budget).unwrap();
        assert_eq!(r2.scanned, 1);
        assert_eq!(r2.recompressed, 1);
        assert!(r2.done);
        assert_eq!(read(&conn, &small_digest).unwrap().unwrap(), small);
    }

    #[test]
    fn bundled_dict_v1_is_reproducible_pure_schema_and_effective() {
        let regenerated = dict_corpus::train_dict_v1().unwrap();
        assert_eq!(DICT_V1_BYTES.len(), dict_corpus::DICT_V1_SIZE_BYTES);
        assert_eq!(
            DICT_V1_BYTES,
            regenerated.as_slice(),
            "dict_v1.bin must match deterministic pure-schema generator (run cargo run -p maka-event-log --example gen_content_dict)"
        );
        assert_eq!(
            sha256_ref(DICT_V1_BYTES),
            "sha256:af73066fa688b2ddf5b5b7bfc56777e943b11601a50ebe90c2a6851a342a5c3f"
        );

        // Representative small Maka fact JSON should select ENCODING_ZSTD_DICT_V1 and round-trip.
        let sample = br#"{"schemaVersion":1,"id":"11111111-2222-4333-8444-555555555555","run":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","revision":42,"at":1700000001234,"fact":{"kind":"local_tool_returned","tool":{"attempt":"99999999-8888-4777-8666-555555555555","call":"call_42"},"settlement":"returned","result":{"digest":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","bytes":512},"isError":false,"cellObservation":null}}"#;
        let encoded = encode(sample).unwrap();
        assert_eq!(encoded.encoding, ENCODING_ZSTD_DICT_V1);
        assert!(encoded.payload.len() < sample.len());
        let decoded = decode(
            encoded.payload.into_owned(),
            encoded.encoding,
            encoded.logical_bytes,
        )
        .unwrap();
        assert_eq!(decoded, sample);
    }
}
