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
    fn rejects_request_ids_that_cannot_safely_name_lifecycle_artifacts() {
        for request_id in ["contains:stream", "contains/slash", "contains space"] {
            let mut value = request();
            value.launch.request_id = request_id.to_owned();
            assert_eq!(
                value.validate().unwrap_err(),
                "requestId must use 1-128 safe ASCII characters"
            );
        }
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
    fn accepts_real_windows_env_names_and_rejects_block_breaking_ones() {
        // `CommonProgramFiles(x86)` is a standard Windows variable; the
        // launcher must not reject legitimate names that contain parentheses.
        let mut value = request();
        value.launch.environment.insert(
            "CommonProgramFiles(x86)".to_owned(),
            "C:\\Program Files (x86)\\Common Files".to_owned(),
        );
        assert!(value.validate().is_ok());

        for bad_name in ["A=B", "=C:", "BAD\u{0}NAME", ""] {
            let mut invalid = request();
            invalid
                .launch
                .environment
                .insert(bad_name.to_owned(), "value".to_owned());
            assert!(
                invalid.validate().is_err(),
                "expected env name {bad_name:?} to be rejected"
            );
        }

        let mut nul_value = request();
        nul_value
            .launch
            .environment
            .insert("GOOD_NAME".to_owned(), "has\u{0}nul".to_owned());
        assert_eq!(
            nul_value.validate().unwrap_err(),
            "invalid environment value for GOOD_NAME"
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
