#[cfg(test)]
mod tests {
    use super::super::protocol::BrokerLaunchRequest;

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
}
