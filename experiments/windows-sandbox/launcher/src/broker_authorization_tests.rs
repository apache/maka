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

#[cfg(test)]
mod tests {
    use crate::broker_authorization::{BrokerAuthorizationError, BrokerAuthorizer};
    use crate::protocol::{BrokerLaunchRequest, launch_digest};

    fn request(nonce: &str) -> BrokerLaunchRequest {
        let mut request: BrokerLaunchRequest = serde_json::from_value(serde_json::json!({
            "version": 1,
            "requestId": "broker-1",
            "clientPid": 42,
            "clientNonce": nonce,
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
        }))
        .expect("valid request");
        request.profile_digest = launch_digest(&request.launch).expect("launch digest");
        request
    }

    #[test]
    fn binds_authorization_to_connected_client_pid() {
        let value = request("0123456789abcdef0123456789abcdef");
        let mut authorizer = BrokerAuthorizer::new([value.profile_digest.clone()]);
        assert_eq!(
            authorizer.authorize(&value, 43),
            Err(BrokerAuthorizationError::ClientPidMismatch)
        );
    }

    #[test]
    fn rejects_unapproved_profile_without_consuming_nonce() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let value = request(nonce);
        let mut authorizer = BrokerAuthorizer::new([]);
        assert_eq!(
            authorizer.authorize(&value, 42),
            Err(BrokerAuthorizationError::ProfileNotApproved)
        );
        authorizer = BrokerAuthorizer::new([value.profile_digest.clone()]);
        assert_eq!(authorizer.authorize(&value, 42), Ok(()));
    }

    #[test]
    fn rejects_replayed_nonce_after_successful_authorization() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let value = request(nonce);
        let mut authorizer = BrokerAuthorizer::new([value.profile_digest.clone()]);
        assert_eq!(authorizer.authorize(&value, 42), Ok(()));
        assert_eq!(
            authorizer.authorize(&value, 42),
            Err(BrokerAuthorizationError::NonceReplayed)
        );
    }

    #[test]
    fn rejects_replayed_nonce_with_different_hex_case() {
        let value = request("0123456789abcdef0123456789abcdef");
        let mut variant = value.clone();
        variant.client_nonce = "0123456789ABCDEF0123456789ABCDEF".to_owned();
        let mut authorizer = BrokerAuthorizer::new([value.profile_digest.clone()]);
        assert_eq!(authorizer.authorize(&value, 42), Ok(()));
        assert_eq!(
            authorizer.authorize(&variant, 42),
            Err(BrokerAuthorizationError::NonceReplayed)
        );
    }

    #[test]
    fn rejects_a_digest_that_is_not_bound_to_the_launch_policy() {
        let mut value = request("0123456789abcdef0123456789abcdef");
        let approved = value.profile_digest.clone();
        value.launch.arguments.push("tampered".to_owned());
        let mut authorizer = BrokerAuthorizer::new([approved]);
        assert_eq!(
            authorizer.authorize(&value, 42),
            Err(BrokerAuthorizationError::ProfileDigestMismatch)
        );
    }
}
