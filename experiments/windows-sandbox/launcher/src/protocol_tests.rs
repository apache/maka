#[cfg(test)]
mod tests {
    use super::super::protocol::{BrokerLaunchRequest, launch_digest};

    fn request() -> BrokerLaunchRequest {
        serde_json::from_str(
            r#"{
              "version": 1,
              "requestId": "broker-1",
              "clientPid": 42,
              "clientNonce": "0123456789abcdef0123456789abcdef",
              "profileDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              "launch": {
                "version": 1,
                "requestId": "launch-1",
                "executable": "C:\\Windows\\System32\\cmd.exe",
                "arguments": ["/d", "/c", "exit 0"],
                "cwd": "C:\\Windows",
                "readRoots": [],
                "writeRoots": [],
                "network": "enabled",
                "environment": {}
              }
            }"#,
        )
        .expect("valid broker request")
    }

    #[test]
    fn accepts_valid_authorized_request_shape() {
        assert!(request().validate().is_ok());
    }

    #[test]
    fn rejects_invalid_nonce_before_launch() {
        let mut value = request();
        value.client_nonce = "short".to_owned();
        assert_eq!(
            value.validate().unwrap_err(),
            "clientNonce must be 32 hexadecimal characters"
        );
    }

    #[test]
    fn rejects_invalid_profile_digest_before_launch() {
        let mut value = request();
        value.profile_digest = "not-a-digest".to_owned();
        assert_eq!(
            value.validate().unwrap_err(),
            "profileDigest must be 64 hexadecimal characters"
        );
    }

    #[test]
    fn launch_digest_is_unchanged_for_manifests_without_timeout() {
        // timeoutMs is optional and skipped when absent, so a pre-timeout
        // manifest must produce the exact digest it produced before the field
        // existed — otherwise old manifests hit profile_digest_mismatch.
        let value = request();
        assert!(value.launch.timeout_ms.is_none());
        let serialized = serde_json::to_string(&value.launch).expect("serialize launch");
        assert!(!serialized.contains("timeoutMs"));
        let reparsed = serde_json::from_str::<super::super::protocol::LaunchRequest>(&serialized)
            .expect("reparse launch");
        assert_eq!(
            launch_digest(&value.launch).expect("digest"),
            launch_digest(&reparsed).expect("digest"),
        );
    }

    #[test]
    fn accepts_timeout_within_bounds_and_rejects_outside() {
        let mut value = request();
        value.launch.timeout_ms = Some(130_000);
        assert!(value.validate().is_ok());
        value.launch.timeout_ms = Some(999);
        assert_eq!(
            value.validate().unwrap_err(),
            "timeoutMs must be between 1000 and 600000"
        );
        value.launch.timeout_ms = Some(600_001);
        assert!(value.validate().is_err());
    }
}
