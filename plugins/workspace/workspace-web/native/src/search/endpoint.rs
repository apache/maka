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

use maka_web_api::{search::Query, settings::*};
use serde_json::{Value, json};
use url::Url;

pub(crate) fn presets() -> &'static [Preset] {
    static PRESETS: std::sync::LazyLock<Vec<Preset>> = std::sync::LazyLock::new(build_presets);
    &PRESETS
}

fn build_presets() -> Vec<Preset> {
    [
        (
            Backend::Tavily,
            "https://api.tavily.com/search",
            Method::Post,
            "query",
            "max_results",
            "Authorization",
            "Bearer ",
            "/results",
            "/url",
            "/content",
            json!({"search_depth":"basic"}),
        ),
        (
            Backend::Brave,
            "https://api.search.brave.com/res/v1/web/search",
            Method::Get,
            "q",
            "count",
            "X-Subscription-Token",
            "",
            "/web/results",
            "/url",
            "/description",
            json!({}),
        ),
        (
            Backend::Exa,
            "https://api.exa.ai/search",
            Method::Post,
            "query",
            "numResults",
            "x-api-key",
            "",
            "/results",
            "/url",
            "/highlights/0",
            json!({"contents":{"highlights":true}}),
        ),
        (
            Backend::Serper,
            "https://google.serper.dev/search",
            Method::Post,
            "q",
            "num",
            "X-API-KEY",
            "",
            "/organic",
            "/link",
            "/snippet",
            json!({}),
        ),
    ]
    .into_iter()
    .map(
        |(backend, url, method, query, limit, header, prefix, list, result_url, snippet, body)| {
            let location = match method {
                Method::Get => ParameterLocation::Query,
                Method::Post => ParameterLocation::Body,
            };
            Preset {
                id: backend.preset_id().expect("preset backend"),
                endpoint: Endpoint {
                    url: url.into(),
                    method,
                    query: Parameter {
                        location,
                        name: query.into(),
                    },
                    limit: Some(Parameter {
                        location,
                        name: limit.into(),
                    }),
                    url_parameters: Default::default(),
                    body: body.as_object().expect("preset JSON body").clone(),
                    auth: Some(Auth {
                        location: AuthLocation::Header,
                        name: header.into(),
                        prefix: prefix.into(),
                    }),
                    results: ResultsMapping {
                        list: list.into(),
                        title: Some("/title".into()),
                        url: result_url.into(),
                        snippet: Some(snippet.into()),
                    },
                },
            }
        },
    )
    .collect()
}

#[derive(Clone)]
pub(crate) struct SearchEndpoint {
    pub config: Endpoint,
    url: Url,
    pub destination: maka_sandbox::Destination,
}

impl SearchEndpoint {
    pub fn resolve(backend: &Backend) -> Result<Self, &'static str> {
        let config = match backend {
            Backend::Custom { endpoint } => endpoint.clone(),
            preset => presets()
                .iter()
                .find(|item| Some(item.id) == preset.preset_id())
                .expect("known search preset")
                .endpoint
                .clone(),
        };
        let url = Url::parse(&config.url).map_err(|_| "Enter a valid HTTP or HTTPS search URL.")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("Enter an HTTP or HTTPS search URL without credentials or a fragment.");
        }
        let mut query = url
            .query_pairs()
            .map(|(name, _)| name.into_owned())
            .chain(config.url_parameters.keys().cloned())
            .collect::<std::collections::BTreeSet<_>>();
        let mut body = config
            .body
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        for (location, name) in std::iter::once(&config.query)
            .chain(config.limit.as_ref())
            .map(|parameter| (parameter.location, parameter.name.as_str()))
            .chain(config.auth.iter().filter_map(|auth| {
                let location = match auth.location {
                    AuthLocation::Header => return None,
                    AuthLocation::Query => ParameterLocation::Query,
                    AuthLocation::Body => ParameterLocation::Body,
                };
                Some((location, auth.name.as_str()))
            }))
        {
            let names = match location {
                ParameterLocation::Query => &mut query,
                ParameterLocation::Body => &mut body,
            };
            if name.trim().is_empty()
                || name.chars().any(char::is_control)
                || !names.insert(name.into())
            {
                return Err(
                    "Query, result limit, and authentication parameters must have distinct names in each location.",
                );
            }
        }
        if config.method == Method::Get && !body.is_empty() {
            return Err("GET search requests cannot have a JSON body.");
        }
        if let Some(auth) = &config.auth
            && auth.location == AuthLocation::Header
            && (auth.name.is_empty()
                || !auth
                    .name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^`_|~".contains(&byte))
                || matches!(
                    auth.name.to_ascii_lowercase().as_str(),
                    "host"
                        | "connection"
                        | "content-length"
                        | "transfer-encoding"
                        | "upgrade"
                        | "proxy-authorization"
                        | "proxy-connection"
                        | "content-type"
                        | "accept"
                )
                || auth.prefix.bytes().any(|byte| byte.is_ascii_control()))
        {
            return Err("Enter a valid authentication header name and prefix.");
        }
        let pointer = |value: &str| value.is_empty() || value.starts_with('/');
        if !pointer(&config.results.list)
            || config.results.url.is_empty()
            || !pointer(&config.results.url)
            || config
                .results
                .title
                .as_deref()
                .is_some_and(|value| !pointer(value))
            || config
                .results
                .snippet
                .as_deref()
                .is_some_and(|value| !pointer(value))
        {
            return Err("Use JSON pointers such as /results and /url for the result fields.");
        }
        let destination = maka_sandbox::Destination::new(
            url.host_str().expect("validated search host"),
            url.port_or_known_default().expect("validated search port"),
        )
        .map_err(|_| "Enter a valid search host and port.")?;
        Ok(Self {
            config,
            url,
            destination,
        })
    }

    pub fn credential_key(&self, backend: &Backend) -> Option<String> {
        let auth = self.config.auth.as_ref()?;
        Some(match backend.preset_id() {
            Some(id) => id.into(),
            None => maka_agent_facts::artifact::content_digest(
                &serde_json::to_vec(&(self.url.as_str(), auth))
                    .expect("search credential identity"),
            ),
        })
    }

    pub fn request(
        &self,
        secret: Option<&str>,
        input: &Query,
    ) -> Result<maka_capabilities::http::Request, super::Error> {
        let mut url = self.url.clone();
        if !self.config.url_parameters.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(&self.config.url_parameters);
        }
        let mut body = self.config.body.clone();
        let mut headers = vec![("Accept".into(), "application/json".into())];
        let mut add_parameter = |location, name: &str, value: Value| match location {
            ParameterLocation::Query => {
                let serialized;
                let text = if let Some(value) = value.as_str() {
                    value
                } else {
                    serialized = value.to_string();
                    &serialized
                };
                url.query_pairs_mut().append_pair(name, text);
            }
            ParameterLocation::Body => {
                body.insert(name.into(), value);
            }
        };
        add_parameter(
            self.config.query.location,
            &self.config.query.name,
            json!(input.query),
        );
        if let Some(limit) = &self.config.limit {
            add_parameter(limit.location, &limit.name, json!(input.limit));
        }
        if let Some(auth) = &self.config.auth {
            let value = format!(
                "{}{}",
                auth.prefix,
                secret.ok_or(super::Error::NotConfigured)?
            );
            match auth.location {
                AuthLocation::Header => headers.push((auth.name.clone(), value)),
                AuthLocation::Query => {
                    add_parameter(ParameterLocation::Query, &auth.name, json!(value))
                }
                AuthLocation::Body => {
                    add_parameter(ParameterLocation::Body, &auth.name, json!(value))
                }
            }
        }
        let (method, body) = match self.config.method {
            Method::Get => (maka_plugin_core::http::Method::Get, Vec::new()),
            Method::Post => {
                headers.push(("Content-Type".into(), "application/json".into()));
                (
                    maka_plugin_core::http::Method::Post,
                    serde_json::to_vec(&body).expect("JSON search body"),
                )
            }
        };
        Ok(maka_capabilities::http::Request {
            url: url.into(),
            method,
            headers,
            body: body.into(),
        })
    }
}
