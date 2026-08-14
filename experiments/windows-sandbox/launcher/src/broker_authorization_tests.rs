#[cfg(test)]
mod tests {
    use crate::broker_authorization::{BrokerAuthorizationError, BrokerAuthorizer};
    use crate::protocol::BrokerLaunchRequest;

    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn request(nonce: &str) -> BrokerLaunchRequest {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "requestId": "broker-1",
            "clientPid": 42,
            "clientNonce": nonce,
            "profileDigest": DIGEST,
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
        }))
        .expect("valid request")
    }

    #[test]
    fn binds_authorization_to_connected_client_pid() {
        let mut authorizer = BrokerAuthorizer::new([DIGEST.to_owned()]);
        assert_eq!(
            authorizer.authorize(&request("0123456789abcdef0123456789abcdef"), 43),
            Err(BrokerAuthorizationError::ClientPidMismatch)
        );
    }

    #[test]
    fn rejects_unapproved_profile_without_consuming_nonce() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let mut authorizer = BrokerAuthorizer::new([]);
        assert_eq!(
            authorizer.authorize(&request(nonce), 42),
            Err(BrokerAuthorizationError::ProfileNotApproved)
        );
        authorizer = BrokerAuthorizer::new([DIGEST.to_owned()]);
        assert_eq!(authorizer.authorize(&request(nonce), 42), Ok(()));
    }

    #[test]
    fn rejects_replayed_nonce_after_successful_authorization() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let mut authorizer = BrokerAuthorizer::new([DIGEST.to_owned()]);
        assert_eq!(authorizer.authorize(&request(nonce), 42), Ok(()));
        assert_eq!(
            authorizer.authorize(&request(nonce), 42),
            Err(BrokerAuthorizationError::NonceReplayed)
        );
    }
}
