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
    DELETE, FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    FILE_DISPOSITION_INFO_EX, FILE_READ_ATTRIBUTES, FileDispositionInfoEx,
    SetFileInformationByHandle,
};

impl Target {
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
        )
    }

    fn delete_impl(
        self,
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
            Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ReadScope;
    use std::{fs, io::Read};

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
        let result = target.delete_impl(&CancellationToken::new(), &started, || {
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
