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

fn accounting(rate: &str, usd: &str) -> String {
    format!(
        r#"{{"event_id":"request","quote":{{"providerId":"provider","revision":1,"pricing":{{"modelKey":"provider:model","inputUsdPer1M":{rate},"outputUsdPer1M":{rate},"cacheReadUsdPer1M":{rate},"cacheWriteUsdPer1M":{rate}}}}},"valuation":{{"usage":{{}},"usd":{usd}}},"kind":"accounting"}}"#
    )
}

#[test]
fn accounting_rejects_coerced_numbers_and_ambiguous_fields() {
    for token in [
        r#""0.75""#,
        "true",
        "[]",
        r#"{"$serde_json::private::Number":"0.75"}"#,
        "1e400",
    ] {
        for text in [accounting(token, "0"), accounting("0", token)] {
            assert!(serde_json::from_str::<Record>(&text).is_err(), "{text}");
        }
    }
    // Pricing's required and present optional rates are not nullable; valuation is.
    assert!(serde_json::from_str::<Record>(&accounting("null", "0")).is_err());
    let text = accounting("0.75", "0.25");
    for invalid in [
        text.replacen("{", r#"{"kind":"accounting","#, 1),
        text.replacen(r#""kind":"accounting""#, r#""kind":{"accounting":null}"#, 1),
        text.replacen(
            r#""event_id":"request""#,
            r#""event_id":"request","event_id":"again""#,
            1,
        ),
        text.replacen(r#""usd":0.25"#, r#""usd":0.25,"usd":0.5"#, 1),
        text.replacen(
            r#""inputUsdPer1M":0.75"#,
            r#""inputUsdPer1M":0.75,"inputUsdPer1M":1"#,
            1,
        ),
        text.replacen(r#""inputUsdPer1M":0.75,"#, "", 1),
        text.replacen(
            r#""inputUsdPer1M":0.75"#,
            r#""inputUsdPer1M":0.75,"foreign":0"#,
            1,
        ),
        text.replacen(
            r#""event_id":"request""#,
            r#""event_id":"request","sequence":1"#,
            1,
        ),
    ] {
        assert!(
            serde_json::from_str::<Record>(&invalid).is_err(),
            "{invalid}"
        );
    }
    for invalid in [
        "null",
        "[]",
        r#"["accounting"]"#,
        r#"{"kind":"unknown"}"#,
        r#"{"kind":"end","digest":"digest","frames":18446744073709551616}"#,
        r#"{"kind":"end","digest":"digest","frames":1.0}"#,
    ] {
        assert!(
            serde_json::from_str::<Record>(invalid).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn ignored_usage_values_keep_complete_json_validation() {
    // The pre-fix tagged shape provides the feature-dependent validity oracle.
    // Integer-zero rates let it reach ignored metadata even with arbitrary_precision.
    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    enum BufferedRecord {
        Accounting {
            #[serde(rename = "event_id")]
            _event_id: String,
            #[serde(rename = "quote")]
            _quote: Quote,
            #[serde(rename = "valuation")]
            _valuation: Option<Valuation>,
        },
    }
    let deep = format!("{}0{}", "[".repeat(130), "]".repeat(130));
    for payload in [
        r#""\ud800""#,
        "1e400",
        r#"{"$serde_json::private::Number":"not-a-number"}"#,
        r#"{"repeated":"\ud800","repeated":0}"#,
        deep.as_str(),
    ] {
        let text = accounting("0", "0").replace(
            r#""usage":{}"#,
            &format!(r#""usage":{{"foreign":{payload}}}"#),
        );
        // Record wraps decoder diagnostics in D::Error::custom; callers rely on
        // Json failure, not serde_json's category of the wrapped inner error.
        let expected = serde_json::from_str::<BufferedRecord>(&text)
            .map(|_| ())
            .map_err(|_| ());
        let actual = serde_json::from_str::<Record>(&text)
            .map(|_| ())
            .map_err(|_| ());
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
