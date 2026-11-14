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

use cap_std::fs::Dir;
use std::{io, os::fd::AsRawFd};

#[derive(Debug)]
pub(super) struct Volume {
    pub(super) id: String,
    pub(super) stable_birth: bool,
}

pub(super) fn volume(directory: &Dir) -> io::Result<Volume> {
    // SAFETY: fstatfs initializes the struct on success, and the descriptor is held.
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    let result = unsafe { libc::fstatfs(directory.as_raw_fd(), filesystem.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    let filesystem = unsafe { filesystem.assume_init() };
    volume_from_statfs(directory, &filesystem)
}

fn volume_from_statfs(directory: &Dir, filesystem: &libc::statfs) -> io::Result<Volume> {
    // Cap-std may hold an O_PATH directory. Ioctls use a read handle to its `.`.
    match filesystem.f_type {
        libc::EXT4_SUPER_MAGIC | libc::TMPFS_MAGIC | libc::OVERLAYFS_SUPER_MAGIC => {
            // ext4/tmpfs derive f_fsid from their superblock UUID; overlayfs keeps a
            // stable superblock f_fsid across copy-up, whereas ovl_getattr switches
            // stx_btime from the lower inode to the newly created upper inode on first
            // directory copy-up (making birth timestamps unstable on overlayfs).
            // SAFETY: Linux fsid_t has two C int fields and both bit patterns are valid.
            let [first, second]: [u32; 2] = unsafe { std::mem::transmute(filesystem.f_fsid) };
            if [first, second] == [0, 0] {
                return Err(no_identity());
            }
            Ok(Volume {
                id: format!(
                    "linux-fsid:{:08x}:{first:08x}:{second:08x}",
                    filesystem.f_type
                ),
                stable_birth: filesystem.f_type != libc::OVERLAYFS_SUPER_MAGIC,
            })
        }
        libc::BTRFS_SUPER_MAGIC => Ok(Volume {
            id: btrfs_volume(directory)?,
            stable_birth: true,
        }),
        libc::XFS_SUPER_MAGIC => {
            // XFS f_fsid is a device number. Read its on-disk UUID via XFS_IOC_FSGEOMETRY_V1.
            #[repr(C)]
            struct Geometry {
                layout: [u32; 8],
                counts: [u64; 4],
                uuid: [u8; 16],
                flags: [u32; 7],
            }
            let mut geometry = Geometry {
                layout: [0; 8],
                counts: [0; 4],
                uuid: [0; 16],
                flags: [0; 7],
            };
            ioctl_read(&directory.open(".")?, b'X', 100, &mut geometry)?;
            Ok(Volume {
                id: uuid(&geometry.uuid)?,
                stable_birth: true,
            })
        }
        _ => {
            // FS_IOC_GETFSUUID supplies the filesystem UUID on other filesystems
            // that expose one. A missing UUID cannot authorize a durable grant.
            let mut fsuuid = [0_u8; 17];
            ioctl_read(&directory.open(".")?, 0x15, 0, &mut fsuuid)?;
            let size = usize::from(fsuuid[0]);
            Ok(Volume {
                id: uuid(fsuuid.get(1..1 + size).ok_or_else(no_identity)?)?,
                stable_birth: true,
            })
        }
    }
}

fn btrfs_volume(directory: &Dir) -> io::Result<String> {
    #[repr(C)]
    struct FilesystemInfo {
        devices: [u64; 2],
        fsid: [u8; 16],
        geometry: [u32; 4],
        flags: u64,
        generation: u64,
        metadata_uuid: [u8; 16],
        reserved: [u8; 944],
    }
    #[repr(C)]
    struct SubvolumeInfo {
        tree_id: u64,
        data: [u8; 496],
    }
    const METADATA_UUID: u64 = 1 << 2;
    let mut filesystem = FilesystemInfo {
        devices: [0; 2],
        fsid: [0; 16],
        geometry: [0; 4],
        flags: METADATA_UUID,
        generation: 0,
        metadata_uuid: [0; 16],
        reserved: [0; 944],
    };
    let mut subvolume = SubvolumeInfo {
        tree_id: 0,
        data: [0; 496],
    };
    let directory = directory.open(".")?;
    // A cloned filesystem may have a temporary mount FSID. The metadata UUID
    // and the on-disk subvolume tree ID do not depend on that mount.
    ioctl_read(&directory, 0x94, 31, &mut filesystem)?;
    ioctl_read(&directory, 0x94, 60, &mut subvolume)?;
    if filesystem.flags & METADATA_UUID == 0 || subvolume.tree_id == 0 {
        return Err(no_identity());
    }
    Ok(format!(
        "{}:{:016x}",
        uuid(&filesystem.metadata_uuid)?,
        subvolume.tree_id
    ))
}

fn ioctl_read<T>(directory: &impl AsRawFd, kind: u8, number: u8, buffer: &mut T) -> io::Result<()> {
    // Linux x86_64/aarch64 use the asm-generic _IOR encoding.
    let request =
        (2 << 30) | ((size_of::<T>() as u32) << 16) | (u32::from(kind) << 8) | u32::from(number);
    // SAFETY: directory owns the descriptor and the request writes at most size_of::<T>() bytes.
    if unsafe {
        libc::ioctl(
            directory.as_raw_fd(),
            request as _,
            std::ptr::from_mut(buffer),
        )
    } == 0
    {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOTTY) {
        return Err(no_identity());
    }
    Err(error)
}

fn uuid(bytes: &[u8]) -> io::Result<String> {
    if bytes.iter().all(|byte| *byte == 0) {
        return Err(no_identity());
    }
    Ok(format!("linux-uuid:{}", hex::encode(bytes)))
}

fn no_identity() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "filesystem has no stable volume identity",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlayfs_statfs_requires_nonzero_fsid_and_marks_birth_unstable() {
        let dir = tempfile::tempdir().unwrap();
        let opened = Dir::open_ambient_dir(dir.path(), cap_std::ambient_authority()).unwrap();
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        stat.f_type = libc::OVERLAYFS_SUPER_MAGIC;

        let zero_err = volume_from_statfs(&opened, &stat).unwrap_err();
        assert_eq!(zero_err.kind(), io::ErrorKind::Unsupported);

        stat.f_fsid = unsafe { std::mem::transmute([0x1234_5678_u32, 0x9abc_def0_u32]) };
        let parsed = volume_from_statfs(&opened, &stat).unwrap();
        assert_eq!(parsed.id, "linux-fsid:794c7630:12345678:9abcdef0");
        assert!(!parsed.stable_birth);
    }
}
