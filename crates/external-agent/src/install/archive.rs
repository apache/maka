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

use super::{Control, Error, Release, VERSION};
use cap_fs_ext::DirExt;
use cap_std::fs::{Dir, File, OpenOptions};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Seek, SeekFrom, Write},
};
use tokio_util::sync::CancellationToken;

// The Linux 1.2.1 server expands to 920 MB; bound extraction without buffering it.
const MAX_FILE: u64 = 1024 * 1024 * 1024;
const MAX_EXPANDED: u64 = 1536 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    version: String,
    source: String,
    archive_bytes: u64,
    archive_sha256: String,
    files: BTreeMap<String, String>,
}

pub(super) fn prepare(dir: &Dir, staging: &str) -> Result<(), Error> {
    dir.create_dir(staging)?;
    let stage = dir.open_dir_nofollow(staging)?;
    private_directory(&stage)?;
    stage.create_dir("runtime")?;
    private_directory(&stage.open_dir_nofollow("runtime")?)?;
    create(&stage, "download.zip")?;
    Ok(())
}

pub(super) fn existing(
    dir: &Dir,
    release: &Release,
    receipt: &Receipt,
    control: &Control,
    retiring: &CancellationToken,
) -> Result<bool, Error> {
    control.check(retiring)?;
    match dir.symlink_metadata(release.destination()) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
        Ok(metadata) if metadata.is_dir() => {
            verify(
                &dir.open_dir_nofollow(release.destination())?,
                release,
                receipt,
                control,
                retiring,
            )?;
            Ok(true)
        }
        Ok(_) => Err(Error::Integrity),
    }
}

pub(super) fn publish(
    dir: &Dir,
    release: &Release,
    staging: &str,
    archive_bytes: u64,
    archive_sha256: String,
    control: &Control,
    retiring: &CancellationToken,
) -> Result<Receipt, Error> {
    control.check(retiring)?;
    let stage = dir.open_dir_nofollow(staging)?;
    let output = stage.open_dir_nofollow("runtime")?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    let download = stage.open_with("download.zip", &options)?;
    download.sync_all()?;
    let mut zip = zip::ZipArchive::new(download).map_err(|_| Error::Integrity)?;
    if zip.len() != 2 {
        return Err(Error::Integrity);
    }
    let mut files = BTreeMap::new();
    let mut expanded = 0_u64;
    for index in 0..zip.len() {
        control.check(retiring)?;
        let mut source = zip.by_index(index).map_err(|_| Error::Integrity)?;
        let name = source.name().to_owned();
        let expected_bytes = source.size();
        if ![release.server, release.helper].contains(&name.as_str())
            || files.contains_key(&name)
            || source.is_dir()
            || source.size() > MAX_FILE
            || source
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
        {
            return Err(Error::Integrity);
        }
        expanded = expanded
            .checked_add(source.size())
            .ok_or(Error::Integrity)?;
        if expanded > MAX_EXPANDED {
            return Err(Error::Integrity);
        }
        let mut target = create(&output, &name)?;
        let hash = copy(
            &mut source,
            Some(&mut target),
            control,
            retiring,
            expected_bytes,
        )?;
        if target.metadata()?.len() != expected_bytes {
            return Err(Error::Integrity);
        }
        executable(&target)?;
        target.sync_all()?;
        files.insert(name, hash);
    }
    let receipt = Receipt {
        version: VERSION.into(),
        source: release.url.clone(),
        archive_bytes,
        archive_sha256,
        files,
    };
    // The cache is process-writable. Confirm its archive still matches the
    // digest of bytes received directly from the authorized HTTPS response.
    let mut download = zip.into_inner();
    download.seek(SeekFrom::Start(0))?;
    if copy(&mut download, None, control, retiring, super::MAX_ARCHIVE)? != receipt.archive_sha256 {
        return Err(Error::Integrity);
    }
    verify(&output, release, &receipt, control, retiring)?;
    sync_directory(&output)?;
    control.check(retiring)?;
    // Windows can deny renaming directories with open descendants.
    drop(download);
    drop(output);
    // Never remove or replace an installed executable. Concurrent identical
    // publication is accepted only after validating the winning installation.
    if let Err(error) = stage.rename("runtime", dir, release.destination())
        && !existing(dir, release, &receipt, control, retiring)?
    {
        return Err(error.into());
    }
    sync_directory(dir)?;
    Ok(receipt)
}

fn verify(
    dir: &Dir,
    release: &Release,
    receipt: &Receipt,
    control: &Control,
    retiring: &CancellationToken,
) -> Result<(), Error> {
    if receipt.version != VERSION
        || receipt.source != release.url
        || receipt.files.len() != 2
        || receipt.archive_bytes == 0
        || receipt.archive_bytes > super::MAX_ARCHIVE
        || !digest(&receipt.archive_sha256)
        || release
            .pinned
            .is_some_and(|hash| hash != receipt.archive_sha256)
    {
        return Err(Error::Integrity);
    }
    for name in [release.server, release.helper] {
        control.check(retiring)?;
        if !dir.symlink_metadata(name)?.is_file() {
            return Err(Error::Integrity);
        }
        let mut file = dir.open(name)?;
        if file.metadata()?.len() > MAX_FILE {
            return Err(Error::Integrity);
        }
        let actual = copy(&mut file, None, control, retiring, MAX_FILE)?;
        if receipt.files.get(name) != Some(&actual) {
            return Err(Error::Integrity);
        }
        #[cfg(unix)]
        {
            use cap_std::fs::PermissionsExt;
            if file.metadata()?.permissions().mode() & 0o777 != 0o700 {
                return Err(Error::Integrity);
            }
        }
    }
    if release.platform == "darwin-arm64"
        && (receipt.archive_bytes != 111_725_488
            || receipt.files.get(release.server).map(String::as_str)
                != Some("c93c86c0f505fcdf8b13c695bed26d306141ef5446189d591397074d324db34e")
            || receipt.files.get(release.helper).map(String::as_str)
                != Some("1b8a2b712ca312c9769e425b800bfbcceec4770f19736404474d1e8e50d65456"))
    {
        return Err(Error::Integrity);
    }
    Ok(())
}

fn digest(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn copy(
    source: &mut impl Read,
    mut target: Option<&mut File>,
    control: &Control,
    retiring: &CancellationToken,
    limit: u64,
) -> Result<String, Error> {
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 65536];
    let mut hash = Sha256::new();
    loop {
        control.check(retiring)?;
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > limit {
            return Err(Error::Integrity);
        }
        hash.update(&buffer[..count]);
        if let Some(target) = target.as_mut() {
            target.write_all(&buffer[..count])?;
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn create(dir: &Dir, name: &str) -> Result<File, Error> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(dir.open_with(name, &options)?)
}
fn executable(file: &File) -> Result<(), Error> {
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;
        file.set_permissions(cap_std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}
fn private_directory(dir: &Dir) -> Result<(), Error> {
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;
        dir.set_permissions(".", cap_std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}
fn sync_directory(dir: &Dir) -> Result<(), Error> {
    #[cfg(unix)]
    dir.open(".")?.sync_all()?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Cursor, time::Duration};
    use zip::{ZipWriter, write::SimpleFileOptions};

    fn archive(dir: &Dir, staging: &str, names: &[&str]) -> (u64, String) {
        prepare(dir, staging).unwrap();
        let mut writer = ZipWriter::new(Cursor::new(vec![]));
        for name in names {
            writer
                .start_file(
                    *name,
                    SimpleFileOptions::default().last_modified_time(zip::DateTime::default()),
                )
                .unwrap();
            writer.write_all(b"test executable").unwrap();
        }
        let bytes = writer.finish().unwrap().into_inner();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        dir.write(format!("{staging}/download.zip"), &bytes)
            .unwrap();
        (bytes.len() as u64, hash)
    }

    #[test]
    fn immutable_publication_reuses_verified_files_and_refuses_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        let release = Release::for_platform("linux", "x86_64").unwrap();
        let control = Control {
            cancellation: CancellationToken::new(),
            deadline: tokio::time::Instant::now() + Duration::from_secs(30),
        };
        let retiring = CancellationToken::new();
        let names = [release.server, release.helper];
        let (bytes, hash) = archive(&dir, "first", &names);
        let anchor = publish(&dir, &release, "first", bytes, hash, &control, &retiring).unwrap();
        assert!(existing(&dir, &release, &anchor, &control, &retiring).unwrap());
        let (bytes, hash) = archive(&dir, "concurrent", &names);
        let recovered = publish(
            &dir,
            &release,
            "concurrent",
            bytes,
            hash,
            &control,
            &retiring,
        )
        .unwrap();
        assert_eq!(recovered, anchor);
        let installed = dir.open_dir_nofollow(release.destination()).unwrap();
        assert!(!installed.try_exists("receipt.json").unwrap());
        installed.write(release.server, b"tampered").unwrap();
        let mut forged = anchor.clone();
        forged.files.insert(
            release.server.into(),
            format!("{:x}", Sha256::digest(b"tampered")),
        );
        installed
            .write("receipt.json", serde_json::to_vec(&forged).unwrap())
            .unwrap();
        assert!(matches!(
            existing(&dir, &release, &anchor, &control, &retiring),
            Err(Error::Integrity)
        ));
        let (bytes, hash) = archive(&dir, "repair", &names);
        assert!(matches!(
            publish(&dir, &release, "repair", bytes, hash, &control, &retiring),
            Err(Error::Integrity)
        ));
        assert_eq!(installed.read(release.server).unwrap(), b"tampered");
    }

    #[test]
    fn unexpected_zip_paths_never_publish_or_escape_staging() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        let release = Release::for_platform("linux", "x86_64").unwrap();
        let control = Control {
            cancellation: CancellationToken::new(),
            deadline: tokio::time::Instant::now() + Duration::from_secs(30),
        };
        let (bytes, hash) = archive(&dir, "bad", &[release.server, "../../escaped"]);
        assert!(matches!(
            publish(
                &dir,
                &release,
                "bad",
                bytes,
                hash,
                &control,
                &CancellationToken::new()
            ),
            Err(Error::Integrity)
        ));
        assert!(!dir.try_exists(release.destination()).unwrap());
        assert!(!dir.try_exists("escaped").unwrap());
    }
}
