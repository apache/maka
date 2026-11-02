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

mod archive;
mod target;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use clap::Args;
use maka_event_log::root::{RootNamespaces, private_directory};
use maka_host_runtime::HostError;
use reqwest::{Client, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use target::Target;
use tempfile::NamedTempFile;
use tokio::io::AsyncWriteExt;

const REGISTRY: &str = "https://registry.npmjs.org/";

#[derive(Args, Clone)]
pub(super) struct Fetch {
    /// Target OS and architecture, not the machine performing the download.
    #[arg(long, value_enum)]
    target: Target,
    /// Exact npm release version; tags and version ranges are not accepted.
    #[arg(long)]
    version: Version,
    /// Private artifact cache (defaults to this account's Maka native-cli directory).
    #[arg(long)]
    cache: Option<PathBuf>,
    /// Import a local package through the same validation path (no registry access).
    #[arg(long, requires = "integrity", conflicts_with = "directory")]
    archive: Option<PathBuf>,
    /// Expected `sha512-<base64>` of the local package, supplied by its trusted source.
    #[arg(long, requires = "archive")]
    integrity: Option<String>,
    /// Import a previously verified directory delivered over a trusted transport.
    #[arg(long, requires = "receipt_sha256", conflicts_with = "archive")]
    directory: Option<PathBuf>,
    /// SHA-256 of receipt.json, obtained from the verifying downloader, not the upload.
    #[arg(long, requires = "directory", value_parser = receipt_digest)]
    receipt_sha256: Option<String>,
    /// Reserve the result line for interactive launchers.
    #[arg(long)]
    framed: bool,
}

#[derive(Deserialize)]
struct RegistryPackage {
    name: String,
    version: String,
    dist: Distribution,
}

#[derive(Deserialize)]
struct Distribution {
    tarball: Url,
    integrity: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Artifact {
    target: Target,
    version: String,
    directory: PathBuf,
    pub(crate) executable: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_executable: Option<PathBuf>,
    integrity: String,
}

impl Fetch {
    async fn resolve_with_retry(
        self,
        client: Client,
        registry: Url,
    ) -> Result<Artifact, HostError> {
        for attempt in 0..3 {
            crate::operation::check()?;
            match self.clone().resolve(client.clone(), registry.clone()).await {
                Ok(artifact) => return Ok(artifact),
                Err(error) if attempt < 2 && transient_download_error(&error) => {
                    tokio::time::sleep(crate::operation::remaining(Duration::from_millis(
                        250 << attempt,
                    )))
                    .await;
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!()
    }

    pub async fn run(self) -> Result<(), HostError> {
        let framed = self.framed;
        // Honor the CLI environment's HTTP(S)/ALL_PROXY and NO_PROXY. No npm,
        // lifecycle scripts, registry credentials, or running Host are involved.
        let client = client()?;
        let artifact = self
            .resolve_with_retry(client, Url::parse(REGISTRY)?)
            .await?;
        let prefix = if framed {
            "__MAKA_NATIVE_HOST_ARTIFACT__"
        } else {
            ""
        };
        println!("{prefix}{}", serde_json::to_string(&artifact)?);
        Ok(())
    }

    async fn resolve(self, client: Client, registry: Url) -> Result<Artifact, HostError> {
        use crate::operation::{Phase, progress};
        crate::operation::check()?;
        progress(Phase::Verify, None, None);
        let target = self.target;
        let version = self.version.to_string();
        if let Some(integrity) = &self.integrity {
            decode_integrity(integrity)?;
        }
        let name = target.package_name();
        let cache = match self.cache {
            Some(cache) => cache,
            None => RootNamespaces::for_current_account()?
                .ownership
                .parent()
                .ok_or("missing account data directory")?
                .join("native-cli"),
        };
        let entry = format!("{}@{version}", target.slug());
        let importing_directory = self.directory.is_some();
        let (cache, destination, existing) = tokio::task::spawn_blocking({
            let version = version.clone();
            move || -> Result<_, HostError> {
                private_directory(&cache)?;
                let cache = cache.canonicalize()?;
                let destination = cache.join(entry);
                let existing = if importing_directory {
                    None
                } else {
                    archive::cached(&destination, target, &version)?
                };
                Ok((cache, destination, existing))
            }
        })
        .await??;
        // An explicit directory import must authenticate its receipt even on a
        // cache hit; otherwise another package with the same version could win.
        if let Some(source) = self.directory {
            let receipt_sha256 = self
                .receipt_sha256
                .ok_or("directory import requires a receipt digest")?;
            return tokio::task::spawn_blocking(move || {
                let integrity = archive::import_directory(
                    &source,
                    &receipt_sha256,
                    &cache,
                    &destination,
                    target,
                    &version,
                )?;
                Ok(artifact(destination, target, version, integrity))
            })
            .await?;
        }
        if let Some(integrity) = existing {
            if self
                .integrity
                .as_ref()
                .is_some_and(|expected| *expected != integrity)
            {
                return Err(
                    "cached package differs from the requested local archive integrity".into(),
                );
            }
            return Ok(artifact(destination, target, version, integrity));
        }

        if let Some(source) = self.archive {
            let integrity = self.integrity.ok_or("local archive requires integrity")?;
            return tokio::task::spawn_blocking(move || {
                use std::io::{Read, Write};
                let mut source = regular_file(&source)?;
                let mut temporary = NamedTempFile::new_in(&cache)?;
                let mut hash = Sha512::new();
                let mut buffer = [0; 64 * 1024];
                loop {
                    let read = source.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    hash.update(&buffer[..read]);
                    temporary.write_all(&buffer[..read])?;
                }
                if hash.finalize().as_slice() != decode_integrity(&integrity)? {
                    return Err("native package archive integrity mismatch".into());
                }
                archive::publish(
                    temporary,
                    &cache,
                    &destination,
                    target,
                    &version,
                    &integrity,
                )?;
                Ok(artifact(destination, target, version, integrity))
            })
            .await?;
        }

        let url = registry.join(&format!("{name}/{version}"))?;
        progress(Phase::Download, Some(0), None);
        let mut response = download_response(client.get(url)).await?;
        if !response.status().is_success() {
            return Err("native package registry redirect is not allowed".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = tokio::time::timeout(
            crate::operation::remaining(Duration::from_secs(15)),
            response.chunk(),
        )
        .await??
        {
            bytes.try_reserve(chunk.len())?;
            bytes.extend_from_slice(&chunk);
        }
        let package: RegistryPackage = serde_json::from_slice(&bytes)?;
        if package.name != name || package.version != version {
            return Err("registry returned a different native package or version".into());
        }
        let integrity = package.dist.integrity;
        let expected = decode_integrity(&integrity)?;
        // The trusted registry cannot turn this command into an arbitrary URL
        // downloader, nor forward proxy credentials through redirects.
        if package.dist.tarball.origin() != registry.origin()
            || !package.dist.tarball.username().is_empty()
            || package.dist.tarball.password().is_some()
            || package.dist.tarball.fragment().is_some()
        {
            return Err("native package tarball must belong to the npm registry origin".into());
        }
        let mut response = download_response(client.get(package.dist.tarball)).await?;
        if !response.status().is_success() {
            return Err("native package archive redirect is not allowed".into());
        }
        let temporary = NamedTempFile::new_in(&cache)?;
        let mut output = tokio::fs::File::from_std(temporary.reopen()?);
        let mut hash = Sha512::new();
        let mut size = 0_u64;
        let total = response.content_length();
        let mut reported = tokio::time::Instant::now();
        progress(Phase::Download, Some(0), total);
        while let Some(chunk) = tokio::time::timeout(
            crate::operation::remaining(Duration::from_secs(15)),
            response.chunk(),
        )
        .await??
        {
            size = size
                .checked_add(chunk.len() as u64)
                .ok_or("archive length overflow")?;
            hash.update(&chunk);
            output.write_all(&chunk).await?;
            if reported.elapsed() >= Duration::from_millis(250) {
                progress(Phase::Download, Some(size), total);
                reported = tokio::time::Instant::now();
            }
        }
        output.flush().await?;
        drop(output);
        progress(Phase::Verify, Some(size), total);
        if hash.finalize().as_slice() != expected {
            return Err("native package archive integrity mismatch".into());
        }
        crate::operation::check()?;
        progress(Phase::Stage, None, None);
        tokio::task::spawn_blocking({
            let version = version.clone();
            let integrity = integrity.clone();
            let destination = destination.clone();
            move || {
                archive::publish(
                    temporary,
                    &cache,
                    &destination,
                    target,
                    &version,
                    &integrity,
                )
            }
        })
        .await??;
        Ok(artifact(destination, target, version, integrity))
    }
}

async fn download_response(
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, HostError> {
    Ok(tokio::time::timeout(
        crate::operation::remaining(Duration::from_secs(15)),
        request.send(),
    )
    .await??
    .error_for_status()?)
}

fn transient_download_error(error: &HostError) -> bool {
    error.is::<tokio::time::error::Elapsed>()
        || error.downcast_ref::<reqwest::Error>().is_some_and(|error| {
            error.is_connect()
                || error.is_timeout()
                || error.status().is_some_and(|status| {
                    matches!(status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504)
                })
        })
}

fn client() -> Result<Client, HostError> {
    Ok(Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

#[cfg(windows)]
pub(crate) fn validate_windows_service(path: &Path) -> Result<(), HostError> {
    Target::Win32X64.validate_binary(&mut regular_file(path)?, true)
}

/// Resolve the preview channel once; subsequent retries use this exact version.
pub(crate) async fn preview_version() -> Result<Version, HostError> {
    #[derive(Deserialize)]
    struct Tags {
        #[serde(rename = "rust-preview")]
        preview: String,
    }
    let name = Target::current()?.package_name().replace('/', "%2f");
    let mut response = client()?
        .get(format!("{REGISTRY}-/package/{name}/dist-tags"))
        .send()
        .await?
        .error_for_status()?;
    if !response.status().is_success() {
        return Err("native package registry redirect is not allowed".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        bytes.try_reserve(chunk.len())?;
        bytes.extend_from_slice(&chunk);
    }
    let tags: Tags = serde_json::from_slice(&bytes)?;
    let version = Version::parse(&tags.preview)?;
    if !version.pre.as_str().starts_with("rust-preview.") || !version.build.is_empty() {
        return Err("rust-preview points outside the native preview channel".into());
    }
    Ok(version)
}

pub(crate) async fn fetch(version: Version) -> Result<Artifact, HostError> {
    fetch_target(Target::current()?, version).await
}

async fn fetch_target(target: Target, version: Version) -> Result<Artifact, HostError> {
    let fetch = Fetch {
        target,
        version,
        cache: None,
        archive: None,
        integrity: None,
        directory: None,
        receipt_sha256: None,
        framed: false,
    };
    fetch
        .resolve_with_retry(client()?, Url::parse(REGISTRY)?)
        .await
}

/// Resolve the Windows component of this exact native release. Never follow
/// a moving dist-tag or run a separately installed, potentially stale CLI.
pub(crate) fn windows_helper() -> maka_agent_facts::tools::ToolFuture<PathBuf> {
    Box::pin(async {
        let version = option_env!("MAKA_NATIVE_PACKAGE_VERSION")
            .ok_or_else(|| maka_agent_facts::tools::ToolError::Failed("this source build has no native release identity; development hosts must provide MAKA_CUA_WINDOWS_EXECUTABLE".into()))?;
        let version = Version::parse(version)
            .map_err(|error| maka_agent_facts::tools::ToolError::Failed(error.to_string()))?;
        crate::operation::without_progress(async {
            fetch_target(Target::Win32X64, version)
                .await
                .map(|artifact| artifact.executable)
                .map_err(|error| {
                    maka_agent_facts::tools::ToolError::Failed(format!(
                        "Windows desktop component could not be prepared: {error}"
                    ))
                })
        })
        .await
    })
}

fn receipt_digest(value: &str) -> Result<String, &'static str> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(value.into())
    } else {
        Err("receipt digest must contain 64 lowercase hexadecimal characters")
    }
}

fn decode_integrity(value: &str) -> Result<[u8; 64], HostError> {
    let encoded = value
        .strip_prefix("sha512-")
        .ok_or("native package requires SHA-512 integrity")?;
    let bytes: [u8; 64] = STANDARD
        .decode(encoded)?
        .try_into()
        .map_err(|_| "invalid native package SHA-512 integrity")?;
    if STANDARD.encode(bytes) != encoded {
        return Err("noncanonical native package integrity".into());
    }
    Ok(bytes)
}

fn artifact(directory: PathBuf, target: Target, version: String, integrity: String) -> Artifact {
    Artifact {
        target,
        version,
        executable: directory.join(target.executable()),
        service_executable: target.service_executable().map(|name| directory.join(name)),
        directory,
        integrity,
    }
}

fn regular_file(path: &Path) -> Result<std::fs::File, HostError> {
    let metadata = path.symlink_metadata()?;
    if !metadata.is_file() {
        return Err("native package cache contains a non-file entry".into());
    }
    Ok(std::fs::File::open(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;
    use tokio::{io::AsyncReadExt, net::TcpListener};

    #[tokio::test]
    async fn stalled_registry_exhausts_one_deadline_without_publishing_or_retrying_forever() {
        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let started = tokio::time::Instant::now();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut byte = [0; 1];
            socket.read_exact(&mut byte).await.unwrap();
            // Headers arrive, but the declared body never completes.
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n{")
                .await
                .unwrap();
            std::future::pending::<()>().await;
        });
        let result = crate::operation::scope(
            Duration::from_millis(100),
            request(Target::current().unwrap(), root.path())
                .resolve_with_retry(client().unwrap(), origin),
        )
        .await;
        server.abort();
        let _ = server.await;
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!root.path().join("receipt.json").exists());
    }

    fn package(
        target: Target,
        extra: Option<&str>,
        desktop_gui: Option<bool>,
        omitted: Option<&str>,
    ) -> Vec<u8> {
        let manifest = serde_json::json!({
            "name": target.package_name(), "version": "1.2.3",
            "os": [target.os()], "cpu": [target.cpu()],
            "libc": if target.os() == "linux" { vec!["glibc"] } else { vec![] },
        });
        let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
        let mut append = |name: &str, bytes: &[u8]| {
            if omitted == Some(name) {
                return;
            }
            let mut header = tar::Header::new_ustar();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            if name.ends_with('/') {
                // A directory entry keeps its trailing slash, as npm writes it.
                let path = format!("package/{name}");
                header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
                header.set_entry_type(tar::EntryType::Directory);
                header.set_cksum();
                tar.append(&header, bytes).unwrap();
            } else {
                header.set_cksum();
                tar.append_data(&mut header, format!("package/{name}"), bytes)
                    .unwrap();
            }
        };
        append("package.json", &serde_json::to_vec(&manifest).unwrap());
        for name in [
            "DISCLAIMER",
            "LICENSE",
            "NOTICE",
            "THIRD_PARTY_NOTICES.txt",
            "README.md",
            "README.zh-CN.md",
        ] {
            append(name, b"test license");
        }
        let mut binary = [0; 256];
        match target {
            Target::DarwinArm64 | Target::DarwinX64 => {
                binary[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
                let cpu: u32 = if target.cpu() == "arm64" {
                    0x0100_000c
                } else {
                    0x0100_0007
                };
                binary[4..8].copy_from_slice(&cpu.to_le_bytes());
                binary[12..16].copy_from_slice(&2_u32.to_le_bytes());
            }
            Target::LinuxArm64Gnu | Target::LinuxX64Gnu => {
                binary[..6].copy_from_slice(&[0x7f, b'E', b'L', b'F', 2, 1]);
                binary[16..18].copy_from_slice(&3_u16.to_le_bytes());
                let machine: u16 = if target.cpu() == "arm64" { 183 } else { 62 };
                binary[18..20].copy_from_slice(&machine.to_le_bytes());
            }
            Target::Win32X64 => {
                binary[..2].copy_from_slice(b"MZ");
                binary[60..64].copy_from_slice(&64_u32.to_le_bytes());
                binary[64..68].copy_from_slice(b"PE\0\0");
                binary[68..70].copy_from_slice(&0x8664_u16.to_le_bytes());
                binary[88..90].copy_from_slice(&0x20b_u16.to_le_bytes());
                binary[156..158].copy_from_slice(&3_u16.to_le_bytes());
            }
        }
        append(target.executable(), &binary);
        append(target.python_worker(), &binary);
        if let Some(gui) = desktop_gui {
            if target == Target::Win32X64 {
                binary[156..158].copy_from_slice(&(if gui { 2_u16 } else { 3_u16 }).to_le_bytes());
            }
            append(target.desktop_executable(), &binary);
        }
        if let Some(service) = target.service_executable() {
            binary[156..158].copy_from_slice(&2_u16.to_le_bytes());
            append(service, &binary);
        }
        if target.os() == "darwin" {
            append(
                "bin/Maka.app/Contents/Info.plist",
                b"<plist version=\"1.0\"/>\n",
            );
            append("bin/Maka.app/Contents/Resources/Maka.icns", b"icns");
            for name in ["DISCLAIMER", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"] {
                append(
                    &format!("bin/Maka.app/Contents/Resources/{name}"),
                    b"test license",
                );
            }
        }
        if let Some(name) = extra {
            append(
                name,
                if name.ends_with('/') {
                    &b""[..]
                } else {
                    b"not an executable"
                },
            );
        }
        tar.into_inner().unwrap().finish().unwrap()
    }

    async fn registry(target: Target, bytes: Vec<u8>, integrity: String) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let tarball = origin.join("native.tgz").unwrap();
        tokio::spawn(async move {
            let metadata = serde_json::to_vec(&serde_json::json!({
                "name": target.package_name(), "version": "1.2.3",
                "dist": { "tarball": tarball, "integrity": integrity },
            }))
            .unwrap();
            for (path, body) in [
                (format!("/{}/1.2.3", target.package_name()), metadata),
                ("/native.tgz".into(), bytes),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(socket.read_u8().await.unwrap());
                    assert!(request.len() < 8192);
                }
                assert!(
                    request.starts_with(format!("GET {path} HTTP/1.1\r\n").as_bytes()),
                    "native downloads must request the exact release, never a moving tag"
                );
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len(),
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(&body).await.unwrap();
            }
        });
        origin
    }

    fn request(target: Target, cache: &Path) -> Fetch {
        Fetch {
            target,
            version: Version::parse("1.2.3").unwrap(),
            cache: Some(cache.join("cache")),
            archive: None,
            integrity: None,
            directory: None,
            receipt_sha256: None,
            framed: false,
        }
    }

    #[tokio::test]
    async fn verifies_all_targets_and_reuses_cache_offline_without_trusting_modified_files() {
        for target in [
            Target::DarwinArm64,
            Target::DarwinX64,
            Target::LinuxArm64Gnu,
            Target::LinuxX64Gnu,
            Target::Win32X64,
        ] {
            let root = tempfile::tempdir().unwrap();
            let bytes = package(target, None, Some(true), None);
            let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(&bytes)));
            let registry = registry(target, bytes, integrity.clone()).await;
            let client = Client::builder().no_proxy().build().unwrap();
            let artifact = request(target, root.path())
                .resolve(client.clone(), registry)
                .await
                .unwrap();
            assert_eq!(artifact.integrity, integrity);
            assert!(artifact.executable.is_file());
            assert!(artifact.directory.join(target.python_worker()).is_file());
            let desktop = artifact.directory.join(target.desktop_executable());
            assert!(desktop.is_file());
            let offline = Url::parse("http://127.0.0.1:1/").unwrap();
            let reused = request(target, root.path())
                .resolve(client.clone(), offline.clone())
                .await
                .unwrap();
            assert_eq!(artifact.directory, reused.directory);
            let receipt = std::fs::read(artifact.directory.join("receipt.json")).unwrap();
            let recorded: serde_json::Value = serde_json::from_slice(&receipt).unwrap();
            assert_eq!(
                recorded["files"]["NOTICE"],
                serde_json::json!({
                    "size":12,
                    "sha256":hex::encode(sha2::Sha256::digest(b"test license"))
                })
            );
            let receipt_sha256 = hex::encode(sha2::Sha256::digest(&receipt));
            let transferred = |cache: &str, digest: String| Fetch {
                directory: Some(artifact.directory.clone()),
                receipt_sha256: Some(digest),
                ..request(target, &root.path().join(cache))
            };
            let copied = transferred("transferred", receipt_sha256.clone())
                .resolve(client.clone(), offline.clone())
                .await
                .unwrap();
            assert_ne!(copied.directory, artifact.directory);
            assert_eq!(
                std::fs::read(copied.directory.join("receipt.json")).unwrap(),
                receipt
            );
            assert_eq!(
                std::fs::read(copied.directory.join("NOTICE")).unwrap(),
                b"test license"
            );
            assert_eq!(
                transferred("transferred", receipt_sha256.clone())
                    .resolve(client.clone(), offline.clone())
                    .await
                    .unwrap()
                    .directory,
                copied.directory
            );
            assert!(
                transferred("transferred", "0".repeat(64))
                    .resolve(client.clone(), offline.clone())
                    .await
                    .is_err(),
                "cache hit must authenticate the supplied receipt"
            );
            // macOS reads more of a bundle than the members it requires.
            let extras: &[(&str, &str)] = if target.os() == "darwin" {
                &[
                    (
                        "bin/Maka.app/Contents/Resources/injected.icns",
                        "filtered-bundle",
                    ),
                    (
                        "bin/Maka.app/Contents/Frameworks/injected.dylib",
                        "filtered-nested",
                    ),
                ]
            } else {
                &[]
            };
            for &(extra, cache) in extras {
                let path = artifact.directory.join(extra);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, b"unrecorded").unwrap();
                let error = request(target, root.path())
                    .resolve(client.clone(), offline.clone())
                    .await
                    .err()
                    .unwrap();
                assert!(error.to_string().contains("unrecorded"), "{error}");
                let filtered = transferred(cache, receipt_sha256.clone())
                    .resolve(client.clone(), offline.clone())
                    .await
                    .unwrap();
                assert!(!filtered.directory.join(extra).exists());
                assert_eq!(
                    std::fs::read(filtered.directory.join("receipt.json")).unwrap(),
                    receipt
                );
                std::fs::remove_file(path).unwrap();
                assert_eq!(
                    request(target, root.path())
                        .resolve(client.clone(), offline.clone())
                        .await
                        .unwrap()
                        .directory,
                    artifact.directory
                );
            }
            #[cfg(unix)]
            if target.os() == "darwin" {
                let extra = artifact
                    .directory
                    .join("bin/Maka.app/Contents/Resources/unrecorded-link.icns");
                std::os::unix::fs::symlink(root.path().join("outside-missing"), &extra).unwrap();
                assert!(
                    request(target, root.path())
                        .resolve(client.clone(), offline.clone())
                        .await
                        .is_err()
                );
                std::fs::remove_file(extra).unwrap();
                assert_eq!(
                    request(target, root.path())
                        .resolve(client.clone(), offline.clone())
                        .await
                        .unwrap()
                        .directory,
                    artifact.directory
                );
            }
            assert_eq!(
                std::fs::read(artifact.directory.join("receipt.json")).unwrap(),
                receipt
            );
            let notice = artifact.directory.join("NOTICE");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&notice, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
            std::fs::write(&notice, b"changed notice").unwrap();
            assert!(
                transferred("corrupted-notice", receipt_sha256.clone())
                    .resolve(client.clone(), offline.clone())
                    .await
                    .is_err()
            );
            assert_eq!(
                std::fs::read_dir(root.path().join("corrupted-notice/cache"))
                    .unwrap()
                    .count(),
                0
            );
            let error = request(target, root.path())
                .resolve(client.clone(), offline.clone())
                .await
                .err()
                .unwrap();
            assert!(error.to_string().contains("cache integrity mismatch"));
            std::fs::write(&notice, b"test license").unwrap();
            assert_eq!(
                std::fs::read(artifact.directory.join("receipt.json")).unwrap(),
                receipt
            );
            assert_eq!(
                request(target, root.path())
                    .resolve(client.clone(), offline.clone())
                    .await
                    .unwrap()
                    .directory,
                artifact.directory
            );
        }
    }

    #[test]
    fn accepts_directory_entries_only_for_parents_of_required_members() {
        let linux = Target::LinuxX64Gnu;
        let macos = Target::DarwinArm64;
        for (target, directory, accepted) in [
            (linux, "bin/", true),
            (linux, "bin/app/", false),
            (macos, "bin/Maka.app/Contents/", true),
            (macos, "bin/Maka.app/Contents/Resources/app/", false),
        ] {
            let root = tempfile::tempdir().unwrap();
            let mut temporary = NamedTempFile::new_in(root.path()).unwrap();
            temporary
                .write_all(&package(target, Some(directory), Some(true), None))
                .unwrap();
            let destination = root.path().join("published");
            let result = archive::publish(
                temporary,
                root.path(),
                &destination,
                target,
                "1.2.3",
                "unused",
            );
            assert_eq!(result.is_ok(), accepted, "{directory}: {result:?}");
            assert_eq!(destination.exists(), accepted);
        }
    }

    #[tokio::test]
    async fn rejects_bad_integrity_and_archive_members_without_publishing_a_cache_entry() {
        let linux = Target::LinuxX64Gnu;
        let macos = Target::DarwinArm64;
        for (target, extra, bad_hash, omitted) in [
            (linux, None, true, None),
            (linux, Some("bin/maka"), false, None),
            (linux, Some("bin/extra"), false, None),
            (linux, None, false, Some("DISCLAIMER")),
            (linux, None, false, Some("bin/maka-python-worker")),
            (
                Target::Win32X64,
                None,
                false,
                Some("bin/maka-python-worker.exe"),
            ),
            (macos, None, false, Some("bin/Maka.app/Contents/Info.plist")),
            (
                macos,
                None,
                false,
                Some("bin/Maka.app/Contents/Resources/Maka.icns"),
            ),
            (
                macos,
                None,
                false,
                Some("bin/Maka.app/Contents/Resources/DISCLAIMER"),
            ),
            // A package has no optional files.
            (
                macos,
                Some("bin/Maka.app/Contents/Resources/extra"),
                false,
                None,
            ),
        ] {
            let root = tempfile::tempdir().unwrap();
            let bytes = package(target, extra, Some(true), omitted);
            let digest = if bad_hash {
                [0; 64]
            } else {
                Sha512::digest(&bytes).into()
            };
            let origin =
                registry(target, bytes, format!("sha512-{}", STANDARD.encode(digest))).await;
            let client = Client::builder().no_proxy().build().unwrap();
            assert!(
                request(target, root.path())
                    .resolve(client, origin)
                    .await
                    .is_err()
            );
            assert_eq!(
                std::fs::read_dir(root.path().join("cache"))
                    .unwrap()
                    .count(),
                0
            );
        }
        for (target, desktop_gui) in [(Target::LinuxX64Gnu, None), (Target::Win32X64, Some(false))]
        {
            let root = tempfile::tempdir().unwrap();
            let bytes = package(target, None, desktop_gui, None);
            let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(&bytes)));
            let origin = registry(target, bytes, integrity).await;
            let client = Client::builder().no_proxy().build().unwrap();
            assert!(
                request(target, root.path())
                    .resolve(client, origin)
                    .await
                    .is_err()
            );
            assert_eq!(
                std::fs::read_dir(root.path().join("cache"))
                    .unwrap()
                    .count(),
                0
            );
        }
        // Links and traversal must be rejected before creating their targets.
        let target = linux;
        for (name, kind) in [
            ("package/bin/maka", tar::EntryType::Symlink),
            ("package/bin/maka-desktop-shell", tar::EntryType::Symlink),
            ("package/bin/../escaped", tar::EntryType::Regular),
            ("package/bin/maka/../../escaped", tar::EntryType::Regular),
            ("../escaped", tar::EntryType::Regular),
        ] {
            let root = tempfile::tempdir().unwrap();
            let mut temporary = NamedTempFile::new_in(root.path()).unwrap();
            let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
            let mut header = tar::Header::new_ustar();
            header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
            header.set_size(0);
            header.set_entry_type(kind);
            header.set_cksum();
            tar.append(&header, &[][..]).unwrap();
            temporary
                .write_all(&tar.into_inner().unwrap().finish().unwrap())
                .unwrap();
            let destination = root.path().join("published");
            assert!(
                archive::publish(
                    temporary,
                    root.path(),
                    &destination,
                    target,
                    "1.2.3",
                    "unused"
                )
                .is_err()
            );
            assert!(!destination.exists());
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        }
    }
}
