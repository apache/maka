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
use maka_agent_facts::tools::{ModelToolContext, ProviderToolProtocol};
use maka_web_api::{
    contract::{Basis, Capture},
    settings::{Auth, AuthLocation, Backend, Source},
};
use serde_json::json;

#[test]
fn saved_tavily_preference_keeps_the_tavily_credential() {
    let settings: maka_web_api::settings::Settings =
        serde_json::from_value(json!({"enabled":true,"source":"tavily"})).unwrap();
    assert_eq!(settings.source, Source::Custom);
    assert_eq!(
        SearchEndpoint::resolve(&settings.backend)
            .unwrap()
            .credential_key(&settings.backend)
            .as_deref(),
        Some("tavily")
    );
}

#[test]
fn search_uses_first_available_source() {
    let model = ModelToolContext {
        model: "test".into(),
        capabilities: maka_agent_facts::configuration::ModelCapabilities {
            web_search: Some(true),
            ..Default::default()
        },
        provider_tools: Some(ProviderToolProtocol::OpenaiResponses),
    };
    let mut capture = Capture {
        basis: Basis {
            revision: None,
            credential_revision: None,
        },
        available: true,
        source: Source::Model,
        custom_available: true,
    };
    assert!(
        matches!(select(&capture, Some(&model)), Some(Selection::Provider(tool)) if tool.id == "openai.web_search")
    );
    assert!(matches!(select(&capture, None), Some(Selection::Custom)));
    capture.source = Source::Custom;
    assert!(matches!(
        select(&capture, Some(&model)),
        Some(Selection::Custom)
    ));
    capture.custom_available = false;
    assert!(matches!(
        select(&capture, Some(&model)),
        Some(Selection::Provider(_))
    ));
    assert!(select(&capture, None).is_none());
    capture.available = false;
    assert!(select(&capture, Some(&model)).is_none());
}

#[test]
fn presets_encode_provider_requests_and_read_results() {
    let search = Query {
        query: "rust + web".into(),
        limit: 3,
    };
    for (backend, endpoint_url, header, credential, params, response) in [
        (
            Backend::Tavily,
            "https://api.tavily.com/search",
            "Authorization",
            "Bearer token",
            json!({"query":"rust + web","max_results":3,"search_depth":"basic"}),
            json!({"results":[{"title":"Rust","url":"https://rust-lang.org/","content":"A language"}]}),
        ),
        (
            Backend::Brave,
            "https://api.search.brave.com/res/v1/web/search?q=rust+%2B+web&count=3",
            "X-Subscription-Token",
            "token",
            Value::Null,
            json!({"web":{"results":[{"title":"Rust","url":"https://rust-lang.org/","description":"A language"}]}}),
        ),
        (
            Backend::Exa,
            "https://api.exa.ai/search",
            "x-api-key",
            "token",
            json!({"query":"rust + web","numResults":3,"contents":{"highlights":true}}),
            json!({"results":[{"title":"Rust","url":"https://rust-lang.org/","highlights":["A language"]}]}),
        ),
        (
            Backend::Serper,
            "https://google.serper.dev/search",
            "X-API-KEY",
            "token",
            json!({"q":"rust + web","num":3}),
            json!({"organic":[{"title":"Rust","link":"https://rust-lang.org/","snippet":"A language"}]}),
        ),
    ] {
        let endpoint = SearchEndpoint::resolve(&backend).unwrap();
        let request = endpoint.request(Some("token"), &search).unwrap();
        assert_eq!(request.url, endpoint_url);
        assert!(
            request
                .headers
                .contains(&(header.into(), credential.into()))
        );
        if params.is_null() {
            assert!(matches!(
                request.method,
                maka_plugin_core::http::Method::Get
            ));
            assert_eq!(request.body.length(), Some(0));
        } else {
            assert!(matches!(
                request.method,
                maka_plugin_core::http::Method::Post
            ));
            assert_eq!(body(request.body), params);
        }
        let result = decode(
            &serde_json::to_vec(&response).unwrap(),
            &search,
            &endpoint.config.results,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&result.rows).unwrap(),
            json!([{"title":"Rust","url":"https://rust-lang.org/","snippet":"A language"}])
        );
    }
}

#[test]
fn custom_search_injects_credentials_in_configured_location_only() {
    let mut config = presets()[0].endpoint.clone();
    config.url = "https://search.example/query".into();
    config.url_parameters.insert("region".into(), "cn".into());
    let search = Query {
        query: "a & b".into(),
        limit: 2,
    };
    for location in [AuthLocation::Query, AuthLocation::Body] {
        config.auth = Some(Auth {
            location,
            name: "key".into(),
            prefix: "".into(),
        });
        let endpoint = SearchEndpoint::resolve(&Backend::Custom {
            endpoint: config.clone(),
        })
        .unwrap();
        let request = endpoint.request(Some("secret/word"), &search).unwrap();
        assert!(
            request
                .headers
                .iter()
                .all(|(_, value)| !value.contains("secret"))
        );
        let body = body(request.body);
        assert_eq!(body["query"], "a & b");
        if location == AuthLocation::Query {
            assert_eq!(
                request.url,
                "https://search.example/query?region=cn&key=secret%2Fword"
            );
            assert!(body.get("key").is_none());
        } else {
            assert_eq!(request.url, "https://search.example/query?region=cn");
            assert_eq!(body["key"], "secret/word");
        }
    }
    config.auth = None;
    let backend = Backend::Custom { endpoint: config };
    let endpoint = SearchEndpoint::resolve(&backend).unwrap();
    assert!(endpoint.credential_key(&backend).is_none());
    assert!(endpoint.request(None, &search).is_ok());
}

fn body(body: http::RequestBody) -> Value {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async move {
        let bytes = futures_util::TryStreamExt::try_fold(
            body.into_stream(),
            Vec::new(),
            |mut bytes, chunk| async move {
                bytes.extend_from_slice(&chunk);
                Ok(bytes)
            },
        )
        .await
        .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    })
}
