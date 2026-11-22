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

use std::{fs::File, io, path::Path};

/// Mechanical launch pin, not an authorization source.
pub(crate) struct Directory {
    #[cfg(unix)]
    pub(crate) file: File,
    #[cfg(windows)]
    _ancestors: Vec<File>,
}

impl Directory {
    pub(crate) fn capture(path: &Path, file: File) -> io::Result<Self> {
        if !file.metadata()?.is_dir() {
            return Err(io::Error::other("captured cwd is not a directory"));
        }
        #[cfg(unix)]
        {
            let _ = path;
            Ok(Self { file })
        }
        #[cfg(windows)]
        {
            use std::{
                fs::OpenOptions,
                os::windows::fs::{MetadataExt, OpenOptionsExt},
            };
            use windows_sys::Win32::Storage::FileSystem::*;
            let mut ancestors = Vec::new();
            // Pin parents first. Denying delete sharing prevents both rename
            // and replacement until the native child has captured its cwd.
            for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
                let pin = OpenOptions::new()
                    .access_mode(FILE_READ_ATTRIBUTES)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(ancestor)?;
                if pin.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(io::Error::other("captured cwd contains a reparse point"));
                }
                ancestors.push(pin);
            }
            if identity(&file)? != identity(ancestors.last().expect("absolute cwd"))? {
                return Err(io::Error::other("captured cwd identity changed"));
            }
            Ok(Self {
                _ancestors: ancestors,
            })
        }
    }
}

#[cfg(windows)]
fn identity(file: &File) -> io::Result<(u32, u32, u32)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::*;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    crate::windows::checked(unsafe {
        GetFileInformationByHandle(file.as_raw_handle(), &mut info)
    })?;
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}
