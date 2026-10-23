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

//! Native transport validation for a current file. No filesystem reads or resource cache.
use super::Owner;
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use maka_agent_api::contract::{FileContent, FileRead, FileReadPart, WorkspacePath};
use maka_agent_facts::artifact::content_digest;
use maka_app_client::{Subscription, SubscriptionEvent};
use nsh_core::{JsonValue, ui::prelude::*};
use serde_json::json;

pub(super) const PREFIX: &str = "asset:/workspace-file/";

pub(super) struct Capture {
    version: String,
    digest: String,
    total: u64,
    pub(super) content: FileContent,
    pub(super) bytes: Vec<u8>,
}
pub(super) enum Outcome {
    Ready(Capture),
    Unavailable(FileReadPart),
}

/// One immutable, verified file capture; line text is materialized only for readers.
#[class(interface)]
pub struct CapturedFile {
    metadata: JsonValue,
    text: Option<TextSource>,
}

struct TextSource {
    text: String,
    starts: Vec<usize>,
}

/// One original source line, including its original line ending.
#[derive(Debug, Clone, JsObject)]
pub struct FileLine {
    /// Byte offset in the verified UTF-8 source.
    pub offset: usize,
    /// One-based source line number.
    pub line: usize,
    /// Original text; soft wrapping belongs to the native Text engine.
    pub text: String,
}

#[class]
impl CapturedFile {
    /// The original capture outcome, version, digest and byte count.
    pub fn metadata(&self) -> JsonValue {
        self.metadata.clone()
    }

    /// Number of natural source lines; an empty text file has one empty line.
    #[getter]
    pub fn length(&self) -> usize {
        self.text.as_ref().map_or(0, |source| source.starts.len())
    }

    /// Read one natural source line from this capture, without a new filesystem read.
    pub fn at(&self, index: usize) -> Result<FileLine, String> {
        let source = self.text.as_ref().ok_or("The capture is not text")?;
        let start = *source
            .starts
            .get(index)
            .ok_or("Source line is out of range")?;
        let end = source
            .starts
            .get(index + 1)
            .copied()
            .unwrap_or(source.text.len());
        Ok(FileLine {
            offset: start,
            line: index + 1,
            text: source.text[start..end].to_owned(),
        })
    }

    /// Complete original text for an explicit copy; readers do not retain a second full source.
    pub fn original_text(&self) -> Result<String, String> {
        self.text
            .as_ref()
            .map(|source| source.text.clone())
            .ok_or_else(|| "The capture is not text".into())
    }
}

pub(super) fn path_label(path: &WorkspacePath) -> Result<String, String> {
    let bytes = STANDARD
        .decode(&path.bytes_base64)
        .map_err(|_| "Invalid workspace path")?;
    Ok(String::from_utf8_lossy(&bytes)
        .chars()
        .map(|ch| if ch.is_control() { '�' } else { ch })
        .collect())
}

pub(super) async fn read(owner: &Owner, source: &FileRead) -> Result<Outcome, String> {
    let subscription = owner
        .client
        .subscribe(
            "agent",
            "readFile",
            serde_json::to_value(source).map_err(|_| "Invalid file selector")?,
        )
        .await?;
    collect(&subscription, source).await
}

pub(super) async fn collect(
    subscription: &Subscription,
    source: &FileRead,
) -> Result<Outcome, String> {
    let result = collect_inner(subscription, source).await;
    // This is the original request even on malformed/truncated streams. Dropping
    // an Arc is not cleanup, and a received End does not replace final settlement.
    let closed = subscription.close().await;
    closed?;
    result
}

async fn collect_inner(subscription: &Subscription, source: &FileRead) -> Result<Outcome, String> {
    let invalid = || "The current file stream could not be verified".to_owned();
    let mut capture: Option<Capture> = None;
    let mut unavailable = None;
    let mut ended = false;
    loop {
        match subscription.next().await? {
            Some(SubscriptionEvent::Finished(value)) => {
                if !value.is_null() {
                    return Err(invalid());
                }
                if let Some(status) = unavailable {
                    return Ok(Outcome::Unavailable(status));
                }
                let capture = capture.filter(|_| ended).ok_or_else(invalid)?;
                return tokio::task::spawn_blocking(move || {
                    if content_digest(&capture.bytes) != capture.digest {
                        return Err("The current file digest does not match".into());
                    }
                    Ok(Outcome::Ready(capture))
                })
                .await
                .map_err(|_| "Current file verification worker failed")?;
            }
            Some(SubscriptionEvent::Item(value)) => {
                let part: FileReadPart = serde_json::from_value(value).map_err(|_| invalid())?;
                if ended || unavailable.is_some() {
                    return Err(invalid());
                }
                match part {
                    FileReadPart::Begin {
                        version,
                        digest,
                        bytes,
                        content,
                    } if capture.is_none() => {
                        if !is_digest(&version)
                            || !is_digest(&digest)
                            || source
                                .expected_version
                                .as_ref()
                                .is_some_and(|expected| expected != &version)
                            || matches!(&content, FileContent::Image { mime_type } if !matches!(mime_type.as_str(), "image/png"|"image/jpeg"|"image/gif"|"image/webp"))
                        {
                            return Err(invalid());
                        }
                        let mut data = Vec::new();
                        data.try_reserve_exact(usize::try_from(bytes).map_err(|_| invalid())?)
                            .map_err(|_| invalid())?;
                        capture = Some(Capture {
                            version,
                            digest,
                            total: bytes,
                            content,
                            bytes: data,
                        });
                    }
                    FileReadPart::Chunk { offset, data } => {
                        let capture = capture.as_mut().ok_or_else(invalid)?;
                        if offset != capture.bytes.len() as u64 || data.len() > 43692 {
                            return Err(invalid());
                        }
                        let chunk = STANDARD.decode(&data).map_err(|_| invalid())?;
                        if chunk.is_empty()
                            || chunk.len() > 32 * 1024
                            || offset + chunk.len() as u64 > capture.total
                            || matches!(capture.content, FileContent::Text)
                                && std::str::from_utf8(&chunk).is_err()
                        {
                            return Err(invalid());
                        }
                        capture.bytes.extend(chunk);
                    }
                    FileReadPart::End {
                        version,
                        digest,
                        bytes,
                    } => {
                        let capture = capture.as_ref().ok_or_else(invalid)?;
                        if capture.version != version
                            || capture.digest != digest
                            || capture.total != bytes
                            || capture.bytes.len() as u64 != bytes
                        {
                            return Err(invalid());
                        }
                        ended = true;
                    }
                    status @ (FileReadPart::Absent
                    | FileReadPart::Changed
                    | FileReadPart::Binary { .. }
                    | FileReadPart::Unsupported { .. })
                        if capture.is_none() =>
                    {
                        unavailable = Some(status)
                    }
                    _ => return Err(invalid()),
                }
            }
            None => return Err(invalid()),
        }
    }
}

fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
    })
}

pub(super) fn presentation(outcome: Outcome, mut source: FileRead) -> Result<CapturedFile, String> {
    let capture = match outcome {
        Outcome::Unavailable(status) => {
            return Ok(CapturedFile {
                metadata: serde_json::to_value(status).map_err(|_| "Invalid file outcome")?,
                text: None,
            });
        }
        Outcome::Ready(value) => value,
    };
    match capture.content {
        FileContent::Image { mime_type } => {
            source.expected_version = Some(capture.version.clone());
            let encoded = URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&source).map_err(|_| "Invalid file selector")?);
            Ok(CapturedFile {
                metadata: json!({"kind":"image","uri":format!("{PREFIX}{encoded}"),"version":capture.version,"digest":capture.digest,"bytes":capture.total,"mimeType":mime_type}),
                text: None,
            })
        }
        FileContent::Text => {
            // Move the verified allocation; no second full text or per-line DTO array.
            let text = String::from_utf8(capture.bytes).map_err(|_| "Current file is not UTF-8")?;
            let starts = std::iter::once(0)
                .chain(text.match_indices('\n').filter_map(|(offset, _)| {
                    let next = offset + 1;
                    (next < text.len()).then_some(next)
                }))
                .collect();
            Ok(CapturedFile {
                metadata: json!({"kind":"text","version":capture.version,"digest":capture.digest,"bytes":capture.total}),
                text: Some(TextSource { text, starts }),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_text_keeps_original_lines_and_bytes_without_splitting_graphemes() {
        let source = FileRead {
            session_id: "original-session".into(),
            path: WorkspacePath {
                bytes_base64: STANDARD.encode(b"preview.txt"),
            },
            expected_version: None,
        };
        for text in [
            String::new(),
            "\n".repeat(2 * 1024 * 1024),
            "first\r\n\t中文 😀\r\nlast".into(),
            format!("{}e\u{301}{}\nnext\n", "a".repeat(255), "中😀".repeat(400)),
        ] {
            let view = presentation(
                Outcome::Ready(Capture {
                    version: "version".into(),
                    digest: "digest".into(),
                    total: text.len() as u64,
                    content: FileContent::Text,
                    bytes: text.as_bytes().to_vec(),
                }),
                source.clone(),
            )
            .unwrap();
            assert_eq!(view.metadata()["version"], "version");
            assert_eq!(view.metadata()["digest"], "digest");
            assert_eq!(view.metadata()["bytes"], text.len());
            let mut reconstructed = String::with_capacity(text.len());
            let mut lines = 0;
            for (index, original) in text
                .split_inclusive('\n')
                .chain(text.is_empty().then_some(""))
                .enumerate()
            {
                let row = view.at(index).unwrap();
                assert_eq!(row.offset, reconstructed.len());
                assert_eq!(row.line, index + 1);
                assert_eq!(row.text, original);
                reconstructed.push_str(&row.text);
                lines += 1;
            }
            assert_eq!(view.length(), lines);
            assert!(view.at(lines).is_err());
            assert_eq!(reconstructed, text);
            assert_eq!(view.original_text().unwrap(), text);
        }
    }
}
