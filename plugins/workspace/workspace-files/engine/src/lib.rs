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

mod edit_index;
mod edit_match;
pub use edit_match::EditMatchStrategy;
pub mod directory;
pub mod files;
pub mod git;
pub mod image;
pub mod path;
mod search;
pub mod workspace;
pub mod worktree;
pub use search::{GLOB_DESCRIPTION, GLOB_NAME, glob_schema};
mod grep;
pub use grep::{GREP_DESCRIPTION, GREP_NAME, grep_schema};
mod mutation;
mod patch;
mod scoped;
mod write;
mod write_target;

pub use mutation::{
    EDIT_DESCRIPTION, EDIT_NAME, WRITE_DESCRIPTION, WRITE_NAME, edit_schema, write_schema,
};
pub use patch::{PATCH_DESCRIPTION, PATCH_NAME, patch_schema};
pub use write::{MutationExecutor, WriteCoordinator, WriteScope, mutation_paths};

use maka_agent_facts::read::ReadInput;
use maka_agent_facts::read::ReadPage;
use maka_agent_facts::read::ReadRequest;
use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

pub const READ_NAME: &str = "Read";
pub const READ_DESCRIPTION: &str = "Read a bounded page of UTF-8 text or a PNG/JPEG/GIF/WebP image within the Session's allowed filesystem roots. Offset is zero-based lines; limit is a positive line count. Pass a non-null next object to Read to continue; a changed source invalidates the continuation. Images ignore offset/limit and return the original encoded bytes.";

pub fn read_schema() -> Value {
    schemars::schema_for!(ReadInput).into()
}

/// Trusted Host authority, never deserialized from tool arguments.
/// Directory capabilities enforce reads; this is not an OS process sandbox.
pub enum ReadScope {
    Restricted { roots: Vec<PathBuf> },
    Policy(Arc<maka_sandbox::filesystem::Compiled>),
    Unrestricted,
}

/// Bytes remain internal until the Host commits the image snapshot and result.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadOutput {
    Text(ReadPage),
    Image { bytes: Vec<u8>, mime_type: String },
}

/// Metadata observed from the authorized regular file before creating a sink.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinaryFileMetadata {
    pub name: String,
    pub bytes: u64,
    /// Last modification time observed from this opened file, when available.
    pub modified: Option<std::time::SystemTime>,
}

#[derive(Clone)]
pub struct ReadExecutor {
    authority: Arc<scoped::Authority>,
}

impl ReadExecutor {
    /// Retain the selected directory. With a policy, external paths are governed
    /// by that policy; without one, access stays confined to this directory.
    pub fn from_directory(
        path: PathBuf,
        directory: cap_std::fs::Dir,
        policy: Option<Arc<maka_sandbox::filesystem::Compiled>>,
    ) -> Result<Self, ToolError> {
        Ok(Self {
            authority: Arc::new(scoped::Authority::from_directory(path, directory, policy)?),
        })
    }
    pub fn new(cwd: impl AsRef<Path>, scope: ReadScope) -> Result<Self, ToolError> {
        Ok(Self {
            authority: Arc::new(scoped::Authority::new(cwd.as_ref(), scope)?),
        })
    }

    pub async fn read(
        &self,
        input: ReadRequest,
        page_budget: usize,
        cancellation: CancellationToken,
    ) -> Result<ReadOutput, ToolError> {
        let authority = self.authority.clone();
        if input.path().contains("://") {
            return Err(failed("Filesystem Read requires a file path"));
        }
        // Always join blocking I/O: cancellation must not detach unsettled work.
        tokio::task::spawn_blocking(move || authority.read(input, page_budget, cancellation))
            .await
            .map_err(|e| failed(format!("Read worker failed: {e}")))?
    }

    /// Observe an authorized regular file's name and length for budget sizing.
    /// This does not freeze content or authorize a later open; copying must
    /// open through the same authority again and check its current metadata.
    ///
    /// # Errors
    /// Returns file, policy, cancellation or worker errors.
    pub async fn binary_metadata(
        &self,
        path: String,
        cancellation: CancellationToken,
    ) -> Result<BinaryFileMetadata, ToolError> {
        if path.contains("://") {
            return Err(failed("Filesystem Read requires a file path"));
        }
        let authority = self.authority.clone();
        tokio::task::spawn_blocking(move || authority.binary_metadata(path, cancellation))
            .await
            .map_err(|error| failed(format!("Binary metadata worker failed: {error}")))?
    }

    /// Copy an authorized regular file into a caller-owned binary sink.
    /// The factory runs only after opening through this executor's directory
    /// authority. The source descriptor stays in the joined worker; the caller
    /// finalizes the returned sink within its original resource custody.
    ///
    /// # Errors
    /// Returns policy, file, sink, cancellation or observable source-change
    /// errors. Blocking work is joined before returning, including cancellation.
    pub async fn copy_binary<W, F>(
        &self,
        path: String,
        create: F,
        cancellation: CancellationToken,
    ) -> Result<W, ToolError>
    where
        W: std::io::Write + Send + 'static,
        F: FnOnce(BinaryFileMetadata) -> Result<W, ToolError> + Send + 'static,
    {
        if path.contains("://") {
            return Err(failed("Filesystem Read requires a file path"));
        }
        let authority = self.authority.clone();
        tokio::task::spawn_blocking(move || authority.copy_binary(path, create, cancellation))
            .await
            .map_err(|error| failed(format!("Binary Read worker failed: {error}")))?
    }
}

impl ToolExecutor for ReadExecutor {
    fn names(&self) -> Vec<String> {
        vec![READ_NAME.into(), GLOB_NAME.into(), GREP_NAME.into()]
    }

    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let executor = self.clone();
        Box::pin(async move {
            if name == GLOB_NAME {
                return executor.glob(input, cancellation).await;
            }
            if name == GREP_NAME {
                return executor.grep(input, cancellation).await;
            }
            if name != READ_NAME {
                return Err(failed("unsupported tool"));
            }
            let input: ReadInput =
                serde_json::from_value(input).map_err(|e| failed(e.to_string()))?;
            let request = input.resolve().map_err(|e| failed(e.to_string()))?;
            match executor
                .read(
                    request,
                    maka_agent_facts::read::MAX_PAGE_CHARS,
                    cancellation,
                )
                .await?
            {
                ReadOutput::Text(page) => Ok(serde_json::to_value(page).expect("ReadPage is JSON")),
                ReadOutput::Image { .. } => Err(failed(
                    "Read image requires a durable journal snapshot; use the Host typed Read path",
                )),
            }
        })
    }
}

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

#[cfg(all(test, unix))]
mod image_tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    fn request(path: impl AsRef<Path>) -> ReadRequest {
        ReadInput {
            path: path.as_ref().to_str().unwrap().into(),
            offset: Some(99),
            limit: std::num::NonZeroUsize::new(1),
        }
        .resolve()
        .unwrap()
    }

    // Header fixtures exercise the promised dimensions probe, not pixel decoding.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes
    }

    fn executor(root: &Path) -> ReadExecutor {
        ReadExecutor::new(
            root,
            ReadScope::Restricted {
                roots: vec![root.to_owned()],
            },
        )
        .unwrap()
    }

    #[tokio::test]
    async fn image_formats_use_content_mime_and_ignore_line_slicing() {
        let temp = tempfile::tempdir().unwrap();
        let read = executor(temp.path());
        for (path, bytes, mime_type) in [
            ("mismatch.JpEg", png(1, 1), "image/png"),
            ("photo.jpg", b"\xff\xd8\xff\xc0\0\x0b\x08\0\x01\0\x02\x01\x01\x11\0".to_vec(), "image/jpeg"),
            ("motion.gif", b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff\x2c\0\0\0\0\x01\0\x01\0\0\x02\x02\x44\x01\0\x3b".to_vec(), "image/gif"),
            ("picture.webp", b"RIFF\x16\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0\0\0\0\0\0\0".to_vec(), "image/webp"),
        ] {
            fs::write(temp.path().join(path), &bytes).unwrap();
            assert_eq!(read.read(request(path), maka_agent_facts::read::MAX_PAGE_CHARS, CancellationToken::new()).await.unwrap(),
                ReadOutput::Image { bytes, mime_type: mime_type.into() });
        }
        let error = read
            .invoke(
                READ_NAME.into(),
                serde_json::json!({"path":"mismatch.JpEg"}),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("durable journal snapshot"));
    }

    #[tokio::test]
    async fn image_reads_preserve_large_sources_and_reject_invalid_headers() {
        let temp = tempfile::tempdir().unwrap();
        let read = executor(temp.path());
        let path = temp.path().join("image.png");
        let mut large = png(2200, 700);
        large.resize(6 * 1024 * 1024, 0);
        for bytes in [large, png(2001, 1), png(1, 2001)] {
            fs::write(&path, &bytes).unwrap();
            assert_eq!(
                read.read(
                    request(&path),
                    maka_agent_facts::read::MAX_PAGE_CHARS,
                    CancellationToken::new()
                )
                .await
                .unwrap(),
                ReadOutput::Image {
                    bytes,
                    mime_type: "image/png".into()
                }
            );
        }
        let mut corrupt_png = png(1, 1);
        corrupt_png[4..8].copy_from_slice(b"oops");
        for bytes in [
            corrupt_png,
            b"GIF8xx\x01\0\x01\0\0\0".to_vec(),
            png(0, 1),
            png(1, 0),
            b"not an image".to_vec(),
            b"\x89PNG".to_vec(),
            b"\0\0\0\x18ftypavif\0\0\0\0avifmif1".to_vec(),
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(
                read.read(
                    request(&path),
                    maka_agent_facts::read::MAX_PAGE_CHARS,
                    CancellationToken::new()
                )
                .await
                .is_err()
            );
        }
        fs::write(&path, png(1, 1)).unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(
            read.read(
                request(path),
                maka_agent_facts::read::MAX_PAGE_CHARS,
                cancellation
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn image_read_keeps_capability_and_requested_extension_semantics() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("workspace");
        fs::create_dir(&root).unwrap();
        let bytes = png(1, 1);
        fs::write(root.join("data"), &bytes).unwrap();
        fs::write(base.join("outside.png"), &bytes).unwrap();
        symlink("data", root.join("alias.png")).unwrap();
        symlink("../outside.png", root.join("escape.png")).unwrap();
        let alias = base.join("root-alias");
        symlink(&root, &alias).unwrap();
        let read = ReadExecutor::new(
            &root,
            ReadScope::Restricted {
                roots: vec![alias.clone()],
            },
        )
        .unwrap();
        assert_eq!(
            read.read(
                request(alias.join("alias.png")),
                maka_agent_facts::read::MAX_PAGE_CHARS,
                CancellationToken::new()
            )
            .await
            .unwrap(),
            ReadOutput::Image {
                bytes: bytes.clone(),
                mime_type: "image/png".into()
            }
        );
        for path in [
            base.join("outside.png"),
            root.join("escape.png"),
            root.clone(),
        ] {
            assert!(
                read.read(
                    request(path),
                    maka_agent_facts::read::MAX_PAGE_CHARS,
                    CancellationToken::new()
                )
                .await
                .is_err()
            );
        }
        for name in ["data", "data.svg", "data.avif", "data.pdf"] {
            fs::write(root.join(name), &bytes).unwrap();
            assert!(
                read.read(
                    request(name),
                    maka_agent_facts::read::MAX_PAGE_CHARS,
                    CancellationToken::new()
                )
                .await
                .is_err()
            );
        }
        // Replacing the ambient root cannot redirect an already captured capability.
        fs::rename(&root, base.join("captured")).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("alias.png"), "attacker").unwrap();
        assert_eq!(
            read.read(
                request(alias.join("alias.png")),
                maka_agent_facts::read::MAX_PAGE_CHARS,
                CancellationToken::new()
            )
            .await
            .unwrap(),
            ReadOutput::Image {
                bytes,
                mime_type: "image/png".into()
            }
        );
    }
}

#[cfg(test)]
mod binary_copy_tests {
    use super::*;
    use std::{
        fs,
        io::{self, Write},
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    fn executor(root: &Path) -> ReadExecutor {
        ReadExecutor::new(
            root,
            ReadScope::Restricted {
                roots: vec![root.to_owned()],
            },
        )
        .unwrap()
    }

    #[tokio::test]
    async fn binary_copy_denied_path_directory_or_symlink_never_creates_sink() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.bin");
        fs::write(&secret, b"private\0bytes").unwrap();
        let alias = {
            #[cfg(unix)]
            {
                let alias = root.path().join("alias.bin");
                std::os::unix::fs::symlink(&secret, &alias).unwrap();
                Some(alias)
            }
            #[cfg(not(unix))]
            {
                None::<std::path::PathBuf>
            }
        };
        let read = executor(root.path());
        let factories = Arc::new(AtomicUsize::new(0));
        for path in [Some(secret), Some(root.path().to_owned()), alias]
            .into_iter()
            .flatten()
        {
            let called = factories.clone();
            assert!(
                read.copy_binary(
                    path.to_str().unwrap().into(),
                    move |_| {
                        called.fetch_add(1, Ordering::SeqCst);
                        Ok(Vec::<u8>::new())
                    },
                    CancellationToken::new(),
                )
                .await
                .is_err()
            );
        }
        assert_eq!(factories.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn binary_copy_cancellation_waits_for_the_original_blocking_writer() {
        struct BlockingSink {
            entered: Option<tokio::sync::oneshot::Sender<()>>,
            release: std::sync::mpsc::Receiver<()>,
            dropped: Arc<AtomicBool>,
        }
        impl Write for BlockingSink {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.entered.take().unwrap().send(()).unwrap();
                self.release.recv().map_err(io::Error::other)?;
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl Drop for BlockingSink {
            fn drop(&mut self) {
                self.dropped.store(true, Ordering::SeqCst);
            }
        }
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("source.bin"), vec![0u8; 128 * 1024]).unwrap();
        let read = executor(root.path());
        let cancellation = CancellationToken::new();
        let pending_cancellation = cancellation.clone();
        let dropped = Arc::new(AtomicBool::new(false));
        let writer_dropped = dropped.clone();
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let (release, pending_release) = std::sync::mpsc::channel();
        let mut copying = Box::pin(read.copy_binary(
            "source.bin".into(),
            move |_| {
                Ok(BlockingSink {
                    entered: Some(entered),
                    release: pending_release,
                    dropped: writer_dropped,
                })
            },
            pending_cancellation,
        ));
        tokio::select! {
            _ = &mut copying => panic!("copy returned before the blocked writer was released"),
            result = waiting => result.unwrap(),
        }
        cancellation.cancel();
        std::future::poll_fn(|context| {
            assert!(std::future::Future::poll(copying.as_mut(), context).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        assert!(!dropped.load(Ordering::SeqCst));
        release.send(()).unwrap();
        assert!(matches!(copying.await, Err(ToolError::Failed(message))
            if message == "Read cancelled"));
        assert!(dropped.load(Ordering::SeqCst));
    }
}
