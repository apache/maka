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
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

/// Runs only on the checkpoint's dedicated physical worker, never a Tokio executor thread.
pub(super) struct Objects {
    owner: Arc<root::RootOwner>,
    directory: PathBuf,
}
impl Objects {
    pub(super) fn open(owner: Arc<root::RootOwner>) -> Result<Self, StoreError> {
        if !cfg!(unix) {
            return Err(invalid(
                "history checkpoint file durability is not supported on this platform",
            ));
        }
        owner.validate_current()?;
        let directory = owner.canonical_path().join("history-checkpoints");
        root::private_directory(&directory)?;
        for child in ["objects", "staging"] {
            root::private_directory(&directory.join(child))?;
        }
        File::open(&directory)?.sync_all()?;
        File::open(owner.canonical_path())?.sync_all()?;
        Ok(Self { owner, directory })
    }
    fn validate(&self) -> Result<(), StoreError> {
        self.owner.validate_current()?;
        for path in [
            &self.directory,
            &self.directory.join("objects"),
            &self.directory.join("staging"),
        ] {
            if !fs::symlink_metadata(path)?.file_type().is_dir() {
                return Err(invalid("checkpoint directory is not a directory"));
            }
        }
        Ok(())
    }
    pub(super) fn staging(&self, request: &Request, kind: &str) -> Result<PathBuf, StoreError> {
        self.validate()?;
        Ok(self
            .directory
            .join("staging")
            .join(format!("{}.{}", request.key()?, kind)))
    }
    pub(super) fn create(&self, request: &Request, kind: &str) -> Result<File, StoreError> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        Ok(options.open(self.staging(request, kind)?)?)
    }
    fn path(&self, reference: &ObjectRef) -> Result<PathBuf, StoreError> {
        if !crate::checkpoints::valid_digest(&reference.digest) {
            return Err(invalid("invalid checkpoint object digest"));
        }
        self.validate()?;
        Ok(self.directory.join("objects").join(&reference.digest))
    }
    pub(super) fn read(&self, reference: &ObjectRef) -> Result<File, StoreError> {
        let path = self.path(reference)?;
        let mut file = open_regular(&path)?;
        if measure(&mut file)? != *reference {
            return Err(invalid("checkpoint object digest or size differs"));
        }
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
    pub(super) fn publish(&self, path: &Path) -> Result<ObjectRef, StoreError> {
        self.validate()?;
        let mut source = open_regular(path)?;
        source.sync_all()?;
        let reference = measure(&mut source)?;
        let destination = self.path(&reference)?;
        match fs::hard_link(path, destination) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                self.read(&reference)?;
            }
            Err(error) => return Err(error.into()),
        }
        File::open(self.directory.join("objects"))?.sync_all()?;
        self.owner.validate_current()?;
        Ok(reference)
    }
    pub(super) fn publish_manifest(
        &self,
        request: &Request,
        manifest: &Manifest,
    ) -> Result<ObjectRef, StoreError> {
        let mut file = self.create(request, "manifest")?;
        file.write_all(&serde_json::to_vec(manifest)?)?;
        file.sync_all()?;
        drop(file);
        self.publish(&self.staging(request, "manifest")?)
    }
    pub(super) fn manifest(&self, reference: &ObjectRef) -> Result<Manifest, StoreError> {
        let file = self.read(reference)?;
        Ok(serde_json::from_reader(file)?)
    }
    pub(super) fn cleanup(&self, request: &Request) -> Result<(), StoreError> {
        for kind in ["bundle", "manifest"] {
            let path = self.staging(request, kind)?;
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(path)?,
                Ok(_) => {
                    return Err(invalid(
                        "checkpoint staging entry is not owned regular material",
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        File::open(self.directory.join("staging"))?.sync_all()?;
        Ok(())
    }
    pub(super) fn root_id(&self) -> &str {
        self.owner.root_id()
    }
}
fn open_regular(path: &Path) -> Result<File, StoreError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("checkpoint object is not a regular file"));
    }
    Ok(file)
}
fn measure(file: &mut File) -> Result<ObjectRef, StoreError> {
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        bytes = bytes
            .checked_add(count as u64)
            .ok_or_else(|| invalid("checkpoint size overflow"))?;
    }
    Ok(ObjectRef {
        digest: hex::encode(hash.finalize()),
        bytes,
    })
}
