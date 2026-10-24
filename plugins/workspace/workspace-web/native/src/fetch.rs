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

use maka_capabilities::call;
use maka_capabilities::http;
use std::sync::Arc;
use url::{Host, Url};

mod document;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid WebFetch URL: {0}")]
    Url(String),
    #[error("WebFetch does not access cloud metadata endpoints")]
    Metadata,
    #[error("WebFetch was cancelled")]
    Cancelled,
    #[error("WebFetch redirect contains a cycle")]
    Redirects,
    #[error("WebFetch redirect has no valid Location")]
    Location,
    #[error("WebFetch failed with HTTP {0}")]
    Status(u16),
    #[error("WebFetch cannot extract this content type: {0}")]
    ContentType(String),
    #[error("WebFetch returned no readable content")]
    Empty,
    #[error("WebFetch document extraction failed: {0}")]
    Document(String),
    #[error(transparent)]
    Http(#[from] http::Error),
    #[error(transparent)]
    Settlement(#[from] maka_agent_facts::tools::ToolError),
}

use maka_web_api::fetch::{Format, Page};

#[derive(Clone)]
pub struct Fetcher {
    http: Arc<dyn http::Client>,
}

impl Fetcher {
    pub fn new(http: Arc<dyn http::Client>) -> Self {
        Self { http }
    }

    pub async fn fetch(&self, parent: &call::Scope, url: &str) -> Result<Page, Error> {
        let url = checked_url(url)?;
        let owned = call::Owned::new(parent.child()?);
        let scope = owned.scope();
        let result = tokio::select! {
            biased;
            _ = scope.cancellation.cancelled() => Err(Error::Cancelled),
            result = self.follow(&scope, url) => result,
        };
        // Cancel and settle even when the future is dropped during response headers.
        // Unconfirmed cleanup takes precedence over an ordinary fetch failure.
        owned.finish().await?;
        result
    }

    async fn follow(&self, scope: &call::Scope, mut url: Url) -> Result<Page, Error> {
        let mut visited = std::collections::HashSet::new();
        loop {
            if !visited.insert(url.to_string()) {
                return Err(Error::Redirects);
            }
            let response = self.http.request(scope.clone(), http::Request {
                url: url.to_string(),
                method: http::Method::Get,
                headers: vec![
                    ("Accept".into(), "text/markdown, text/plain;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.8".into()),
                    ("User-Agent".into(), concat!("Maka/", env!("CARGO_PKG_VERSION"), " WebFetch").into()),
                ],
                body: Default::default(),
            }).await?;
            // A Host transport must not follow redirects on the plugin's behalf.
            // Resolve links against this validated response URL.
            let final_url = checked_url(&response.head.url);
            let status = response.head.status;
            let result = async {
                let final_url = final_url?;
                if matches!(status, 301 | 302 | 303 | 307 | 308) {
                    let location = header(&response.head, "location").ok_or(Error::Location)?;
                    let target = final_url.join(location).map_err(|_| Error::Location)?;
                    return Ok(Fetched::Redirect(checked_url(target.as_str())?));
                }
                if !(200..300).contains(&status) {
                    return Err(Error::Status(status));
                }
                let content_type = header(&response.head, "content-type")
                    .unwrap_or("text/plain")
                    .to_owned();
                let media = document::media_type(&content_type)?;
                let mut bytes = Vec::new();
                while let Some(chunk) = response.body.next().await? {
                    bytes.extend_from_slice(&chunk);
                }
                Ok(Fetched::Content {
                    url: final_url,
                    bytes,
                    content_type,
                    media,
                })
            }
            .await;
            // Redirect/error bodies are closed without downloading them.
            response.body.close().await?;
            match result? {
                Fetched::Redirect(next) => url = next,
                Fetched::Content {
                    url,
                    bytes,
                    content_type,
                    media,
                } => {
                    return document::extract(url, bytes, &content_type, media).await;
                }
            }
        }
    }
}

enum Fetched {
    Redirect(Url),
    Content {
        url: Url,
        bytes: Vec<u8>,
        content_type: String,
        media: document::Media,
    },
}

fn header<'a>(head: &'a http::Head, name: &str) -> Option<&'a str> {
    head.headers.iter().find_map(|(key, value)| {
        key.eq_ignore_ascii_case(name)
            .then(|| std::str::from_utf8(value).ok())
            .flatten()
    })
}

/// Local documentation servers are allowed. This is a metadata denylist, not a
/// claim of DNS-rebinding protection or a replacement for Host network policy.
pub(crate) fn checked_url(input: &str) -> Result<Url, Error> {
    let mut url = Url::parse(input).map_err(|error| Error::Url(error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::Url(
            "use HTTP(S) without embedded credentials".into(),
        ));
    }
    let metadata = match url.host() {
        Some(Host::Ipv4(address)) => metadata_v4(address),
        Some(Host::Ipv6(address)) => {
            address.to_ipv4_mapped().is_some_and(metadata_v4)
                || matches!(
                    address.segments(),
                    [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254 | 0x23]
                )
        }
        Some(Host::Domain(name)) => matches!(
            name.trim_end_matches('.'),
            "instance-data.ec2.internal"
                | "metadata.google.internal"
                | "metadata.goog"
                | "metadata.tencentyun.com"
        ),
        None => false,
    };
    if metadata {
        return Err(Error::Metadata);
    }
    url.set_fragment(None);
    Ok(url)
}

fn metadata_v4(address: std::net::Ipv4Addr) -> bool {
    matches!(
        address.octets(),
        [169, 254, 169, 254] | [169, 254, 170, 2 | 23] | [100, 100, 100, 200]
    )
}
