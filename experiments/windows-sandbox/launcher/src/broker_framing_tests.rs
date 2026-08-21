#[cfg(test)]
mod tests {
    use crate::broker_framing::{
        BrokerFrameError, MAX_BROKER_MESSAGE_BYTES, decode_frame, encode_frame,
    };

    #[test]
    fn round_trips_bounded_payload() {
        let frame = encode_frame(br#"{"version":1}"#).expect("encode frame");
        assert_eq!(decode_frame(&frame), Ok(br#"{"version":1}"#.as_slice()));
    }

    #[test]
    fn rejects_oversized_payload_before_allocation() {
        let payload = vec![0; MAX_BROKER_MESSAGE_BYTES + 1];
        assert_eq!(
            encode_frame(&payload),
            Err(BrokerFrameError::PayloadTooLarge)
        );

        let declared = (MAX_BROKER_MESSAGE_BYTES as u32 + 1).to_le_bytes();
        assert_eq!(
            decode_frame(&declared),
            Err(BrokerFrameError::PayloadTooLarge)
        );
    }

    #[test]
    fn rejects_truncated_and_ambiguous_frames() {
        assert_eq!(
            decode_frame(&[1, 0]),
            Err(BrokerFrameError::TruncatedPrefix)
        );
        assert_eq!(
            decode_frame(&[4, 0, 0, 0, 1, 2]),
            Err(BrokerFrameError::TruncatedPayload)
        );
        assert_eq!(
            decode_frame(&[1, 0, 0, 0, 1, 2]),
            Err(BrokerFrameError::TrailingBytes)
        );
    }
}
