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

use super::DirectoryIdentity;
use cap_fs_ext::MetadataExt;
use cap_std::fs::Dir;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{io, time::UNIX_EPOCH};

#[derive(Clone, Copy, Serialize)]
#[serde(untagged)]
enum Volume {
    #[cfg(target_os = "macos")]
    Uuid(uuid::Uuid),
    Device(u64),
}

struct Observation {
    volume: Volume,
    #[cfg(target_os = "macos")]
    device: u64,
    inode: u64,
    birth: Option<(u64, u32)>,
}

impl Observation {
    fn read(directory: &Dir) -> io::Result<Self> {
        let metadata = directory.dir_metadata()?;
        let device = metadata.dev();
        let volume = Volume::Device(device);
        #[cfg(target_os = "macos")]
        let volume = volume_uuid(directory)?.map_or(volume, Volume::Uuid);
        let birth = metadata
            .created()
            .ok()
            .and_then(|time| time.into_std().duration_since(UNIX_EPOCH).ok())
            .map(|duration| (duration.as_secs(), duration.subsec_nanos()));
        Ok(Self {
            volume,
            #[cfg(target_os = "macos")]
            device,
            inode: metadata.ino(),
            birth,
        })
    }

    fn basis(&self) -> impl Serialize {
        (self.volume, self.inode, self.birth)
    }
}

fn fingerprint(value: impl Serialize) -> io::Result<DirectoryIdentity> {
    let bytes = serde_json::to_vec(&value).map_err(io::Error::other)?;
    Ok(DirectoryIdentity(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(bytes))
    )))
}

impl DirectoryIdentity {
    pub fn capture(directory: &Dir) -> io::Result<Self> {
        fingerprint(Observation::read(directory)?.basis())
    }

    /// Legacy grants can still prove identity while their recorded mount is current.
    pub fn matches(&self, directory: &Dir) -> io::Result<bool> {
        let observed = Observation::read(directory)?;
        if self == &fingerprint(observed.basis())? {
            return Ok(true);
        }
        #[cfg(target_os = "macos")]
        if matches!(observed.volume, Volume::Uuid(_)) {
            return Ok(self == &fingerprint((observed.device, observed.inode, observed.birth))?);
        }
        Ok(false)
    }

    /// Filesystem portion of execution evidence. Keep the existing numeric representation
    /// on platforms where we already use the device number.
    pub fn execution_basis(directory: &Dir) -> io::Result<serde_json::Value> {
        serde_json::to_value(Observation::read(directory)?.basis()).map_err(io::Error::other)
    }
}

/// The filesystem UUID of an open handle, when the volume advertises one.
#[cfg(target_os = "macos")]
pub fn volume_uuid(directory: &impl std::os::fd::AsRawFd) -> io::Result<Option<uuid::Uuid>> {
    // SAFETY: attrlist is an integer bitmask struct and all-zero is valid.
    let mut attributes: libc::attrlist = unsafe { std::mem::zeroed() };
    attributes.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    attributes.commonattr = libc::ATTR_CMN_RETURNED_ATTRS;
    attributes.volattr = libc::ATTR_VOL_INFO | libc::ATTR_VOL_UUID;

    #[repr(C)]
    struct VolumeAttributes {
        length: u32,
        returned: libc::attribute_set_t,
        uuid: [u8; 16],
    }
    // SAFETY: All fields are integers. The initialized buffer is writable for
    // exactly its supplied length, and directory owns the descriptor for the call.
    let mut output: VolumeAttributes = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::fgetattrlist(
            directory.as_raw_fd(),
            std::ptr::from_mut(&mut attributes).cast(),
            std::ptr::from_mut(&mut output).cast(),
            size_of::<VolumeAttributes>(),
            0,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::Unsupported {
            Ok(None)
        } else {
            Err(error)
        };
    }
    if output.returned.volattr & libc::ATTR_VOL_UUID == 0 {
        return Ok(None);
    }
    if output.length as usize != size_of::<VolumeAttributes>() {
        return Err(io::Error::other("invalid filesystem UUID attribute"));
    }
    let uuid = uuid::Uuid::from_bytes(output.uuid);
    Ok((!uuid.is_nil()).then_some(uuid))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn grants_use_volume_and_reject_a_replaced_directory() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("workspace");
        std::fs::create_dir(&path).unwrap();
        let directory = Dir::open_ambient_dir(&path, cap_std::ambient_authority()).unwrap();
        let mut observation = Observation::read(&directory).unwrap();
        assert!(matches!(observation.volume, Volume::Uuid(_)));
        let grant = DirectoryIdentity::capture(&directory).unwrap();
        let legacy =
            fingerprint((observation.device, observation.inode, observation.birth)).unwrap();
        assert!(legacy.matches(&directory).unwrap());
        observation.device = observation.device.wrapping_add(1);
        assert_eq!(grant, fingerprint(observation.basis()).unwrap());

        std::fs::rename(&path, temp.path().join("original")).unwrap();
        std::fs::create_dir(&path).unwrap();
        let replacement = Dir::open_ambient_dir(&path, cap_std::ambient_authority()).unwrap();
        assert!(!grant.matches(&replacement).unwrap());
        assert!(grant.matches(&directory).unwrap());
    }
}
