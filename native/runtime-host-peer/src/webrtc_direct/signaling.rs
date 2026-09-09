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

use std::io;

use futures::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use prost::Message as _;

const MAX_SIGNAL_FRAME_BYTES: usize = 64 * 1024;
const MAX_SDP_BYTES: usize = 48 * 1024;
const MAX_CANDIDATE_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Signal {
    Offer(String),
    Answer(String),
    IceCandidate(String),
}

impl Signal {
    fn into_wire(self) -> Result<WireMessage, SignalingError> {
        let (kind, data, limit) = match self {
            Self::Offer(data) => (WireType::SdpOffer, data, MAX_SDP_BYTES),
            Self::Answer(data) => (WireType::SdpAnswer, data, MAX_SDP_BYTES),
            Self::IceCandidate(data) => (WireType::IceCandidate, data, MAX_CANDIDATE_BYTES),
        };
        if data.len() > limit {
            return Err(SignalingError::PayloadTooLarge {
                actual: data.len(),
                limit,
            });
        }
        Ok(WireMessage {
            kind: Some(kind as i32),
            data: Some(data),
        })
    }

    fn from_wire(message: WireMessage) -> Result<Self, SignalingError> {
        let kind = message
            .kind
            .and_then(|kind| WireType::try_from(kind).ok())
            .ok_or(SignalingError::MissingOrInvalidType)?;
        let data = message.data.ok_or(SignalingError::MissingData)?;
        match kind {
            WireType::SdpOffer if data.len() <= MAX_SDP_BYTES => Ok(Self::Offer(data)),
            WireType::SdpAnswer if data.len() <= MAX_SDP_BYTES => Ok(Self::Answer(data)),
            WireType::IceCandidate if data.len() <= MAX_CANDIDATE_BYTES => {
                Ok(Self::IceCandidate(data))
            }
            WireType::SdpOffer | WireType::SdpAnswer => Err(SignalingError::PayloadTooLarge {
                actual: data.len(),
                limit: MAX_SDP_BYTES,
            }),
            WireType::IceCandidate => Err(SignalingError::PayloadTooLarge {
                actual: data.len(),
                limit: MAX_CANDIDATE_BYTES,
            }),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SignalingError {
    #[error("signaling I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("signaling protobuf was invalid: {0}")]
    Protobuf(#[from] prost::DecodeError),
    #[error("signaling frame length was invalid")]
    InvalidFrameLength,
    #[error("signaling frame is {actual} bytes; limit is {limit}")]
    FrameTooLarge { actual: usize, limit: usize },
    #[error("signaling payload is {actual} bytes; limit is {limit}")]
    PayloadTooLarge { actual: usize, limit: usize },
    #[error("signaling message has no valid type")]
    MissingOrInvalidType,
    #[error("signaling message has no data")]
    MissingData,
}

pub async fn write_signal<W>(writer: &mut W, signal: Signal) -> Result<(), SignalingError>
where
    W: AsyncWrite + Unpin,
{
    let message = signal.into_wire()?;
    let mut payload = Vec::with_capacity(message.encoded_len());
    message
        .encode(&mut payload)
        .expect("encoding protobuf into Vec cannot fail");
    if payload.len() > MAX_SIGNAL_FRAME_BYTES {
        return Err(SignalingError::FrameTooLarge {
            actual: payload.len(),
            limit: MAX_SIGNAL_FRAME_BYTES,
        });
    }
    frame_diagnostic("write", &payload);

    let mut prefix = unsigned_varint::encode::usize_buffer();
    let prefix = unsigned_varint::encode::usize(payload.len(), &mut prefix);
    let mut frame = Vec::with_capacity(prefix.len() + payload.len());
    frame.extend_from_slice(prefix);
    frame.extend_from_slice(&payload);
    writer.write_all(&frame).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn read_signal<R>(reader: &mut R) -> Result<Option<Signal>, SignalingError>
where
    R: AsyncRead + Unpin,
{
    let Some(length) = read_frame_length(reader).await? else {
        return Ok(None);
    };
    if length > MAX_SIGNAL_FRAME_BYTES {
        return Err(SignalingError::FrameTooLarge {
            actual: length,
            limit: MAX_SIGNAL_FRAME_BYTES,
        });
    }

    let mut payload = vec![0; length];
    reader.read_exact(&mut payload).await?;
    frame_diagnostic("read", &payload);
    Signal::from_wire(WireMessage::decode(payload.as_slice())?).map(Some)
}

fn frame_diagnostic(direction: &str, payload: &[u8]) {
    if std::env::var_os("MAKA_WEBRTC_DIAGNOSTICS").is_none() {
        return;
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "signaling": direction,
            "bytes": payload.len(),
            "firstTag": payload.first(),
        })
    );
}

async fn read_frame_length<R>(reader: &mut R) -> Result<Option<usize>, SignalingError>
where
    R: AsyncRead + Unpin,
{
    let mut prefix = unsigned_varint::encode::usize_buffer();
    for index in 0..prefix.len() {
        match reader.read_exact(&mut prefix[index..=index]).await {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof && index == 0 => {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        }
        if unsigned_varint::decode::is_last(prefix[index]) {
            let (length, remainder) = unsigned_varint::decode::usize(&prefix[..=index])
                .map_err(|_| SignalingError::InvalidFrameLength)?;
            if !remainder.is_empty() {
                return Err(SignalingError::InvalidFrameLength);
            }
            return Ok(Some(length));
        }
    }
    Err(SignalingError::InvalidFrameLength)
}

#[derive(Clone, PartialEq, prost::Message)]
struct WireMessage {
    #[prost(enumeration = "WireType", optional, tag = "1")]
    kind: Option<i32>,
    #[prost(string, optional, tag = "2")]
    data: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, prost::Enumeration)]
enum WireType {
    SdpOffer = 0,
    SdpAnswer = 1,
    IceCandidate = 2,
}

#[cfg(test)]
mod tests {
    use futures::io::Cursor;

    use super::*;

    #[tokio::test]
    async fn standard_signal_round_trip_and_bounds() {
        let mut bytes = Cursor::new(Vec::new());
        write_signal(&mut bytes, Signal::Offer("v=0".to_owned()))
            .await
            .unwrap();
        bytes.set_position(0);
        assert_eq!(
            read_signal(&mut bytes).await.unwrap(),
            Some(Signal::Offer("v=0".to_owned()))
        );
        assert_eq!(read_signal(&mut bytes).await.unwrap(), None);

        let error = write_signal(
            &mut Cursor::new(Vec::new()),
            Signal::IceCandidate("x".repeat(MAX_CANDIDATE_BYTES + 1)),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, SignalingError::PayloadTooLarge { .. }));
    }
}
