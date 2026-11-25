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

use std::{fs::File, io};

#[cfg(target_os = "linux")]
pub(super) fn rename_without_replace(owner: &File, from: &str, to: &str) -> io::Result<()> {
    use rustix::fs::{RenameFlags, renameat_with};
    renameat_with(owner, from, owner, to, RenameFlags::NOREPLACE)?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn rename_without_replace(owner: &File, from: &str, to: &str) -> io::Result<()> {
    use std::{ffi::CString, os::fd::AsRawFd};
    let from = CString::new(from).map_err(io::Error::other)?;
    let to = CString::new(to).map_err(io::Error::other)?;
    // SAFETY: the directory descriptor and both C strings stay live for the call.
    let status = unsafe {
        libc::renameatx_np(
            owner.as_raw_fd(),
            from.as_ptr(),
            owner.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishing_evidence_never_replaces_original() -> io::Result<()> {
        let dir = tempfile::tempdir()?;
        let owner = File::open(dir.path())?;
        let staged = dir.path().join("pending");
        let published = dir.path().join("published");
        std::fs::write(&staged, b"original")?;
        rename_without_replace(&owner, "pending", "published")?;
        std::fs::write(&staged, b"replacement")?;
        let error = rename_without_replace(&owner, "pending", "published").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(published)?, b"original");
        assert_eq!(std::fs::read(staged)?, b"replacement");
        Ok(())
    }
}
