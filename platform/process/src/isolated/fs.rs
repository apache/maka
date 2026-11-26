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

use super::Error;
use rustix::fs::{Mode, OFlags, fchmod, openat};
use std::{
    ffi::OsStr,
    fs::File,
    io::{self, Read},
    os::unix::fs::MetadataExt,
    path::Path,
};

pub(super) fn rename_noreplace(directory: &File, from: &str, to: &str) -> io::Result<()> {
    // rustix maps NOREPLACE to renameatx_np(RENAME_EXCL) on macOS.
    Ok(rustix::fs::renameat_with(
        directory,
        from,
        directory,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )?)
}

pub(super) fn seed_link_mode(directory: &File, name: &OsStr, mode: Mode) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    rustix::fs::chmodat(directory, name, mode, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)?;
    #[cfg(not(target_os = "macos"))]
    let _ = (directory, name, mode); // Linux symlinks always have mode 0777.
    Ok(())
}

pub(super) enum Copy {
    Reflink,
    Bytes(u64),
}

pub(super) fn freeze_file(
    source: &File,
    directory: &File,
    name: &OsStr,
    relative: &Path,
) -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    match reflink(source, directory, name) {
        Ok(()) => Ok(()),
        Err(error) if no_reflink(error) => Err(Error::CaptureUnsupported(format!(
            "no exact physical COW at {}",
            relative.display()
        ))),
        Err(error) => Err(error.into()),
    }
    #[cfg(target_os = "linux")]
    copy_file(source, directory, name, relative).map(|_| ())
}

pub(super) fn copy_file(
    source: &File,
    directory: &File,
    name: &OsStr,
    relative: &Path,
) -> Result<Copy, Error> {
    #[cfg(target_os = "macos")]
    match reflink(source, directory, name) {
        Ok(()) => return Ok(Copy::Reflink),
        Err(error) if no_reflink(error) => {}
        Err(error) => return Err(error.into()),
    }

    let mut output: File = openat(
        directory,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )?
    .into();
    let before = source.metadata()?;
    #[cfg(target_os = "linux")]
    match rustix::fs::ioctl_ficlone(&output, source) {
        Ok(()) => {
            fchmod(
                &output,
                Mode::from_bits_truncate((before.mode() & 0o777) as _),
            )?;
            return Ok(Copy::Reflink);
        }
        Err(error) if no_reflink(error) => {}
        Err(error) => return Err(error.into()),
    }

    // Copy only the observed extent from the original descriptor. A concurrent
    // write can otherwise leave a mixture of versions in an immutable artifact.
    let bytes = io::copy(&mut source.take(before.len()), &mut output)?;
    let after = source.metadata()?;
    let stamp = |metadata: &std::fs::Metadata| {
        (
            metadata.dev(),
            metadata.ino(),
            metadata.mode(),
            metadata.nlink(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        )
    };
    if bytes != before.len() || stamp(&before) != stamp(&after) {
        return Err(Error::CaptureUnstable(relative.to_owned()));
    }
    fchmod(
        &output,
        Mode::from_bits_truncate((before.mode() & 0o777) as _),
    )?;
    Ok(Copy::Bytes(bytes))
}

fn no_reflink(error: rustix::io::Errno) -> bool {
    use rustix::io::Errno;
    matches!(error, Errno::XDEV | Errno::OPNOTSUPP)
        || (cfg!(target_os = "linux") && error == Errno::INVAL)
}

#[cfg(target_os = "macos")]
fn reflink(source: &File, directory: &File, name: &OsStr) -> rustix::io::Result<()> {
    rustix::fs::fclonefileat(source, directory, name, rustix::fs::CloneFlags::NOOWNERCOPY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn publication_preserves_the_original() {
        let root = tempfile::tempdir().unwrap();
        let directory = File::open(root.path()).unwrap();
        let pending = root.path().join(".proof.pending");
        let published = root.path().join("proof");
        fs::write(&pending, b"first proof").unwrap();
        rename_noreplace(&directory, ".proof.pending", "proof").unwrap();
        fs::write(&pending, b"replacement").unwrap();
        let error = rename_noreplace(&directory, ".proof.pending", "proof").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(published).unwrap(), b"first proof");
        assert_eq!(fs::read(pending).unwrap(), b"replacement");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn frozen_bytes_belong_to_the_open_source() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source");
        fs::write(&source_path, b"original bytes").unwrap();
        let source = File::open(&source_path).unwrap();
        let original_path = root.path().join("original");
        fs::rename(&source_path, &original_path).unwrap();
        fs::write(&source_path, b"replacement bytes").unwrap();
        let directory = File::open(root.path()).unwrap();
        freeze_file(
            &source,
            &directory,
            OsStr::new("frozen"),
            Path::new("source"),
        )
        .unwrap();
        fs::write(original_path, b"later write").unwrap();
        assert_eq!(
            fs::read(root.path().join("frozen")).unwrap(),
            b"original bytes"
        );
    }
}
