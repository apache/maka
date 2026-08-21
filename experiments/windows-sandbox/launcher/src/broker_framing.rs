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
