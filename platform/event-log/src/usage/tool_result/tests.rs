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

use super::*;

#[test]
fn stored_settlements_keep_fractional_timing_and_status() {
    for (token, expected) in [
        ("0", 0.0_f64),
        ("-0.0", -0.0),
        ("0.7500", 0.75),
        ("7.5e-1", 0.75),
        ("9007199254740993", 9_007_199_254_740_992.0),
    ] {
        for (status, expected_status) in [
            ("success", ToolStatus::Success),
            ("error", ToolStatus::Error),
            ("unknown", ToolStatus::Unknown),
        ] {
            for text in [
                format!(r#"{{"kind":"settled","startedAt":{token},"outcome":"{status}"}}"#),
                format!(r#"{{"outcome":"{status}","startedAt":{token},"kind":"settled"}}"#),
            ] {
                let ToolResult::Settled {
                    started_at,
                    outcome,
                } = decode(&text).unwrap()
                else {
                    panic!("settled result")
                };
                assert_eq!(started_at.to_bits(), expected.to_bits(), "{text}");
                assert_eq!(outcome, expected_status);
                let encoded = serde_json::to_string(&ToolResult::Settled {
                    started_at,
                    outcome,
                })
                .unwrap();
                assert_eq!(
                    decode(&encoded).unwrap(),
                    ToolResult::Settled {
                        started_at,
                        outcome
                    }
                );
            }
        }
    }
}

#[test]
fn stored_results_preserve_variant_specific_ignored_fields() {
    for reason in [
        "unavailable",
        "invalid_input",
        "policy_denied",
        "preparation_failed",
        "exclusive_conflict",
        "cancelled",
    ] {
        let text = format!(
            r#"{{"kind":"rejected","reason":"{reason}","startedAt":null,"startedAt":{{"not":"a timestamp"}},"outcome":false,"foreign":[]}}"#
        );
        let result = decode(&text).unwrap();
        // Rejected has no numeric payload, so this comparison is feature-independent.
        assert_eq!(result, serde_json::from_str::<ToolResult>(&text).unwrap());
        assert_eq!(
            decode(&serde_json::to_string(&result).unwrap()).unwrap(),
            result
        );
    }
    let text = r#"{"kind":"settled","startedAt":0.75,"outcome":"success","reason":null,"reason":{},"foreign":[]}"#;
    assert_eq!(
        decode(text).unwrap(),
        ToolResult::Settled {
            started_at: 0.75,
            outcome: ToolStatus::Success
        }
    );
}

#[test]
fn stored_results_reject_malformed_or_coerced_numeric_payloads() {
    for token in [
        r#""0.75""#,
        "null",
        "true",
        "[]",
        r#"{"$serde_json::private::Number":"0.75"}"#,
        "1e400",
    ] {
        let text = format!(r#"{{"kind":"settled","startedAt":{token},"outcome":"success"}}"#);
        assert!(decode(&text).is_err(), "{text}");
    }
    for text in [
        r#"{"kind":"settled","outcome":"success"}"#,
        r#"{"kind":"settled","startedAt":0.75}"#,
        r#"{"kind":"settled","startedAt":0.75,"outcome":null}"#,
        r#"{"kind":"rejected"}"#,
        r#"{"kind":"rejected","reason":null}"#,
        r#"{"kind":"rejected","reason":"unavailable","reason":"cancelled"}"#,
        r#"{"kind":"settled","kind":"settled","startedAt":0.75,"outcome":"success"}"#,
        r#"{"kind":"settled","startedAt":0.75,"startedAt":1,"outcome":"success"}"#,
        r#"{"kind":"settled","startedAt":0.75,"outcome":"success","outcome":"error"}"#,
        r#"{"kind":{"settled":null},"startedAt":0.75,"outcome":"success"}"#,
        r#"{"kind":"unknown"}"#,
        r#"{"startedAt":0.75,"outcome":"success"}"#,
        "null",
        "[]",
        r#"["rejected","unavailable"]"#,
    ] {
        assert!(decode(text).is_err(), "{text}");
    }
}

#[test]
fn ignored_tool_fields_keep_complete_json_validation() {
    let deep = format!("{}0{}", "[".repeat(130), "]".repeat(130));
    for payload in [
        r#""\ud800""#,
        "1e400",
        r#"{"$serde_json::private::Number":"not-a-number"}"#,
        r#"{"repeated":"\ud800","repeated":0}"#,
        deep.as_str(),
    ] {
        for key in ["foreign", "startedAt", "outcome"] {
            let text = format!(r#"{{"kind":"rejected","reason":"unavailable","{key}":{payload}}}"#);
            let expected =
                serde_json::from_str::<ToolResult>(&text).map_err(|error| error.classify());
            let actual = decode(&text).map_err(|error| error.classify());
            assert_eq!(actual, expected, "{text}");
            if payload.contains("ud800") || payload == deep {
                assert!(actual.is_err(), "{text}");
            }
            if payload.contains("$serde_json::private::Number") {
                assert!(
                    actual.is_ok(),
                    "marker-shaped ignored object is ordinary data"
                );
            }
        }
    }
}
