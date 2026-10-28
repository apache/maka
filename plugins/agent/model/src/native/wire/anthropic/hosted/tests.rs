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
use maka_agent_facts::model::prompt_source::source::{Allocate, ChargedBuffer};
use maka_provider_protocol::anthropic::hosted::{
    self, AdvisorResult, CodeResult, FetchResult, SearchResult, ToolReference,
};
use serde_json::{Value, json};

struct Budget;
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
    }
}
fn json_source(value: &Value) -> JsonSource {
    JsonSource {
        bytes: SourceBytes::Inline(Bytes::from(
            serde_json::to_vec(value).expect("fixture JSON"),
        )),
    }
}
async fn encode(tool: &'static str, value: &Value) -> (&'static str, Value) {
    encode_output(tool, ToolOutputRecipe::Json(json_source(value)), None).await
}
async fn encode_output(
    tool: &'static str,
    output: ToolOutputRecipe,
    parsed_error: Option<ParsedToolError>,
) -> (&'static str, Value) {
    let (kind, fragments) = hosted_result(tool, output, parsed_error, Arc::new(Budget))
        .await
        .expect("hosted result")
        .expect("supported hosted output");
    let mut bytes = Vec::new();
    for fragment in fragments {
        let mut cursor = FragmentCursor::new(fragment);
        while let Some(chunk) = cursor.next(Arc::new(Budget)).await.expect("hosted source") {
            bytes.extend_from_slice(&chunk);
        }
    }
    (
        kind,
        serde_json::from_slice(&bytes).expect("encoded result JSON"),
    )
}
#[tokio::test]
async fn code_variants_preserve_the_owned_schema_defaults_and_unknown_field_policy() {
    for value in [
        json!({"type":"code_execution_result", "stdout":"原文🙂\n", "stderr":"", "return_code":0, "extra":{"opaque":[1,2]}}),
        json!({"type":"encrypted_code_execution_result", "encrypted_stdout":"opaque", "stderr":"", "return_code":1}),
        json!({"type":"bash_code_execution_result", "stdout":"", "stderr":"", "return_code":2, "content":[{"type":"bash_code_execution_output","file_id":"f1","ignored":true}]}),
        json!({"type":"bash_code_execution_tool_result_error", "error_code":"x"}),
        json!({"type":"text_editor_code_execution_tool_result_error", "error_code":"x"}),
        json!({"type":"text_editor_code_execution_view_result", "content":"file", "file_type":"text"}),
        json!({"type":"text_editor_code_execution_create_result", "is_file_update":false}),
        json!({"type":"text_editor_code_execution_str_replace_result", "lines":["a","b"], "new_lines":2}),
    ] {
        let expected =
            hosted::wire(hosted::parse::<CodeResult>(&value).expect("owned code oracle"));
        assert_eq!(
            encode("code_execution", &value).await.1,
            expected,
            "input {value}"
        );
    }
}
#[tokio::test]
async fn search_fetch_references_and_advisor_match_owned_normalization() {
    let search =
        json!([{"type":"web_search_result","url":"u","encrypted_content":"secret","ignored":"x"}]);
    assert_eq!(
        encode("web_search", &search).await.1,
        hosted::wire(hosted::parse::<Vec<SearchResult>>(&search).expect("search oracle"))
    );
    let fetch = json!({"type":"web_fetch_result","url":"u","content":{"type":"document","source":{"type":"text","media_type":"text/plain","data":"body"},"citations":{"enabled":true,"ignored":true}}});
    assert_eq!(
        encode("web_fetch", &fetch).await.1,
        hosted::wire(hosted::parse::<FetchResult>(&fetch).expect("fetch oracle"))
    );
    let refs = json!([{"type":"tool_reference","tool_name":"tool","unknown":42}]);
    assert_eq!(
        encode("tool_search_tool_regex", &refs).await.1,
        json!({"type":"tool_search_tool_search_result","tool_references":hosted::parse::<Vec<ToolReference>>(&refs).expect("references oracle")})
    );
    for advisor in [
        json!({"type":"advisor_result","text":"answer","stop_reason":null}),
        json!({"type":"advisor_redacted_result","encrypted_content":"opaque","stop_reason":"done"}),
        json!({"type":"advisor_tool_result_error","error_code":"busy"}),
    ] {
        assert_eq!(
            encode("advisor", &advisor).await.1,
            hosted::wire(hosted::parse::<AdvisorResult>(&advisor).expect("advisor oracle"))
        );
    }
}
#[tokio::test]
async fn invalid_file_discriminators_fail_during_streaming() {
    let value = json!({"type":"code_execution_result","stdout":"","stderr":"","return_code":0,"content":[{"type":"wrong","file_id":"file"}]});
    assert!(hosted::parse::<CodeResult>(&value).is_err());
    let (_, fragments) = hosted_result(
        "code_execution",
        ToolOutputRecipe::Json(json_source(&value)),
        None,
        Arc::new(Budget),
    )
    .await
    .expect("plan hosted result")
    .expect("supported output");
    let mut cursor = FragmentCursor::new(fragments.into_iter().next().expect("normalizer source"));
    loop {
        match cursor.next(Arc::new(Budget)).await {
            Ok(Some(_)) => {}
            Ok(None) => panic!("invalid hosted discriminator was accepted"),
            Err(_) => break,
        }
    }
}

#[tokio::test]
async fn numbers_round_like_serde_with_long_mantissas_and_exponents() {
    let halfway = "1.00000000000000011102230246251565404236316680908203125";
    for token in [
        "-0".to_owned(),
        "-0.0".to_owned(),
        "1e400".to_owned(),
        "18446744073709551615".to_owned(),
        "18446744073709551616".to_owned(),
        "340282366920938463463374607431768211456".to_owned(),
        "4.9406564584124654e-324".to_owned(),
        "2.2250738585072014e-308".to_owned(),
        format!("1{}e-4096", "0".repeat(4096)),
        format!("{halfway}{}", "0".repeat(4096)),
        format!("{halfway}{}1", "0".repeat(4096)),
        format!(
            "{}{}e-{}",
            halfway.replace('.', ""),
            "0".repeat(4096),
            halfway.len() - 2 + 4096
        ),
        format!(
            "{}{}1e-{}",
            halfway.replace('.', ""),
            "0".repeat(4096),
            halfway.len() - 2 + 4097
        ),
        format!("-1e-{}", "9".repeat(4096)),
        format!("0.{}", "0".repeat(4096)),
        format!("0e{}", "0".repeat(4096)),
    ] {
        let raw = format!(
            "{{\"type\":\"code_execution_result\",\"stdout\":\"\",\"stderr\":\"\",\"return_code\":{token}}}"
        );
        let expected = serde_json::from_str::<Value>(&raw)
            .map_err(|error| error.to_string())
            .and_then(|owned| {
                hosted::parse::<CodeResult>(&owned)
                    .map(hosted::wire)
                    .map_err(|error| error.to_string())
            });
        let actual = async {
            let (_, fragments) = hosted_result(
                "code_execution",
                ToolOutputRecipe::Json(JsonSource {
                    bytes: SourceBytes::Inline(Bytes::from(raw)),
                }),
                None,
                Arc::new(Budget),
            )
            .await
            .map_err(|error| error.to_string())?
            .expect("supported numeric code result");
            let mut actual = Vec::new();
            for fragment in fragments {
                let mut cursor = FragmentCursor::new(fragment);
                while let Some(bytes) = cursor
                    .next(Arc::new(Budget))
                    .await
                    .map_err(|error| error.to_string())?
                {
                    actual.extend_from_slice(&bytes);
                }
            }
            serde_json::from_slice::<Value>(&actual).map_err(|error| error.to_string())
        }
        .await;
        assert_eq!(
            actual.is_ok(),
            expected.is_ok(),
            "owned schema numeric token {token}: actual {actual:?}, expected {expected:?}"
        );
        if let (Ok(actual), Ok(expected)) = (actual, expected) {
            assert_eq!(actual, expected, "owned schema numeric token {token}");
            assert_eq!(
                actual["return_code"].as_f64().map(f64::to_bits),
                expected["return_code"].as_f64().map(f64::to_bits),
                "owned schema numeric sign and rounding for {token}"
            );
        }
    }
}

#[tokio::test]
async fn frozen_error_parse_stages_preserve_wrapper_and_error_code_policies() {
    fn parsed_once(value: &Value) -> Value {
        match value {
            Value::String(text) => serde_json::from_str(text).unwrap_or(Value::Null),
            _ => value.clone(),
        }
    }
    for (tool, value, expected_kind, expected) in [
        (
            "code_execution",
            json!("{\"type\":\"code_execution_tool_result_error\",\"error_code\":\"busy\"}"),
            "code_execution_tool_result",
            json!({"type":"code_execution_tool_result_error","error_code":"busy"}),
        ),
        (
            "code_execution",
            json!("\"{\\\"error_code\\\":\\\"twice\\\"}\""),
            "bash_code_execution_tool_result",
            json!({"type":"bash_code_execution_tool_result_error","error_code":"twice"}),
        ),
        (
            "web_fetch",
            json!("\"{\\\"error_code\\\":\\\"twice\\\"}\""),
            "web_fetch_tool_result",
            json!({"type":"web_fetch_tool_result_error","error_code":"unavailable"}),
        ),
        (
            "web_search",
            json!("{\"error_code\":\"once\"}"),
            "web_search_tool_result",
            json!({"type":"web_search_tool_result_error","error_code":"once"}),
        ),
        (
            "tool_search_tool_regex",
            json!("{\"error_code\":\"once\"}"),
            "tool_search_tool_result",
            json!({"type":"tool_search_tool_result_error","error_code":"once"}),
        ),
    ] {
        let first = parsed_once(&value);
        let second = parsed_once(&first);
        let captured = Some(ParsedToolError {
            value: json_source(&first),
            code_value: json_source(&second),
        });
        assert_eq!(
            encode_output(
                tool,
                ToolOutputRecipe::ErrorJson(json_source(&value)),
                captured
            )
            .await,
            (expected_kind, expected),
            "error input {value}"
        );
    }
    let null = json_source(&Value::Null);
    assert_eq!(
        encode_output(
            "code_execution",
            ToolOutputRecipe::ErrorText(text("malformed JSON")),
            Some(ParsedToolError {
                value: null.clone(),
                code_value: null
            })
        )
        .await,
        (
            "bash_code_execution_tool_result",
            json!({"type":"bash_code_execution_tool_result_error","error_code":"unknown"})
        )
    );
}
