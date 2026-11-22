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

impl Target {
    pub(crate) fn require_existing(&self) -> Result<(), ToolError> {
        if self.existing.is_none() {
            return Err(failed("Patch requires an existing regular file"));
        }
        self.validate()
    }

    pub(crate) fn require_missing(&self) -> Result<(), ToolError> {
        if self.existing.is_some() {
            return Err(failed("Patch add requires a missing target"));
        }
        self.validate()
    }

    /// Capture still requires a writable descriptor, even though unlink itself
    /// only needs parent permission. No ambient fallback relaxes that bound.
    #[cfg(unix)]
    pub(crate) fn delete(
        self,
        cancellation: &CancellationToken,
        started: &AtomicBool,
    ) -> Result<(), ToolError> {
        self.delete_impl(
            cancellation,
            started,
            #[cfg(test)]
            || {},
            #[cfg(test)]
            || {},
        )
    }

    #[cfg(unix)]
    fn delete_impl(
        self,
        cancellation: &CancellationToken,
        started: &AtomicBool,
        #[cfg(test)] before_capture: impl FnOnce(),
        #[cfg(test)] after_capture: impl FnOnce(),
    ) -> Result<(), ToolError> {
        self.require_existing()?;
        let expected = identity(
            &self
                .existing
                .as_ref()
                .unwrap()
                .metadata()
                .map_err(io_error)?,
        );
        let tomb = OsString::from(format!(".maka-pending-delete-{}", uuid::Uuid::new_v4()));
        check_cancelled(cancellation)?;
        #[cfg(test)]
        before_capture();
        // Capture and restore are no-replace, including when a directory races
        // into the capture window. No check-then-unlink of the original path.
        started.store(true, Ordering::SeqCst);
        if let Err(error) = rename_no_replace(&self.parent, &self.name, &tomb) {
            started.store(false, Ordering::SeqCst);
            return Err(io_error(error));
        }
        #[cfg(test)]
        after_capture();
        let captured = self.parent.symlink_metadata(&tomb).map_err(|error| {
            self.delete_unknown(&tomb, format!("cannot inspect captured entry: {error}"))
        })?;
        if !captured.is_file() || identity(&captured) != expected {
            rename_no_replace(&self.parent, &tomb, &self.name).map_err(|error| {
                self.delete_unknown(&tomb, format!("cannot restore captured entry: {error}"))
            })?;
            // Even a restored mismatch changed directory entries. Be conservative
            // about settlement instead of describing it as a pre-effect refusal.
            return Err(ToolError::OutcomeUnknown(
                "Delete captured a changed target; restored without overwriting the original path"
                    .into(),
            ));
        }
        // Unpredictability prevents ordinary writers from contending with this
        // private name. This is not isolation against a same-user adversary that
        // discovers and replaces it; POSIX has no identity-conditional unlink.
        self.parent.remove_file(&tomb).map_err(|error| {
            self.delete_unknown(&tomb, format!("cannot unlink captured entry: {error}"))
        })?;
        self.visible(None).map_err(|error| {
            ToolError::OutcomeUnknown(format!("Delete completed but visibility changed: {error}"))
        })?;
        // The worker is drained: cancellation after capture cannot negate success.
        Ok(())
    }

    #[cfg(unix)]
    fn delete_unknown(&self, tomb: &OsString, reason: impl std::fmt::Display) -> ToolError {
        ToolError::OutcomeUnknown(format!(
            "Delete may have moved the target: {reason}; captured entry retained at {} in the held parent capability (the parent itself may have moved)",
            self.relative_parent.join(tomb).display()
        ))
    }
}

#[cfg(unix)]
fn rename_no_replace(parent: &Dir, from: &OsString, to: &OsString) -> io::Result<()> {
    rustix::fs::renameat_with(parent, from, parent, to, rustix::fs::RenameFlags::NOREPLACE)
        .map_err(Into::into)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::ReadScope;
    use std::fs;

    fn capture(root: &Path) -> Target {
        let authority = Authority::new(
            root,
            ReadScope::Restricted {
                roots: vec![root.into()],
            },
        )
        .unwrap();
        Target::capture(&authority, Path::new("file"), super::ReadMode::None).unwrap()
    }

    #[test]
    fn swapped_file_or_directory_is_restored_without_deletion() {
        for directory in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            fs::write(root.join("file"), "approved").unwrap();
            let target = capture(&root);
            let started = AtomicBool::new(false);
            let result = target.delete_impl(
                &CancellationToken::new(),
                &started,
                || {
                    fs::rename(root.join("file"), root.join("approved")).unwrap();
                    if directory {
                        fs::create_dir(root.join("file")).unwrap();
                        fs::write(root.join("file/sentinel"), "replacement").unwrap();
                    } else {
                        fs::write(root.join("file"), "replacement").unwrap();
                    }
                },
                || {},
            );
            assert!(matches!(result, Err(ToolError::OutcomeUnknown(_))));
            assert!(started.load(Ordering::SeqCst));
            let path = if directory { "file/sentinel" } else { "file" };
            assert_eq!(fs::read(root.join(path)).unwrap(), b"replacement");
            assert_eq!(fs::read(root.join("approved")).unwrap(), b"approved");
            assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        }
    }

    #[test]
    fn reoccupied_original_preserves_both_entries_even_for_directories() {
        for directory in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            fs::write(root.join("file"), "approved").unwrap();
            let target = capture(&root);
            let result = target.delete_impl(
                &CancellationToken::new(),
                &AtomicBool::new(false),
                || {
                    fs::rename(root.join("file"), root.join("approved")).unwrap();
                    if directory {
                        fs::create_dir(root.join("file")).unwrap();
                        fs::write(root.join("file/sentinel"), "captured").unwrap();
                    } else {
                        fs::write(root.join("file"), "captured").unwrap();
                    }
                },
                || {
                    if directory {
                        fs::create_dir(root.join("file")).unwrap();
                    } else {
                        fs::write(root.join("file"), "new occupant").unwrap();
                    }
                },
            );
            let Err(ToolError::OutcomeUnknown(message)) = result else {
                panic!("expected unknown")
            };
            let tomb = fs::read_dir(&root)
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| {
                    p.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".maka-pending-delete-")
                })
                .unwrap();
            assert!(message.contains(tomb.file_name().unwrap().to_str().unwrap()));
            assert_eq!(
                fs::read(if directory {
                    tomb.join("sentinel")
                } else {
                    tomb
                })
                .unwrap(),
                b"captured"
            );
            if directory {
                assert_eq!(fs::read_dir(root.join("file")).unwrap().count(), 0);
            } else {
                assert_eq!(fs::read(root.join("file")).unwrap(), b"new occupant");
            }
            assert_eq!(fs::read(root.join("approved")).unwrap(), b"approved");
        }
    }

    #[test]
    fn guards_and_post_delete_parent_visibility() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("parent")).unwrap();
        let parent = root.join("parent");
        let target = capture(&parent);
        assert!(target.require_missing().is_ok());
        assert!(target.require_existing().is_err());
        fs::write(parent.join("file"), "approved").unwrap();
        assert!(target.require_missing().is_err());
        let authority = Authority::new(&root, ReadScope::Unrestricted).unwrap();
        let target =
            Target::capture(&authority, Path::new("parent/file"), super::ReadMode::None).unwrap();
        assert!(target.require_existing().is_ok());
        assert!(target.require_missing().is_err());
        let result = target.delete_impl(
            &CancellationToken::new(),
            &AtomicBool::new(false),
            || {},
            || {
                fs::rename(&parent, root.join("detached")).unwrap();
                fs::create_dir(&parent).unwrap();
                fs::write(parent.join("file"), "sentinel").unwrap();
            },
        );
        assert!(matches!(result, Err(ToolError::OutcomeUnknown(_))));
        assert_eq!(fs::read(parent.join("file")).unwrap(), b"sentinel");
        assert_eq!(fs::read_dir(root.join("detached")).unwrap().count(), 0);
    }

    #[test]
    fn deletion_and_cancellation_settle_known_effects() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("file"), "approved").unwrap();
        let token = CancellationToken::new();
        token.cancel();
        let started = AtomicBool::new(false);
        assert!(matches!(
            capture(&root).delete(&token, &started),
            Err(ToolError::Failed(_))
        ));
        assert!(!started.load(Ordering::SeqCst));
        assert_eq!(fs::read(root.join("file")).unwrap(), b"approved");
        let token = CancellationToken::new();
        capture(&root)
            .delete_impl(&token, &started, || {}, || token.cancel())
            .unwrap();
        assert!(started.load(Ordering::SeqCst));
        assert!(!root.join("file").exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }
}
