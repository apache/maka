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

//! Replay-aware redirects share Policy authority and settle every upload hop.
use super::*;
use reqwest::{
    Method, Url,
    header::{
        CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, HeaderMap, LOCATION, REFERER,
        TRANSFER_ENCODING,
    },
};

impl Network {
    pub(super) async fn request_http(
        &self,
        request: http::Request,
        cancellation: CancellationToken,
    ) -> Result<http::Response, Error> {
        let cleanup = request.body.cleanup();
        let result = self.request_http_inner(request, cancellation).await;
        if result
            .as_ref()
            .is_err_and(|error| !error.cleanup_unconfirmed())
            && let Some(cleanup) = cleanup
        {
            cleanup.close().await.map_err(|error| {
                tracing::error!(stage = "model_upload_preflight_close", %error, "cleanup unconfirmed");
                cleanup_unconfirmed()
            })?;
        }
        result
    }

    async fn request_http_inner(
        &self,
        request: http::Request,
        cancellation: CancellationToken,
    ) -> Result<http::Response, Error> {
        let mut method = match request.method {
            http::Method::Get => Method::GET,
            http::Method::Head => Method::HEAD,
            http::Method::Post => Method::POST,
            http::Method::Put => Method::PUT,
            http::Method::Patch => Method::PATCH,
            http::Method::Delete => Method::DELETE,
            http::Method::Options => Method::OPTIONS,
        };
        let mut headers = headers(request.headers)?;
        if headers.contains_key(CONTENT_LENGTH) || headers.contains_key(TRANSFER_ENCODING) {
            return Err(Error::Adapter(
                "model HTTP framing is owned by the transport".into(),
            ));
        }
        let mut url = Url::parse(&request.url)
            .map_err(|_| Error::Adapter("invalid model HTTP URL".into()))?;
        let original = url.clone();
        let mut body = Some(request.body);
        let mut replay = body.as_ref().and_then(http::RequestBody::replay_source);
        let mut previous = 0;
        loop {
            let input = body.take().expect("one source per redirect hop");
            let (response, upload) = self
                .send_http(method.clone(), &url, headers.clone(), input, &cancellation)
                .await?;
            let status = response.status().as_u16();
            // reqwest 0.13's tower redirect rules: 301/302 change POST only;
            // 303 drops any body and retains HEAD, otherwise uses GET.
            let discard = matches!(status, 301 | 302) && method == Method::POST || status == 303;
            let redirect =
                matches!(status, 301 | 302 | 303 | 307 | 308) && (discard || replay.is_some());
            let next = redirect
                .then(|| {
                    response
                        .headers()
                        .get(LOCATION)
                        .and_then(|value| std::str::from_utf8(value.as_bytes()).ok())
                        .and_then(|location| url.join(location).ok())
                })
                .flatten();
            if let Some(next) = next {
                let follow = self.policy.follow_redirect(&original, &next, previous + 1);
                match follow {
                    Err(error) => {
                        drop(response);
                        upload.finish().await.map_err(|_| cleanup_unconfirmed())?;
                        return Err(Error::Adapter(error.to_string()));
                    }
                    Ok(true) => {
                        // Drop the redirect response, then confirm that both
                        // its active upload and retained byte slices are gone.
                        drop(response);
                        upload.finish().await.map_err(|_| cleanup_unconfirmed())?;
                        if cancellation.is_cancelled() {
                            return Err(Error::Cancelled);
                        }
                        if discard {
                            if method != Method::HEAD {
                                method = Method::GET;
                            }
                            for name in [
                                TRANSFER_ENCODING,
                                CONTENT_ENCODING,
                                CONTENT_TYPE,
                                CONTENT_LENGTH,
                            ] {
                                headers.remove(name);
                            }
                            body = Some(http::RequestBody::default());
                            replay = body.as_ref().and_then(http::RequestBody::replay_source);
                        } else {
                            body = Some(
                                replay
                                    .as_ref()
                                    .expect("redirect replay source")
                                    .open(cancellation.clone())
                                    .await
                                    .map_err(|error| match error {
                                        http::Error::CleanupUnconfirmed => cleanup_unconfirmed(),
                                        http::Error::Denied => Error::Cancelled,
                                        other => Error::Adapter(other.to_string()),
                                    })?,
                            );
                        }
                        redirect_headers(&mut headers, &url, &next)?;
                        url = next;
                        previous += 1;
                        continue;
                    }
                    Ok(false) => {} // Same-origin policy returns cross-origin redirects unchanged.
                }
            }
            let head = http::Head {
                status: response.status().as_u16(),
                url: response.url().to_string(),
                headers: response
                    .headers()
                    .iter()
                    .map(|(name, value)| (name.to_string(), value.as_bytes().to_vec()))
                    .collect(),
            };
            return Ok(http::Response {
                head,
                body: Arc::new(Body {
                    response: AsyncMutex::new(Some(response)),
                    cancelled: cancellation.child_token(),
                    upload,
                }),
            });
        }
    }
    async fn send_http(
        &self,
        method: Method,
        url: &Url,
        headers: HeaderMap,
        input: http::RequestBody,
        cancellation: &CancellationToken,
    ) -> Result<(reqwest::Response, UploadLease), Error> {
        let cleanup = input.cleanup();
        let result = self
            .send_http_inner(method, url, headers, input, cancellation)
            .await;
        if result
            .as_ref()
            .is_err_and(|error| !error.cleanup_unconfirmed())
            && let Some(cleanup) = cleanup
        {
            cleanup.close().await.map_err(|error| {
                tracing::error!(stage = "model_upload_preflight_close", %error, "cleanup unconfirmed");
                cleanup_unconfirmed()
            })?;
        }
        result
    }

    async fn send_http_inner(
        &self,
        method: Method,
        url: &Url,
        headers: HeaderMap,
        input: http::RequestBody,
        cancellation: &CancellationToken,
    ) -> Result<(reqwest::Response, UploadLease), Error> {
        if cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        self.policy
            .check_request_headers(url, &headers, input.length() != Some(0), true)
            .map_err(|_| Error::Adapter("model HTTP headers cannot be represented".into()))?;
        let connections = maka_network::ConnectionTasks::default();
        let client = self
            .tls
            .build(
                connections
                    .client_builder(self.policy.client_builder())
                    .redirect(reqwest::redirect::Policy::none()),
            )
            .map_err(failure)?;
        let length = input.length();
        let stop = cancellation.child_token();
        let (stream, receipt) = http::upload::track(input, stop.clone());
        let upload = UploadLease {
            connections,
            stop,
            receipt: AsyncMutex::new(receipt),
        };
        // Exact zero is a caller-guaranteed empty source. Keep reqwest's former
        // empty-body framing for GET/HEAD rather than inventing chunked uploads.
        let body = if length == Some(0) {
            drop(stream);
            reqwest::Body::from(Vec::new())
        } else {
            reqwest::Body::wrap_stream(stream)
        };
        let mut pending = client
            .request(method, url.clone())
            .headers(headers)
            .body(body);
        if let Some(length) = length.filter(|length| *length > 0) {
            pending = pending.header(CONTENT_LENGTH, length);
        }
        let response = {
            let sending = pending.send();
            tokio::pin!(sending);
            let mut receipt = upload.receipt.lock().await;
            let close_source = receipt.needs_source_close();
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(Error::Cancelled),
                result = &mut sending => result.map_err(failure),
                released = receipt.source_released(), if close_source => {
                    match released {
                        Ok(()) => {
                            if let Err(error) = receipt.close_source().await {
                                tracing::error!(stage = "model_upload_source_close", %error, "cleanup unconfirmed");
                                Err(cleanup_unconfirmed())
                            } else {
                                tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => Err(Error::Cancelled),
                            result = &mut sending => result.map_err(failure),
                                }
                            }
                        }
                        Err(error) => {
                            tracing::error!(stage = "model_upload_source_close", %error, "cleanup unconfirmed");
                            Err(cleanup_unconfirmed())
                        }
                    }
                }
            }
        };
        match response {
            Ok(response) => Ok((response, upload)),
            Err(error) => {
                upload.finish().await.map_err(|_| cleanup_unconfirmed())?;
                Err(error)
            }
        }
    }
}
fn redirect_headers(headers: &mut HeaderMap, previous: &Url, next: &Url) -> Result<(), Error> {
    // Policy currently refuses every cross-origin hop. Keep credential stripping
    // here as well so a future policy expansion cannot forward old credentials.
    if previous.origin() != next.origin() {
        for name in [
            "authorization",
            "cookie",
            "cookie2",
            "proxy-authorization",
            "www-authenticate",
        ] {
            headers.remove(name);
        }
    }
    if !(previous.scheme() == "https" && next.scheme() == "http") {
        let mut referer = previous.clone();
        let _ = referer.set_username("");
        let _ = referer.set_password(None);
        referer.set_fragment(None);
        if let Ok(value) = referer.as_str().parse() {
            headers
                .try_insert(REFERER, value)
                .map_err(|_| Error::Adapter("model HTTP headers cannot be represented".into()))?;
        }
    }
    Ok(())
}
