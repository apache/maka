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

//! Explicit package URL installation. Method admission authorizes this download;
//! downloaded packages still pass the ordinary immutable bundle validator.
use super::*;
use maka_plugin_core::deployment::management::PackageUrlInstall;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid package URL")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("package URL must be HTTP(S), without embedded credentials or fragment".into());
    }
    Ok(url)
}
/// Complete download for an explicitly requested bundle. Uses the operator's
/// HTTP(S)/ALL_PROXY and NO_PROXY environment, like native CLI package fetching.
pub async fn download_bundle(
    address: &str,
    digest: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>> {
    let address = url(address)?;
    if digest.is_some_and(|value| {
        value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err("bundle SHA-256 must contain 64 hexadecimal characters".into());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt
                .previous()
                .iter()
                .any(|previous| previous == attempt.url())
                || url(attempt.url().as_str()).is_err()
                || (attempt
                    .previous()
                    .last()
                    .is_some_and(|previous| previous.scheme() == "https")
                    && attempt.url().scheme() != "https")
            {
                attempt.error("invalid or repeated package redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "package HTTP client unavailable")?;
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("package download cancelled".into()),
        result = async {
            let mut response = client.get(address).send().await.map_err(|_| "package download failed")?;
            if !response.status().is_success() { return Err(format!("package server returned HTTP {}", response.status().as_u16())); }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "package download interrupted")? {
                bytes.try_reserve(chunk.len()).map_err(|_| "package download allocation failed")?;
                bytes.extend_from_slice(&chunk);
            }
            if digest.is_some_and(|expected| !hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(expected)) {
                return Err("bundle SHA-256 mismatch".into());
            }
            Ok(bytes)
        } => result,
    }
}
impl Manager {
    pub(super) async fn install_url(&self, input: Value, context: Context) -> Result<Value> {
        let request: PackageUrlInstall =
            serde_json::from_value(input).map_err(|e| e.to_string())?;
        let metadata = self.metadata().await?;
        if request.expected_revision != metadata.source.reference.revision {
            return conflict(metadata.source.reference.revision);
        }
        let bytes = match download_bundle(
            &request.url,
            request.sha256.as_deref(),
            &context.scope().cancellation,
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(message) => {
                return rejected_diagnostic(ManagementRejection::DownloadFailed, message);
            }
        };
        let mut ticket = context
            .scope()
            .resources
            .reserve()
            .map_err(|e| e.to_string())?;
        ticket.start();
        let package = tokio::task::spawn_blocking(move || {
            let parsed = Package::from_bundle(&bytes);
            ticket.complete(Ok(()));
            parsed
        })
        .await
        .map_err(|_| "package validation worker failed")?;
        let package = match package {
            Ok(package) => package,
            Err(error) => {
                return rejected_diagnostic(ManagementRejection::InvalidBundle, error.to_string());
            }
        };
        let _write = self.writes.lock().await;
        let metadata = self.metadata().await?;
        if request.expected_revision != metadata.source.reference.revision {
            return conflict(metadata.source.reference.revision);
        }
        if context.scope().cancellation.is_cancelled() {
            return Err("package installation cancelled".into());
        }
        self.install_package(request.expected_revision, package, metadata)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(response: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/plugin.maka-plugin",
            listener.local_addr().unwrap()
        );
        let worker = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let mut buffer = [0; 1024];
                let count = stream.read(&mut buffer).await.unwrap();
                assert_ne!(count, 0, "request ended before its headers");
                request.extend_from_slice(&buffer[..count]);
                assert!(request.len() <= 8192);
            }
            stream.write_all(&response).await.unwrap();
        });
        (url, worker)
    }
    #[tokio::test]
    async fn bounded_url_download_checks_status_digest_and_bundle_bytes() {
        let package = Package::new(BTreeMap::from([
            ("maka.extension.json".into(), br#"{"schemaVersion":1,"id":"example.download","application":{"host":{"implementation":{"kind":"javascript","module":"host.mjs","realm":"shared"},"configuration":{"type":"object"},"imports":{},"exports":{}}}}"#.to_vec()),
            ("host.mjs".into(), b"export function activate() { return {}; }".to_vec()),
        ])).unwrap();
        let bytes = package.to_bundle();
        let digest = hex::encode(Sha256::digest(&bytes));
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        )
        .into_bytes();
        response.extend(&bytes);
        let (address, worker) = server(response.clone()).await;
        let downloaded = download_bundle(&address, Some(&digest), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            Package::from_bundle(&downloaded).unwrap().application_ref(),
            package.application_ref()
        );
        worker.await.unwrap();
        let (address, worker) = server(response).await;
        assert!(
            download_bundle(&address, Some(&"0".repeat(64)), &CancellationToken::new())
                .await
                .unwrap_err()
                .contains("mismatch")
        );
        worker.await.unwrap();
        for response in [
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 33554433\r\n\r\n".to_vec(),
        ] {
            let (address, worker) = server(response).await;
            assert!(
                download_bundle(&address, None, &CancellationToken::new())
                    .await
                    .is_err()
            );
            worker.await.unwrap();
        }
        for address in [
            "file:///tmp/plugin",
            "https://user:secret@example.com/plugin",
            "https://example.com/plugin#fragment",
        ] {
            assert!(
                download_bundle(address, None, &CancellationToken::new())
                    .await
                    .is_err()
            );
        }
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(
            download_bundle("http://127.0.0.1:1/plugin", None, &cancel)
                .await
                .unwrap_err()
                .contains("cancelled")
        );
    }
}
