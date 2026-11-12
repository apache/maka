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

//! Read-only identity checks for ordinary file grants. No workspace marker is created.
use cap_std::{ambient_authority, fs::Dir};
use maka_sandbox::workspace::DirectoryIdentity;
use std::{
    io,
    path::{Path, PathBuf},
};

pub fn capture(path: &Path) -> io::Result<(PathBuf, DirectoryIdentity)> {
    let path = path.canonicalize()?;
    let directory = Dir::open_ambient_dir(&path, ambient_authority())?;
    Ok((path, identity(&directory)?))
}
pub fn open(path: &Path, expected: &DirectoryIdentity) -> io::Result<Dir> {
    let directory = Dir::open_ambient_dir(path, ambient_authority())?;
    if !expected.matches(&directory)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "authorized directory was replaced",
        ));
    }
    Ok(directory)
}
/// Identify the held directory, without reopening its ambient pathname.
pub fn identity(directory: &Dir) -> io::Result<DirectoryIdentity> {
    DirectoryIdentity::capture(directory)
}
