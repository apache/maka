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

pub const MAX_BROKER_MESSAGE_BYTES: usize = 64 * 1024;
const LENGTH_PREFIX_BYTES: usize = size_of::<u32>();

pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, BrokerFrameError> {
    if payload.is_empty() {
        return Err(BrokerFrameError::EmptyPayload);
    }
    if payload.len() > MAX_BROKER_MESSAGE_BYTES {
        return Err(BrokerFrameError::PayloadTooLarge);
    }
    let length = u32::try_from(payload.len()).map_err(|_| BrokerFrameError::PayloadTooLarge)?;
    let mut frame = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload.len());
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn decode_frame(frame: &[u8]) -> Result<&[u8], BrokerFrameError> {
    if frame.len() < LENGTH_PREFIX_BYTES {
        return Err(BrokerFrameError::TruncatedPrefix);
    }
    let length = u32::from_le_bytes(
        frame[..LENGTH_PREFIX_BYTES]
            .try_into()
            .expect("length prefix has fixed width"),
    ) as usize;
    if length == 0 {
        return Err(BrokerFrameError::EmptyPayload);
    }
    if length > MAX_BROKER_MESSAGE_BYTES {
        return Err(BrokerFrameError::PayloadTooLarge);
    }
    let expected = LENGTH_PREFIX_BYTES + length;
    if frame.len() < expected {
        return Err(BrokerFrameError::TruncatedPayload);
    }
    if frame.len() > expected {
        return Err(BrokerFrameError::TrailingBytes);
    }
    Ok(&frame[LENGTH_PREFIX_BYTES..expected])
}

#[derive(Debug, Eq, PartialEq)]
pub enum BrokerFrameError {
    EmptyPayload,
    PayloadTooLarge,
    TruncatedPrefix,
    TruncatedPayload,
    TrailingBytes,
}
