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
use cap_std::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FILE_READ_ATTRIBUTES,
    FileDispositionInfoEx, SetFileInformationByHandle,
};

impl Target {
    pub(crate) fn delete(
        self,
        cancellation: &CancellationToken,
        started: &AtomicBool,
    ) -> Result<(), ToolError> {
        self.delete_impl(
            false,
            cancellation,
            started,
            #[cfg(test)]
            || {},
        )
    }

    pub(crate) fn delete_publication(
        self,
        cancellation: &CancellationToken,
        started: &AtomicBool,
    ) -> Result<(), ToolError> {
        self.delete_impl(
            true,
            cancellation,
            started,
            #[cfg(test)]
            || {},
        )
    }

    fn delete_impl(
        self,
        publication: bool,
        cancellation: &CancellationToken,
        started: &AtomicBool,
        #[cfg(test)] after_validation: impl FnOnce(),
    ) -> Result<(), ToolError> {
        self.require_existing()?;
        let mut options = OpenOptions::new();
        options
            .access_mode(DELETE | FILE_READ_ATTRIBUTES)
            .follow(FollowSymlinks::No);
        // DELETE authority is requested only for deletion, never ordinary writes.
        // Reopening through the held parent must still identify the pinned file.
        let file = self
            .parent
            .open_with(&self.name, &options)
            .map_err(io_error)?;
        let expected = identity(
            &self
                .existing
                .as_ref()
                .unwrap()
                .metadata()
                .map_err(io_error)?,
        );
        if identity(&file.metadata().map_err(io_error)?) != expected {
            return Err(failed("Delete target changed before dispatch"));
        }
        self.validate()?;
        check_cancelled(cancellation)?;
        #[cfg(test)]
        after_validation();
        let disposition = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_DELETE
                | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
                | if publication {
                    FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE
                } else {
                    0
                },
        };
        started.store(true, Ordering::SeqCst);
        // SAFETY: the held file grants DELETE and the structure matches the class.
        // The OS marks this exact opened object, never a replacement at its path.
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfoEx,
                std::ptr::from_ref(&disposition).cast(),
                size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            )
        } == 0
        {
            started.store(false, Ordering::SeqCst);
            return Err(io_error(io::Error::last_os_error()));
        }
        // POSIX deletion removes the link when the delete handle closes, while
        // existing readers keep their data. Unsupported filesystems fail above.
        drop(file);
        self.visible(None).map_err(|error| {
            ToolError::OutcomeUnknown(format!("Delete completed but visibility changed: {error}"))
        })
    }
}

/// Acquire write access to the same object after the publication precondition.
pub(super) fn open_readonly_for_publication(
    file: &File,
    started: &AtomicBool,
) -> Result<File, ToolError> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, ReOpenFile},
    };
    let original = file.metadata().map_err(io_error)?.permissions();
    let mut writable = original.clone();
    writable.set_readonly(false);
    file.set_permissions(writable).map_err(io_error)?;
    started.store(true, Ordering::SeqCst);
    // SAFETY: ReOpenFile borrows the live handle and returns a new owned handle.
    let handle = unsafe {
        ReOpenFile(
            file.as_raw_handle(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            0,
        )
    };
    let opened = if handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: ownership of the successful ReOpenFile handle transfers once.
        Ok(File::from_std(unsafe {
            std::fs::File::from_raw_handle(handle)
        }))
    };
    file.set_permissions(original).map_err(unknown)?;
    opened.map_err(io_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ReadScope;
    use std::{fs, io::Read};

    #[tokio::test]
    async fn publish_readonly_file_requires_original_workspace_mode_and_content() {
        use crate::{MutationExecutor, WriteCoordinator, WriteScope, publication::*};
        use maka_agent_facts::{artifact::content_digest, durable::ContentRef};

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("document");
        fs::write(&path, b"one").unwrap();
        let dir = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        let info = maka_sandbox::windows::file_identity(&dir).unwrap();
        let id = SourceIdentity {
            device: info.VolumeSerialNumber,
            inode: info.FileId.Identifier.into(),
        };
        let authority = MutationExecutor::new(
            temp.path(),
            WriteScope::Restricted {
                roots: vec![temp.path().to_owned()],
            },
            WriteCoordinator::shared(),
        )
        .unwrap();
        let entry = |bytes: &[u8], mode| PublicationEntry::File {
            content: ContentRef {
                digest: content_digest(bytes),
                bytes: bytes.len() as u64,
            },
            mode,
        };
        let publish = |id, expected, candidate: Option<(&'static [u8], u32)>| {
            authority.publish_change(
                PublicationChange {
                    path: "document".into(),
                    expected,
                    candidate: candidate.map_or(PublicationEntry::Missing, |(bytes, mode)| {
                        entry(bytes, mode)
                    }),
                },
                id,
                candidate.map(|(bytes, _)| {
                    Box::new(io::Cursor::new(bytes)) as Box<dyn PublicationContent>
                }),
                CancellationToken::new(),
            )
        };
        let other = SourceIdentity {
            device: !id.device,
            ..id
        };
        assert_eq!(
            publish(other, entry(b"one", 0o600), None).await.unwrap(),
            PublicationResult::Conflict {
                reason: PublicationConflict::WorkspaceIdentity
            }
        );
        assert_eq!(
            publish(id, entry(b"one", 0o600), Some((b"one", 0o400)))
                .await
                .unwrap(),
            PublicationResult::Applied
        );
        assert!(fs::metadata(&path).unwrap().permissions().readonly());
        assert_eq!(
            publish(id, entry(b"one", 0o600), None).await.unwrap(),
            PublicationResult::Conflict {
                reason: PublicationConflict::Mode
            }
        );
        assert_eq!(
            publish(id, entry(b"old", 0o400), None).await.unwrap(),
            PublicationResult::Conflict {
                reason: PublicationConflict::Content
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"one");
        assert_eq!(
            publish(id, entry(b"one", 0o400), Some((b"replacement", 0o400)))
                .await
                .unwrap(),
            PublicationResult::Applied
        );
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert!(fs::metadata(&path).unwrap().permissions().readonly());
        assert_eq!(
            publish(id, entry(b"replacement", 0o400), None)
                .await
                .unwrap(),
            PublicationResult::Applied
        );
        assert!(!path.exists());
    }

    #[test]
    fn delete_is_bound_to_the_captured_file_and_has_honest_effect_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("file");
        let authority = Authority::new(
            &root,
            ReadScope::Restricted {
                roots: vec![root.clone()],
            },
        )
        .unwrap();
        fs::write(&path, "original").unwrap();
        let target = Target::capture(&authority, Path::new("file"), super::ReadMode::None).unwrap();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let started = AtomicBool::new(false);
        assert!(matches!(
            target.delete(&cancelled, &started),
            Err(ToolError::Failed(_))
        ));
        assert!(!started.load(Ordering::SeqCst));
        assert_eq!(fs::read(&path).unwrap(), b"original");

        let target = Target::capture(&authority, Path::new("file"), super::ReadMode::None).unwrap();
        fs::rename(&path, root.join("before")).unwrap();
        fs::write(&path, "replacement").unwrap();
        assert!(matches!(
            target.delete(&CancellationToken::new(), &started),
            Err(ToolError::Failed(_))
        ));
        assert!(!started.load(Ordering::SeqCst));
        assert_eq!(fs::read(&path).unwrap(), b"replacement");

        let target = Target::capture(&authority, Path::new("file"), super::ReadMode::None).unwrap();
        let result = target.delete_impl(false, &CancellationToken::new(), &started, || {
            fs::rename(&path, root.join("moved")).unwrap();
            fs::write(&path, "sentinel").unwrap();
        });
        assert!(
            matches!(result, Err(ToolError::OutcomeUnknown(_))),
            "{result:?}"
        );
        assert!(started.load(Ordering::SeqCst));
        assert_eq!(fs::read(&path).unwrap(), b"sentinel");
        assert!(!root.join("moved").exists());

        let mut reader = fs::File::open(&path).unwrap();
        Target::capture(&authority, Path::new("file"), super::ReadMode::None)
            .unwrap()
            .delete(&CancellationToken::new(), &AtomicBool::new(false))
            .unwrap();
        assert!(!path.exists());
        let mut content = String::new();
        reader.read_to_string(&mut content).unwrap();
        assert_eq!(content, "sentinel");
    }
}
