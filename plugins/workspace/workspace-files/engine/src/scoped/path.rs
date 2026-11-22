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

#[cfg(windows)]
use crate::failed;
use maka_agent_facts::tools::ToolError;
use std::path::{Path, PathBuf};

pub(super) fn candidates<'a>(
    roots: &'a [super::Root],
    absolute: &'a Path,
) -> Vec<(&'a super::Root, &'a Path, usize)> {
    let mut candidates: Vec<_> = roots
        .iter()
        .flat_map(|root| {
            root.aliases.iter().filter_map(move |alias| {
                relative_to(absolute, alias, &root.dir)
                    .map(|relative| (root, relative, alias.components().count()))
            })
        })
        .collect();
    // Narrow roots retain priority, but broader admitted capabilities may
    // authorize a ../ or relative-symlink target outside a narrower root.
    candidates.sort_by_key(|(_, _, length)| std::cmp::Reverse(*length));
    candidates
}

pub(super) fn resolve(cwd: &Path, input: &Path) -> Result<PathBuf, ToolError> {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if let Some(Component::Prefix(prefix)) = input.components().next()
            && (!input.is_absolute()
                || !matches!(
                    prefix.kind(),
                    Prefix::Disk(_)
                        | Prefix::VerbatimDisk(_)
                        | Prefix::UNC(..)
                        | Prefix::VerbatimUNC(..)
                ))
        {
            return Err(failed(
                "filesystem paths cannot use drive-relative or device namespaces",
            ));
        }
        if input.has_root() && !input.is_absolute() {
            let mut absolute = cwd.components().next().unwrap().as_os_str().to_owned();
            absolute.push(input);
            return Ok(absolute.into());
        }
    }
    if input.is_absolute() {
        return Ok(input.to_owned());
    }
    // PathBuf::push normalizes parent components for verbatim Windows paths.
    // Retain the requested components for capability lookup and mutation checks.
    let mut absolute = cwd.as_os_str().to_owned();
    absolute.push(std::path::MAIN_SEPARATOR_STR);
    absolute.push(input);
    Ok(absolute.into())
}

#[cfg(unix)]
fn relative_to<'a>(
    absolute: &'a Path,
    root: &Path,
    _directory: &cap_std::fs::Dir,
) -> Option<&'a Path> {
    absolute.strip_prefix(root).ok()
}

#[cfg(windows)]
fn relative_to<'a>(
    absolute: &'a Path,
    root: &Path,
    directory: &cap_std::fs::Dir,
) -> Option<&'a Path> {
    use std::path::{Component, Prefix};
    let mut remaining = absolute.components();
    let mut verify_alias = false;
    for expected in root.components() {
        let actual = remaining.next()?;
        verify_alias |= actual != expected;
        let equal = match (actual, expected) {
            (Component::Prefix(a), Component::Prefix(b)) => match (a.kind(), b.kind()) {
                (
                    Prefix::Disk(a) | Prefix::VerbatimDisk(a),
                    Prefix::Disk(b) | Prefix::VerbatimDisk(b),
                ) => a.eq_ignore_ascii_case(&b),
                (
                    Prefix::UNC(a, x) | Prefix::VerbatimUNC(a, x),
                    Prefix::UNC(b, y) | Prefix::VerbatimUNC(b, y),
                ) => ordinal_equal(a, b) && ordinal_equal(x, y),
                _ => actual == expected,
            },
            (Component::Normal(a), Component::Normal(b)) => ordinal_equal(a, b),
            _ => actual == expected,
        };
        if !equal {
            return None;
        }
    }
    if verify_alias {
        use cap_fs_ext::MetadataExt;
        use cap_std::{ambient_authority, fs::Dir};
        let prefix: PathBuf = absolute
            .components()
            .take(root.components().count())
            .collect();
        // Windows can enable case sensitivity per directory. String folding alone
        // must not route a distinct sibling to this captured capability. Only
        // inspect the requested root prefix; effects never use this ambient path.
        let requested = Dir::open_ambient_dir(prefix, ambient_authority())
            .ok()?
            .dir_metadata()
            .ok()?;
        let captured = directory.dir_metadata().ok()?;
        if (requested.dev(), requested.ino()) != (captured.dev(), captured.ino()) {
            return None;
        }
    }
    Some(remaining.as_path())
}

#[cfg(windows)]
fn ordinal_equal(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
    if left == right {
        return true;
    }
    let left: Vec<_> = left.encode_wide().collect();
    let right: Vec<_> = right.encode_wide().collect();
    let (Ok(left_len), Ok(right_len)) = (i32::try_from(left.len()), i32::try_from(right.len()))
    else {
        return false;
    };
    // SAFETY: both UTF-16 buffers are live for the exact explicitly supplied lengths.
    unsafe {
        CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) == CSTR_EQUAL
    }
}
