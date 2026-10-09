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

//! `web-search.execute`: a real search through the Host's web search
//! source (Tavily), or a test of its credential, from the Web Search
//! settings page.
//!
//! Source: `packages/runtime-host/src/protocol/web-search.ts`
//! (`WEB_SEARCH_OPERATION_SPECS`, `decodeWebSearchExecuteInput`,
//! `decodeWebSearchExecuteResult`, `decodeWebSearchRow`); the result is
//! `WebSearchResponse` in `packages/core/src/web-search.ts`.
//!
//! The operation fails with `host_not_ready`, `host_draining`,
//! `operation_unavailable`, `invalid_request`, or `internal_failure`
//! (`ERRORS`); a search the source refused (a bad key, a rate limit,
//! incognito) is an `ok: false` result with its reason.

use serde::{Deserialize, Serialize};

use crate::{Operation, WebSearchProvider};

/// The most rows a query asks for (`WEB_SEARCH_MAX_LIMIT`).
pub const WEB_SEARCH_MAX_LIMIT: u8 = 10;

/// The rows the settings page asks for (`WEB_SEARCH_DEFAULT_LIMIT`, and
/// `limit: 5` in web-search-settings-page.tsx).
pub const WEB_SEARCH_DEFAULT_LIMIT: u8 = 5;

/// The longest query in characters: longer is cut
/// (`WEB_SEARCH_QUERY_MAX_CHARS`, `normalizeWebSearchQuery`).
pub const WEB_SEARCH_QUERY_MAX_CHARS: usize = 200;

/// `WebSearchExecuteInput` (`decodeWebSearchExecuteInput`): a query of 1 to
/// [`WEB_SEARCH_MAX_LIMIT`] rows, or a test of the Tavily credential. Either
/// may carry a key to use instead of the saved one (a key typed but not yet
/// saved); its `Debug` leaves the key out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum WebSearchExecuteInput {
    #[serde(rename_all = "camelCase")]
    Query {
        query: String,
        limit: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
    },
    /// `provider` is always `tavily`, the one source with a credential.
    #[serde(rename_all = "camelCase")]
    Test {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
    },
}

impl std::fmt::Debug for WebSearchExecuteInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Query { query, limit, api_key } => f
                .debug_struct("Query")
                .field("query", query)
                .field("limit", limit)
                .field("api_key", &api_key.as_ref().map(|_| ".."))
                .finish(),
            Self::Test { provider, api_key } => f
                .debug_struct("Test")
                .field("provider", provider)
                .field("api_key", &api_key.as_ref().map(|_| ".."))
                .finish(),
        }
    }
}

impl WebSearchExecuteInput {
    /// A query for `limit` rows, normalized as Desktop's preload does
    /// (`normalizeWebSearchQuery`, `normalizeWebSearchLimit`): trimmed, cut
    /// at [`WEB_SEARCH_QUERY_MAX_CHARS`], the limit held to 1 to
    /// [`WEB_SEARCH_MAX_LIMIT`]. `None` when nothing is left to search for.
    pub fn query(query: &str, limit: u8) -> Option<Self> {
        let query: String = query.trim().chars().take(WEB_SEARCH_QUERY_MAX_CHARS).collect();
        (!query.is_empty()).then(|| Self::Query {
            query,
            limit: limit.clamp(1, WEB_SEARCH_MAX_LIMIT),
            api_key: None,
        })
    }

    /// A test of the Tavily credential: the saved one, or `api_key` when
    /// one is typed (an empty key is the saved one, as Desktop's
    /// `webSearchCredentialOverride` reads it).
    pub fn test(api_key: Option<String>) -> Self {
        Self::Test { provider: "tavily".to_owned(), api_key: api_key.filter(|key| !key.is_empty()) }
    }
}

wire_enum! {
    /// `WebSearchErrorReason` (`WEB_SEARCH_ERROR_REASONS`).
    pub enum WebSearchErrorReason {
        InvalidQuery = "invalid_query",
        IncognitoActive = "incognito_active",
        NotConfigured = "not_configured",
        InvalidCredentials = "invalid_credentials",
        RateLimited = "rate_limited",
        NetworkError = "network_error",
        Timeout = "timeout",
        UnsupportedProvider = "unsupported_provider",
        ExperimentalDisabled = "experimental_disabled",
    }
}

/// `WebSearchResultRow` (`decodeWebSearchRow`): plain text, no markup; the
/// `source` is the URL's host name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct WebSearchResultRow {
    pub provider: WebSearchProvider,
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
}

/// `WebSearchResponse` (`decodeWebSearchExecuteResult`): the rows found, or
/// why the source refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawResult", into = "RawResult")]
#[non_exhaustive]
pub enum WebSearchExecuteResult {
    Found { provider: Option<WebSearchProvider>, results: Vec<WebSearchResultRow> },
    Failed { reason: WebSearchErrorReason, message: String },
}

/// The result as the wire has it: `ok` says which fields it carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
struct RawResult {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<WebSearchProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    results: Option<Vec<WebSearchResultRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<WebSearchErrorReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl TryFrom<RawResult> for WebSearchExecuteResult {
    type Error = String;

    fn try_from(raw: RawResult) -> Result<Self, Self::Error> {
        match raw {
            RawResult {
                ok: true,
                provider,
                results: Some(results),
                reason: None,
                message: None,
            } => Ok(Self::Found { provider, results }),
            RawResult {
                ok: false,
                provider: None,
                results: None,
                reason: Some(reason),
                message: Some(message),
            } => Ok(Self::Failed { reason, message }),
            _ => Err("a Web Search result is its rows or its error, never both".to_owned()),
        }
    }
}

impl From<WebSearchExecuteResult> for RawResult {
    fn from(result: WebSearchExecuteResult) -> Self {
        match result {
            WebSearchExecuteResult::Found { provider, results } => {
                Self { ok: true, provider, results: Some(results), reason: None, message: None }
            }
            WebSearchExecuteResult::Failed { reason, message } => Self {
                ok: false,
                provider: None,
                results: None,
                reason: Some(reason),
                message: Some(message),
            },
        }
    }
}

/// `web-search.execute` (mode `command`).
#[derive(Debug)]
pub enum WebSearchExecute {}

impl Operation for WebSearchExecute {
    const NAME: &'static str = "web-search.execute";
    type Input = WebSearchExecuteInput;
    type Output = WebSearchExecuteResult;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn inputs_encode_as_the_host_decodes_them_and_keep_the_key_out_of_debug() {
        let query = WebSearchExecuteInput::query("  rust gpui  ", 5).expect("a query");
        assert_eq!(
            serde_json::to_value(&query).expect("encode"),
            json!({"kind": "query", "query": "rust gpui", "limit": 5})
        );
        assert_eq!(WebSearchExecuteInput::query(" \n ", 5), None, "nothing left to search");
        let long = "字".repeat(WEB_SEARCH_QUERY_MAX_CHARS + 20);
        let Some(WebSearchExecuteInput::Query { query, limit, .. }) =
            WebSearchExecuteInput::query(&long, 40)
        else {
            panic!("a query");
        };
        assert_eq!(query.chars().count(), WEB_SEARCH_QUERY_MAX_CHARS);
        assert_eq!(limit, WEB_SEARCH_MAX_LIMIT);

        let saved = WebSearchExecuteInput::test(Some(String::new()));
        assert_eq!(
            serde_json::to_value(&saved).expect("encode"),
            json!({"kind": "test", "provider": "tavily"}),
            "an empty draft tests the saved key"
        );
        let typed = WebSearchExecuteInput::test(Some("tvly-secret".into()));
        assert_eq!(
            serde_json::to_value(&typed).expect("encode"),
            json!({"kind": "test", "provider": "tavily", "apiKey": "tvly-secret"})
        );
        assert!(!format!("{typed:?}").contains("tvly-secret"));
        let decoded: WebSearchExecuteInput = serde_json::from_value(
            json!({"kind": "query", "query": "q", "limit": 3, "apiKey": "k"}),
        )
        .expect("decode");
        assert!(matches!(decoded, WebSearchExecuteInput::Query { api_key: Some(_), .. }));
    }

    #[test]
    fn a_result_is_its_rows_or_its_reason() {
        let found = json!({"ok": true, "provider": "tavily", "results": [{
            "provider": "tavily", "title": "GPUI", "url": "https://gpui.rs/",
            "snippet": "A fast UI framework.", "source": "gpui.rs"}]});
        let decoded: WebSearchExecuteResult =
            serde_json::from_value(found.clone()).expect("decode");
        let WebSearchExecuteResult::Found { provider, results } = &decoded else {
            panic!("rows");
        };
        assert_eq!(provider, &Some(WebSearchProvider::Tavily));
        assert_eq!(results[0].source, "gpui.rs");
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), found);
        // `provider` is optional on success, and there may be no rows.
        let empty: WebSearchExecuteResult =
            serde_json::from_value(json!({"ok": true, "results": []})).expect("decode");
        assert_eq!(empty, WebSearchExecuteResult::Found { provider: None, results: vec![] });

        let failed = json!({"ok": false, "reason": "invalid_credentials",
                            "message": "Tavily rejected the API key"});
        let decoded: WebSearchExecuteResult =
            serde_json::from_value(failed.clone()).expect("decode");
        assert_eq!(
            decoded,
            WebSearchExecuteResult::Failed {
                reason: WebSearchErrorReason::InvalidCredentials,
                message: "Tavily rejected the API key".into(),
            }
        );
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), failed);
        // A reason this client does not know is kept.
        let newer: WebSearchExecuteResult =
            serde_json::from_value(json!({"ok": false, "reason": "quota", "message": "m"}))
                .expect("decode");
        assert!(matches!(
            newer,
            WebSearchExecuteResult::Failed { reason: WebSearchErrorReason::Other(_), .. }
        ));
        for broken in [
            json!({"ok": true}),
            json!({"ok": false, "message": "no reason"}),
            json!({"ok": true, "results": [], "reason": "timeout", "message": "m"}),
        ] {
            assert!(serde_json::from_value::<WebSearchExecuteResult>(broken).is_err());
        }
    }
}
