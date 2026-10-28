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

//! Length-prefixed JSON frames; payload chunks remain raw bytes.
use crate::application::Result;
use maka_event_log::applications::intents::CallerConfirmation;
use maka_plugin_core::{
    composition::InstanceId,
    deployment::DeploymentRef,
    operation::{OperationReply, RecoveryRef},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::io::Write;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use uuid::Uuid;

/// Observations supplied by the caller adapter, never transport authentication.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub deployment: DeploymentRef,
    pub consumer: InstanceId,
    /// Original mount, captured by the trusted UI adapter rather than action JSON.
    pub mount: Uuid,
    pub request: Uuid,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Open {
    pub endpoint: String,
    pub registration_epoch: Uuid,
    pub source: Source,
    pub method: String,
    pub input: Value,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Control {
    Pull,
    Cancel,
    Commit { intent: Box<CallerConfirmation> },
    Confirm,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Ready,
    Subscribed,
    Prepared {
        reference: Box<RecoveryRef>,
    },
    Item {
        value: Value,
    },
    Finished {
        result: Result<Value>,
        cleanup: Result<()>,
    },
    Progress {
        value: Value,
    },
    Mutation {
        reply: Box<OperationReply>,
        cleanup: Result<()>,
    },
    Aborted {
        reason: String,
        cleanup: Result<()>,
    },
    BindingRetired {
        reason: String,
        cleanup: Result<()>,
    },
}
impl Reply {
    pub fn cleanup(&self) -> Option<&Result<()>> {
        match self {
            Self::Finished { cleanup, .. }
            | Self::Mutation { cleanup, .. }
            | Self::Aborted { cleanup, .. }
            | Self::BindingRetired { cleanup, .. } => Some(cleanup),
            _ => None,
        }
    }
}
struct Bounded(Vec<u8>, usize);
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.1 - self.0.len() {
            return Err(std::io::Error::other(
                "Application frame exceeds byte limit",
            ));
        }
        self.0
            .try_reserve(bytes.len())
            .map_err(std::io::Error::other)?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub async fn write<W: AsyncWrite + Unpin, T: Serialize>(writer: &mut W, value: &T) -> Result<()> {
    write_bounded(writer, value, usize::MAX).await
}
pub async fn write_bounded<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
    limit: usize,
) -> Result<()> {
    let buffer = encode_bounded(value, limit)?;
    let length = u32::try_from(buffer.len()).map_err(|e| e.to_string())?;
    writer.write_u32(length).await.map_err(|e| e.to_string())?;
    writer.write_all(&buffer).await.map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())
}
pub fn encode_bounded<T: Serialize>(value: &T, limit: usize) -> Result<Vec<u8>> {
    let mut buffer = Bounded(Vec::new(), limit.min(u32::MAX as usize));
    serde_json::to_writer(&mut buffer, value).map_err(|e| e.to_string())?;
    Ok(buffer.0)
}
/// Keeps partial prefix/body custody across select cancellation.
pub struct Reader<R> {
    pub inner: BufReader<R>,
    prefix: [u8; 4],
    prefix_read: usize,
    body: Vec<u8>,
}
impl<R: AsyncRead + Unpin> Reader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner: BufReader::new(inner),
            prefix: [0; 4],
            prefix_read: 0,
            body: Vec::new(),
        }
    }
    pub async fn read<T: DeserializeOwned>(&mut self) -> Result<T> {
        self.read_bounded(usize::MAX).await
    }
    pub async fn read_bounded<T: DeserializeOwned>(&mut self, limit: usize) -> Result<T> {
        while self.prefix_read < 4 {
            let n = self
                .inner
                .read(&mut self.prefix[self.prefix_read..])
                .await
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("Application channel ended before a complete frame".into());
            }
            self.prefix_read += n;
        }
        let length = u32::from_be_bytes(self.prefix) as usize;
        if !(1..=limit).contains(&length) {
            return Err("invalid Application frame length".into());
        }
        while self.body.len() < length {
            let bytes = self.inner.fill_buf().await.map_err(|e| e.to_string())?;
            if bytes.is_empty() {
                return Err("Application channel ended before a complete frame".into());
            }
            let count = bytes.len().min(length - self.body.len());
            self.body.try_reserve(count).map_err(|e| e.to_string())?;
            self.body.extend_from_slice(&bytes[..count]);
            self.inner.consume(count);
        }
        let body = std::mem::take(&mut self.body);
        self.prefix_read = 0;
        serde_json::from_slice(&body).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn selected_reads_preserve_partial_prefix_and_body() {
        let (input, mut output) = tokio::io::duplex(64);
        let mut reader = Reader::new(input);
        let body = br#"{"done":true}"#;
        let prefix = (body.len() as u32).to_be_bytes();
        output.write_all(&prefix[..1]).await.unwrap();
        {
            let mut future = Box::pin(reader.read::<Value>());
            assert!(futures_util::poll!(&mut future).is_pending());
        }
        output.write_all(&prefix[1..]).await.unwrap();
        output.write_all(&body[..3]).await.unwrap();
        {
            let mut future = Box::pin(reader.read::<Value>());
            assert!(futures_util::poll!(&mut future).is_pending());
        }
        assert_eq!(reader.body, body[..3]);
        output.write_all(&body[3..]).await.unwrap();
        assert_eq!(
            reader.read::<Value>().await.unwrap(),
            serde_json::json!({"done":true})
        );
        output.write_all(&prefix).await.unwrap();
        output.write_all(&body[..3]).await.unwrap();
        drop(output);
        assert_eq!(
            reader.read::<Value>().await.unwrap_err(),
            "Application channel ended before a complete frame"
        );
        assert_eq!(reader.body, body[..3]);
    }
    #[tokio::test]
    async fn explicit_frame_bound_rejects_before_writing_a_prefix() {
        let mut output = Vec::new();
        assert!(
            write_bounded(&mut output, &"long original value", 16)
                .await
                .is_err()
        );
        assert!(output.is_empty());
        write_bounded(&mut output, &serde_json::json!({"ok": true}), 16)
            .await
            .unwrap();
        let mut reader = Reader::new(output.as_slice());
        assert!(reader.read_bounded::<Value>(4).await.is_err());
        assert_eq!(
            reader.read_bounded::<Value>(16).await.unwrap(),
            serde_json::json!({"ok": true})
        );
    }
    #[tokio::test]
    async fn sequential_frames_preserve_complete_large_values() {
        let original = serde_json::json!({
            "text": "中🙂\"\\\n\0".repeat(160_000),
            "tail": "原始末尾",
        });
        assert!(serde_json::to_vec(&original).unwrap().len() > 2 * 1024 * 1024);
        let (mut output, input) = tokio::io::duplex(64 * 1024);
        let mut reader = Reader::new(input);
        let sent = original.clone();
        let writer = tokio::spawn(async move {
            write(&mut output, &sent).await?;
            write(&mut output, &serde_json::json!({"next": true})).await
        });
        let first = reader.read::<Value>().await;
        let second = reader.read::<Value>().await;
        let written = writer.await.unwrap();
        assert!(written.is_ok(), "complete frame write failed: {written:?}");
        assert!(first.unwrap() == original, "complete frame value changed");
        assert_eq!(second.unwrap(), serde_json::json!({"next": true}));
    }
}
