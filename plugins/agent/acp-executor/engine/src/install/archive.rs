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
    for index in 0..zip.len() {
        control.check(retiring)?;
        let mut source = zip.by_index(index).map_err(|_| Error::Integrity)?;
        let name = source.name().map_err(|_| Error::Integrity)?.into_owned();
        let expected_bytes = source.size();
        if ![release.server, release.helper].contains(&name.as_str())
            || files.contains_key(&name)
            || source.is_dir()
            || source
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
        {
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
    if copy(
        &mut download,
        None,
        control,
        retiring,
        receipt.archive_bytes,
    )? != receipt.archive_sha256
    {
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
    let program = program(dir, release, receipt)?;
    for file in [program.executable, program.helper] {
        let mut source = File::from_std(file.source);
        let file_bytes = source.metadata()?.len();
        let actual = copy(&mut source, None, control, retiring, file_bytes)?;
        if actual != hex::encode(file.sha256) {
            return Err(Error::Integrity);
        }
        #[cfg(unix)]
        {
            use cap_std::fs::PermissionsExt;
            if source.metadata()?.permissions().mode() & 0o777 != 0o700 {
                return Err(Error::Integrity);
            }
        }
    }
    Ok(())
}

pub(super) fn program(
    dir: &Dir,
    release: &Release,
    receipt: &Receipt,
) -> Result<maka_process::isolated::InstalledProgram, Error> {
    use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
    use maka_process::isolated::{InstalledProgram, ProgramFile};
    if receipt.version != VERSION
        || receipt.source != release.url
        || receipt.files.len() != 2
        || receipt.archive_bytes == 0
        || !digest(&receipt.archive_sha256)
        || release
            .pinned
            .is_some_and(|hash| hash != receipt.archive_sha256)
    {
        return Err(Error::Integrity);
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
    let open = |name| {
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let source = dir.open_with(name, &options)?;
        let metadata = source.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err(Error::Integrity);
        }
        let mut sha256 = [0u8; 32];
        hex::decode_to_slice(
            receipt.files.get(name).ok_or(Error::Integrity)?,
            &mut sha256,
        )
        .map_err(|_| Error::Integrity)?;
        Ok::<_, Error>(ProgramFile {
            name,
            source: source.into_std(),
            sha256,
        })
    };
    Ok(InstalledProgram {
        executable: open(release.server)?,
        helper: open(release.helper)?,
        helper_env: "ANTIGRAVITY_HARNESS_PATH",
    })
}

fn digest(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn copy(
    source: &mut impl Read,
    mut target: Option<&mut File>,
    control: &Control,
    retiring: &CancellationToken,
    expected_bytes: u64,
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
        if bytes > expected_bytes {
            return Err(Error::Integrity);
        }
        hash.update(&buffer[..count]);
        if let Some(target) = target.as_mut() {
            target.write_all(&buffer[..count])?;
        }
    }
    if bytes != expected_bytes {
        return Err(Error::Integrity);
    }
    Ok(hex::encode(hash.finalize()))
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
    use std::io::Cursor;
    use zip::{ZipWriter, write::SimpleFileOptions};

    fn zip(names: &[&str], content: &[u8]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(vec![]));
        for name in names {
            writer
                .start_file(
                    *name,
                    SimpleFileOptions::default().last_modified_time(zip::DateTime::default()),
                )
                .unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn archive(dir: &Dir, staging: &str, names: &[&str]) -> (u64, String) {
        prepare(dir, staging).unwrap();
        let bytes = zip(names, b"test executable");
        let hash = hex::encode(Sha256::digest(&bytes));
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
            hex::encode(Sha256::digest(b"tampered")),
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

    #[tokio::test]
    async fn published_files_require_a_scoped_receipt() {
        use futures_util::future::BoxFuture;
        use maka_capabilities::{
            call::{Identity, Issuer},
            storage::Directories,
        };
        use maka_plugin_core::storage::{
            Mutation, Namespace, Page, Record, Scan, Store, StoreError,
        };

        struct EmptyStore;
        impl Store for EmptyStore {
            fn read(&self, _: String) -> BoxFuture<'_, Result<Option<Record>, StoreError>> {
                Box::pin(async { Ok(None) })
            }
            fn scan(&self, _: Scan) -> BoxFuture<'_, Result<Page, StoreError>> {
                unreachable!()
            }
            fn batch(&self, _: Vec<Mutation>) -> BoxFuture<'_, Result<Vec<Record>, StoreError>> {
                unreachable!()
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let call = Issuer::default()
            .issue(Identity::Native, CancellationToken::new())
            .unwrap();
        let dirs = Directories::open(temp.path()).unwrap();
        let ns = Namespace::new("maka.agent.acp", maka_plugin_core::scope::Scope::Profile).unwrap();
        let data = dirs.bind(&ns, call).unwrap();
        let release = Release::for_platform("linux", "x86_64").unwrap();
        let root = data.read_only().await.unwrap().location();
        let dir = Dir::open_ambient_dir(&root, cap_std::ambient_authority()).unwrap();
        let (bytes, hash) = archive(&dir, "release", &[release.server, release.helper]);
        let stop = CancellationToken::new();
        publish(
            &dir,
            &release,
            "release",
            bytes,
            hash,
            &Control {
                cancellation: stop.clone(),
            },
            &stop,
        )
        .unwrap();
        let executable = root.join(release.destination()).join(release.server);
        assert!(matches!(
            super::super::open_program(&EmptyStore, &data, &executable, release).await,
            Err(Error::Integrity)
        ));
    }

    #[test]
    fn unexpected_zip_paths_never_publish_or_escape_staging() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        let release = Release::for_platform("linux", "x86_64").unwrap();
        let control = Control {
            cancellation: CancellationToken::new(),
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
