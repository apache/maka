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

use super::{Package, validate_path};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::Path,
};

#[derive(Debug, thiserror::Error)]
pub enum PackageIoError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Invalid(#[from] crate::Error),
    #[error("package was published but its durability could not be confirmed: {0}")]
    CommitUnknown(std::io::Error),
}

impl Package {
    /// Hash directory bytes without parsing declarations. A matching digest can
    /// avoid an unchanged-product update; it never admits code for execution.
    pub fn directory_digest(source: &Path) -> Result<String, PackageIoError> {
        if !source.is_absolute() {
            return Err(invalid("package source must be absolute"));
        }
        let parent = source
            .parent()
            .ok_or_else(|| invalid("package source needs a parent"))?;
        let name = source
            .file_name()
            .ok_or_else(|| invalid("package source needs a filename"))?;
        let parent = Dir::open_ambient_dir(parent, ambient_authority())?;
        let directory = parent.open_dir_nofollow(name)?;
        let mut files = BTreeMap::new();
        collect(&directory, "", &mut files)?;
        Ok(super::content_digest(
            files
                .iter()
                .map(|(path, bytes)| (path.as_str(), bytes.as_slice())),
        ))
    }
    /// Blocking I/O; call on the Host blocking pool. Directory-relative handles
    /// refuse substituted symlinks at every package component on all platforms.
    pub fn read_from(source: &Path) -> Result<Self, PackageIoError> {
        if !source.is_absolute() {
            return Err(invalid("package source must be absolute"));
        }
        let parent = source
            .parent()
            .ok_or_else(|| invalid("package source needs a parent"))?;
        let name = source
            .file_name()
            .ok_or_else(|| invalid("package source needs a filename"))?;
        let parent = Dir::open_ambient_dir(parent, ambient_authority())?;
        let metadata = parent.symlink_metadata(name)?;
        if metadata.is_dir() && !metadata.is_symlink() {
            let directory = parent.open_dir_nofollow(name)?;
            let mut files = BTreeMap::new();
            collect(&directory, "", &mut files)?;
            Ok(Self::new(files)?)
        } else if metadata.is_file() && !metadata.is_symlink() {
            Ok(Self::from_bundle(&read(&parent, name.as_ref())?)?)
        } else {
            Err(invalid(
                "package source must be a regular file or directory, not a symlink",
            ))
        }
    }

    /// An existing destination is never replaced, and a partial write is never
    /// published as a complete bundle.
    pub fn export_to(&self, target: &Path) -> Result<(), PackageIoError> {
        self.export_with_sync(target, |parent| {
            #[cfg(unix)]
            fs::File::open(parent)?.sync_all()?;
            #[cfg(not(unix))]
            let _ = parent;
            Ok(())
        })
    }

    fn export_with_sync(
        &self,
        target: &Path,
        sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<(), PackageIoError> {
        if !target.is_absolute() {
            return Err(invalid("bundle destination must be absolute"));
        }
        let parent = target
            .parent()
            .ok_or_else(|| invalid("bundle destination needs a parent"))?;
        fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&self.to_bundle())?;
        temporary.as_file().sync_all()?;
        temporary
            .persist_noclobber(target)
            .map_err(|error| error.error)?;
        sync_parent(parent).map_err(PackageIoError::CommitUnknown)?;
        Ok(())
    }
}

fn collect(
    directory: &Dir,
    prefix: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), PackageIoError> {
    // Keep only the current DFS path open. Queuing opened sibling directories
    // would turn a wide package into a file-descriptor admission limit.
    let directory = directory.try_clone()?;
    let entries = directory.entries()?;
    let mut pending = vec![(directory, prefix.to_owned(), entries)];
    while let Some((directory, prefix, entries)) = pending.last_mut() {
        let Some(entry) = entries.next() else {
            pending.pop();
            continue;
        };
        let entry = entry?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let name = name
            .to_str()
            .ok_or_else(|| invalid("package filename is not UTF-8"))?;
        let path = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        validate_path(&path)?;
        let kind = entry.file_type()?;
        if kind.is_dir() && !kind.is_symlink() {
            let child = directory.open_dir_nofollow(name)?;
            let entries = child.entries()?;
            pending.push((child, path, entries));
        } else if kind.is_file() && !kind.is_symlink() {
            files.insert(path, read(directory, Path::new(name))?);
        } else {
            return Err(invalid("package contains a symlink or non-regular file"));
        }
    }
    Ok(())
}

fn read(directory: &Dir, name: &Path) -> Result<Vec<u8>, PackageIoError> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = directory.open_with(name, &options)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(invalid("package file is not regular"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn invalid(message: &str) -> PackageIoError {
    crate::Error::Invalid(message.into()).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn importing_and_exporting_preserves_bytes_without_following_links_or_overwriting() {
        let directory = tempfile::tempdir().unwrap();
        let package_root = directory.path().join("package");
        fs::create_dir(&package_root).unwrap();
        fs::write(
            package_root.join("maka.extension.json"),
            br#"{"schemaVersion":1,"id":"example","application":{"host":{"implementation":{"kind":"native","implementation":"example.host"},"configuration":{"type":"object"}}}}"#,
        )
        .unwrap();
        fs::write(package_root.join("index.mjs"), b"export default {}").unwrap();
        let package = Package::read_from(&package_root).unwrap();
        assert_eq!(
            Package::directory_digest(&package_root).unwrap(),
            package.digest()
        );
        fs::write(
            package_root.join("index.mjs"),
            b"export default {changed: true}",
        )
        .unwrap();
        assert_ne!(
            Package::directory_digest(&package_root).unwrap(),
            package.digest()
        );
        fs::write(package_root.join("index.mjs"), b"export default {}").unwrap();
        let bundle = directory.path().join("example.maka-extension");
        package.export_to(&bundle).unwrap();
        assert_eq!(
            Package::read_from(&bundle).unwrap().digest(),
            package.digest()
        );
        assert!(package.export_to(&bundle).is_err());
        assert_eq!(
            Package::read_from(&bundle).unwrap().digest(),
            package.digest()
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&bundle, package_root.join("linked")).unwrap();
            assert!(Package::read_from(&package_root).is_err());
            assert!(Package::directory_digest(&package_root).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn wide_directory_import_keeps_only_the_current_path_open() {
        const CHILD: &str = "MAKA_PACKAGE_WIDE_DIRECTORY_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "io::tests::wide_directory_import_keeps_only_the_current_path_open",
                    "--test-threads=1",
                ])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated wide directory import failed: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        // This exact-test subprocess owns its FD limit.96 siblings exceed64
        // while the original recursive traversal and depth-first frames need
        // only a few descriptors for this two-level tree.
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
            0
        );
        limit.rlim_cur = limit.rlim_max.min(64);
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("package");
        fs::create_dir(&root).unwrap();
        let mut files = BTreeMap::from([("maka.extension.json".into(), br#"{"schemaVersion":1,"id":"wide.package","application":{"host":{"implementation":{"kind":"native","implementation":"example.host"},"configuration":{"type":"object"}}}}"#.to_vec())]);
        for index in 0..96 {
            files.insert(
                format!("dir-{index:03}/original.bin"),
                vec![index as u8, 255, 0],
            );
        }
        for (name, bytes) in &files {
            let path = root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let expected = Package::new(files).unwrap();
        let imported = Package::read_from(&root).unwrap();
        assert!(
            imported.files() == expected.files(),
            "wide import changed original bytes"
        );
        assert_eq!(imported.digest(), expected.digest());
        assert_eq!(Package::directory_digest(&root).unwrap(), expected.digest());
    }

    #[test]
    fn published_package_survives_parent_sync_failure_as_unknown_without_overwrite() {
        let package = Package::new(BTreeMap::from([
            ("maka.extension.json".into(), br#"{"schemaVersion":1,"id":"example","application":{"host":{"implementation":{"kind":"native","implementation":"example.host"},"configuration":{"type":"object"}}}}"#.to_vec()),
            ("index.mjs".into(), b"export default {}".to_vec()),
        ])).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("export.maka-extension");
        let error = package
            .export_with_sync(&target, |_| Err(std::io::Error::other("sync failed")))
            .unwrap_err();
        assert!(matches!(error, PackageIoError::CommitUnknown(_)));
        assert_eq!(fs::read(&target).unwrap(), package.to_bundle());
        assert!(
            matches!(package.export_to(&target), Err(PackageIoError::Io(error))
            if error.kind() == std::io::ErrorKind::AlreadyExists)
        );
        assert_eq!(
            Package::read_from(&target).unwrap().digest(),
            package.digest()
        );
    }
}
