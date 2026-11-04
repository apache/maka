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

// Adapted from OpenCode 55276f2108c8853f94cf16dc530e7754a6ce8318,
// packages/ai/src/{provider-error.ts,utils/provider-codes.ts}; MIT, Copyright (c) 2025 opencode.
// The upstream license and source record are retained in the root LICENSE and docs/code-origin-audit.md.
use maka_provider_protocol::output::ProviderError;
use regex::{RegexSet, RegexSetBuilder};
use serde_json::Value;
use std::sync::OnceLock;

const PATTERNS: &[&str] = &[
    r"prompt is too long",
    r"input is too long for (?:the )?(?:requested|selected) model",
    r"too large for the model'?s configured input limit",
    r"exceeded this model context window limit",
    r"exceeds the context window",
    r"exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))",
    r"input token count.*exceeds the maximum",
    r"number of input tokens exceeds maximum length",
    r"tokens in request more than max tokens allowed",
    r"maximum prompt length is \d+",
    r"reduce the length of the messages",
    r"requested input length \d+ exceeds maximum input length",
    r"maximum context length is \d+ tokens",
    r"exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?",
    r"input(?: \(\d+ tokens\))? is longer than the model'?s context length",
    r"exceeds the limit of \d+",
    r"exceeds the available context size",
    r"greater than the context length",
    r"`inputs` tokens \+ `max_new_tokens` must be <= \d+",
    r"context window exceeds limit",
    r"context window exceeded",
    r"exceeded model token limit",
    r"context[_ ]length[_ ]exceeded",
    r"context length is only \d+ tokens",
    r"input length.*exceeds.*context length",
    r"prompt (?:too long|exceeds max length|超长)",
    r"too large for model with \d+ maximum context length",
    r"prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?",
    r"model_context_window_exceeded",
    r"range of input length should be",
    r"too many tokens",
    r"token limit exceeded",
    r"request_too_large",
    r"^4(?:00|13)\s*(status code)?\s*\(no body\)",
];
const EXCLUSIONS: &[&str] = &[
    r"^(throttling error|service unavailable):",
    r"rate limit",
    r"too many requests",
    r"max[_ ]tokens must be less than",
    r"too many tokens(?: per day)?, please wait",
];

fn patterns() -> &'static (RegexSet, RegexSet) {
    static MATCHERS: OnceLock<(RegexSet, RegexSet)> = OnceLock::new();
    MATCHERS.get_or_init(|| {
        let compile = |values: &[&str]| {
            RegexSetBuilder::new(values)
                .case_insensitive(true)
                .build()
                .expect("static provider error patterns are valid")
        };
        (compile(PATTERNS), compile(EXCLUSIONS))
    })
}

pub(super) fn identifiers(error: &ProviderError) -> Vec<String> {
    let mut result = Vec::new();
    let mut add = |value: &Value| {
        if let Some(value) = value.as_str() {
            result.push(value.to_ascii_lowercase());
            let shape = value
                .split(':')
                .next()
                .unwrap_or(value)
                .rsplit('#')
                .next()
                .unwrap_or(value);
            if shape != value {
                result.push(shape.to_ascii_lowercase());
            }
        }
    };
    let decoded = error
        .data
        .as_str()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let data = decoded.as_ref().unwrap_or(&error.data);
    for path in [
        "/code",
        "/type",
        "/__type",
        "/error_type",
        "/error/code",
        "/error/type",
        "/error/status",
        "/error/error_type",
        "/error/innererror/code",
        "/error/metadata/error_type",
        "/response/error/code",
        "/response/error/type",
        "/response/error_type",
        "/exception/type",
    ] {
        if let Some(value) = data.pointer(path) {
            add(value);
        }
    }
    if let Some(details) = data.pointer("/error/details").and_then(Value::as_array) {
        for detail in details {
            if let Some(reason) = detail.get("reason") {
                add(reason);
            }
        }
    }
    if let Some(code) = &error.code {
        add(code);
    }
    if let Some(kind) = &error.kind {
        result.push(kind.to_ascii_lowercase());
    }
    result
}

pub(super) fn rejected(error: &ProviderError, identifiers: &[String]) -> bool {
    if error
        .status
        .is_some_and(|status| !(400..500).contains(&status))
    {
        return false;
    }
    if identifiers.iter().any(|value| {
        matches!(
            value.as_str(),
            "context_length_exceeded" | "model_context_window_exceeded" | "request_too_large"
        )
    }) {
        return true;
    }
    if error.status == Some(429)
        || identifiers
            .iter()
            .any(|value| value == "throttlingexception")
    {
        return false;
    }
    let data = match &error.data {
        Value::String(value) => std::borrow::Cow::Borrowed(value.as_str()),
        value => std::borrow::Cow::Owned(value.to_string()),
    };
    let texts = [error.message.as_deref().unwrap_or(""), data.as_ref()];
    let (overflow, exclusions) = patterns();
    !texts.iter().any(|text| exclusions.is_match(text))
        && texts.iter().any(|text| overflow.is_match(text))
}
