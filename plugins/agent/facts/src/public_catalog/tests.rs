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

fn accepts_like_value(json: &str) {
    assert_eq!(
        PublicCatalogBody::from_json(json.into()).is_ok(),
        serde_json::from_str::<Value>(json).is_ok(),
        "{json:?}"
    );
}

#[test]
fn full_input_validation_matches_value_including_overwritten_and_unknown_fields() {
    for input in [
        "null",
        "true",
        "false",
        "0",
        "-0",
        "1.0",
        "1e0",
        "-0.0",
        "1e-9999",
        "9223372036854775807",
        "-9223372036854775808",
        "18446744073709551615",
        "18446744073709551616",
        "1.7976931348623157e308",
        "1.7976931348623159e308",
        "1e400",
        "-1e400",
        "",
        " ",
        "[] trailing",
        "{}{}",
        "[1,]",
        "{\"x\":}",
        "01",
        "+1",
        "{1:0}",
        "{a:0}",
        "NaN",
        "Infinity",
        "1.",
        "1e",
        r#""\ud800""#,
        r#""\udc00""#,
        r#""\ud800\udc00""#,
        r#""\ud800x""#,
        r#"{"\ud800":0}"#,
        r#"{"unknown":"\ud800","unknown":null}"#,
        r#"{"unknown":1e400,"unknown":null}"#,
        r#"{"x":{"unknown":1e400},"x":null}"#,
        r#"{"unknown":"\udc00","unused":true}"#,
        r#"{"0":false,"\u0061":0,"a":1}"#,
        "[null,true,false,\"文字😀\",-12.5e4]",
        " \r\n {\"unknown\":null} \t",
    ] {
        accepts_like_value(input);
    }
    for depth in 120..=132 {
        let array = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        accepts_like_value(&array);
        accepts_like_value(&format!(r#"{{"unknown":{array},"unknown":null}}"#));
        let object = format!(
            "{}null{}",
            r#"{"unknown":"#.repeat(depth),
            "}".repeat(depth)
        );
        accepts_like_value(&object);
    }
    for bytes in [
        b"\xff".as_slice(),
        b"{\"unknown\":\"\xff\"}",
        b"{\"\xff\":null}",
        "\"文字\"".as_bytes(),
    ] {
        let accepted = String::from_utf8(bytes.to_vec())
            .ok()
            .and_then(|s| PublicCatalogBody::from_json(s).ok())
            .is_some();
        assert_eq!(accepted, serde_json::from_slice::<Value>(bytes).is_ok());
    }
}

#[test]
fn all_content_equality_matches_value_number_categories_duplicates_and_order() {
    let corpus = [
        "null",
        "true",
        "false",
        "0",
        "-0",
        "0.0",
        "-0.0",
        "1",
        "1.0",
        "1e0",
        "1.00",
        "9223372036854775807",
        "9223372036854775808",
        "18446744073709551615",
        "18446744073709551616",
        "18446744073709551616.0",
        "1e-9999",
        "1.7976931348623157e308",
        r#""a""#,
        r#""\u0061""#,
        r#""\ud83d\ude00""#,
        "\"😀\"",
        "[]",
        "[1,2]",
        "[2,1]",
        "[1]",
        "[1.0,2]",
        r#"{"a":1,"b":2}"#,
        r#"{"b":2,"a":1}"#,
        r#"{"a":0,"\u0061":1,"b":2}"#,
        r#"{"a":1,"b":2,"unknown":null}"#,
        r#"{"a":1,"b":2,"unknown":false}"#,
        r#"{"unknown":[{"future":1}]}"#,
        r#"{"unknown":[{"future":1.0}]}"#,
        r#"{"data":false,"data":[]}"#,
        r#"{"data":[]}"#,
    ];
    for left in corpus {
        let a = PublicCatalogBody::from_json(left.into()).unwrap();
        let va: Value = serde_json::from_str(left).unwrap();
        assert!(a.same_content(&a.clone()).unwrap());
        for right in corpus {
            let b = PublicCatalogBody::from_json(right.into()).unwrap();
            let vb: Value = serde_json::from_str(right).unwrap();
            assert_eq!(a.same_content(&b).unwrap(), va == vb, "{left} vs {right}");
        }
    }
    for depth in 120..=128 {
        let a = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        let b = format!("{}0{}", "[ ".repeat(depth), " ]".repeat(depth));
        if let (Ok(a), Ok(b)) = (
            PublicCatalogBody::from_json(a),
            PublicCatalogBody::from_json(b),
        ) {
            assert!(a.same_content(&b).unwrap());
        }
    }
}

#[test]
fn numeric_content_equality_matches_value_overflow_policy() {
    // Workspace feature unification can enable arbitrary_precision, accepting 1e400.
    let overflow: &RawValue = serde_json::from_str("1e400").unwrap();
    let zero: &RawValue = serde_json::from_str("0").unwrap();
    let expected = serde_json::from_str::<Value>(overflow.get());
    assert_eq!(
        equal(overflow, zero).map_err(|error| error.classify()),
        expected
            .as_ref()
            .map(|value| value == &Value::from(0))
            .map_err(|error| error.classify())
    );
    assert_eq!(
        PublicCatalogBody::from_json(overflow.get().into())
            .map(|_| ())
            .map_err(|error| error.classify()),
        expected.map(|_| ()).map_err(|error| error.classify())
    );
}

#[test]
fn scalar_parser_failure_is_not_silently_content_inequality() {
    // RawValue accepts lone surrogates regardless of the numeric feature set.
    let malformed: &RawValue = serde_json::from_str(r#""\ud800""#).unwrap();
    let valid: &RawValue = serde_json::from_str(r#""valid""#).unwrap();
    assert!(serde_json::from_str::<Value>(malformed.get()).is_err());
    assert!(equal(malformed, valid).is_err());
    assert!(equal(valid, malformed).is_err());
    assert!(PublicCatalogBody::from_json(malformed.get().into()).is_err());
}
