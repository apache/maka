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

use crate::Error;
use std::{borrow::Cow, cmp::Ordering, path::Path};

/// Translate a Host-resolved path without reopening it or changing its identity.
/// This is not a resolver for raw user input.
pub fn policy_path_from_resolved(path: &Path) -> Result<Cow<'_, Path>, Error> {
    #[cfg(windows)]
    let path = windows_policy_spelling(path)?;
    #[cfg(not(windows))]
    let path = Cow::Borrowed(path);
    validate(&path)?;
    Ok(path)
}

#[cfg(windows)]
fn windows_policy_spelling(path: &Path) -> Result<Cow<'_, Path>, Error> {
    use std::path::{Component, PathBuf, Prefix};
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return Ok(Cow::Borrowed(path));
    };
    let invalid = || Error::Invalid("noncanonical Windows policy path".into());
    let unc = match prefix.kind() {
        Prefix::VerbatimDisk(_) => false,
        Prefix::VerbatimUNC(..) => true,
        _ => return Ok(Cow::Borrowed(path)),
    };
    let text = path.to_str().ok_or_else(invalid)?;
    let (policy_tail, names) = if unc {
        let tail = text.strip_prefix(r"\\?\UNC\").ok_or_else(invalid)?;
        let mut parts = tail.split('\\');
        if parts.next().is_none_or(str::is_empty) || parts.next().is_none_or(str::is_empty) {
            return Err(invalid());
        }
        (tail, tail)
    } else {
        let dos = text.strip_prefix(r"\\?\").ok_or_else(invalid)?;
        let names = dos.get(2..).and_then(|tail| tail.strip_prefix('\\'));
        (dos, names.ok_or_else(invalid)?)
    };
    // Removing a verbatim prefix must not reinterpret a component as a
    // separator, device name, or trimmed Win32 spelling. No MAX_PATH limit:
    // policy matching is lexical, and existing native guards handle long paths.
    if names.trim_end_matches('\\').split('\\').any(|name| {
        name.bytes().any(|byte| byte < b' ')
            || name.contains(['/', ':', '?', '*', '<', '>', '"', '|'])
            || name.ends_with(['.', ' '])
            || (!unc && is_dos_device(name))
    }) {
        return Err(invalid());
    }
    Ok(if unc {
        Cow::Owned(PathBuf::from(format!(r"\\{policy_tail}")))
    } else {
        Cow::Borrowed(Path::new(policy_tail))
    })
}

#[cfg(windows)]
fn is_dos_device(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device))
        || stem.get(..3).is_some_and(|prefix| {
            (prefix.eq_ignore_ascii_case("COM") || prefix.eq_ignore_ascii_case("LPT"))
                && matches!(
                    &stem[3..],
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
        })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn resolved_path_projection_preserves_disk_and_unc_roots() {
        for (resolved, expected) in [
            (r"\\?\C:\project\worktree", r"C:\project\worktree"),
            (r"\\?\UNC\server\share\worktree", r"\\server\share\worktree"),
        ] {
            let resolved = Path::new(resolved);
            assert!(validate(resolved).is_err());
            assert_eq!(
                policy_path_from_resolved(resolved).unwrap().as_ref(),
                Path::new(expected)
            );
        }
    }

    #[test]
    fn resolved_path_projection_rejects_names_changed_by_win32() {
        for path in [
            r"\\?\C:\project\directory.",
            r"\\?\C:\project\NUL.txt",
            r"\\?\C:\project\COM¹.txt",
            r"\\?\C:/project",
            r"\\?\UNC\server\share\literal/slash",
            r"\\?\UNC\server\share\ancestor\..\file",
            r"\\?\UNC\.\share\file",
            r"\\?\Volume{deadbeef}\file",
        ] {
            assert!(
                policy_path_from_resolved(Path::new(path)).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn resolved_path_projection_preserves_long_local_paths() {
        let policy = format!(r"C:\{}file", "directory\\".repeat(30));
        let resolved = format!(r"\\?\{policy}");
        assert_eq!(
            policy_path_from_resolved(Path::new(&resolved))
                .unwrap()
                .as_ref(),
            Path::new(&policy)
        );
    }
}

pub(crate) fn validate(path: &Path) -> Result<(), Error> {
    let text = path
        .to_str()
        .ok_or_else(|| Error::Invalid("policy path is not Unicode".into()))?;
    if !path.is_absolute()
        || text.contains('\0')
        || text
            .split(std::path::is_separator)
            .any(|c| c == "." || c == "..")
    {
        return Err(Error::Invalid(
            "policy path must be absolute without dot segments".into(),
        ));
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        // The resolver must convert native verbatim paths before policy matching.
        // Reject Win32 alias spellings instead of applying a broader default.
        if path.components().any(|c| match c {
            Component::Prefix(p) => !matches!(p.kind(), Prefix::Disk(_) | Prefix::UNC(..)),
            Component::Normal(p) => p
                .to_str()
                .is_none_or(|s| s.contains(':') || s.ends_with(['.', ' '])),
            _ => false,
        }) {
            return Err(Error::Invalid("noncanonical Windows policy path".into()));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn compare(a: &Path, b: &Path) -> Ordering {
    a.cmp(b)
}

#[cfg(target_os = "macos")]
pub(crate) fn compare(a: &Path, b: &Path) -> Ordering {
    use unicode_normalization::UnicodeNormalization;
    if a.as_os_str().as_encoded_bytes().is_ascii() && b.as_os_str().as_encoded_bytes().is_ascii() {
        return a.cmp(b);
    }
    fn normalized(path: &Path) -> impl Iterator<Item = String> + '_ {
        path.components()
            .map(|part| part.as_os_str().to_string_lossy().nfd().collect())
    }
    normalized(a).cmp(normalized(b))
}

#[cfg(windows)]
pub(crate) fn compare(a: &Path, b: &Path) -> Ordering {
    let mut a = a.components();
    let mut b = b.components();
    loop {
        match (a.next(), b.next()) {
            (Some(a), Some(b)) => {
                let ordering = component_compare(a, b);
                if !ordering.is_eq() {
                    return ordering;
                }
            }
            (a, b) => return a.is_some().cmp(&b.is_some()),
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

#[cfg(target_os = "macos")]
pub(crate) fn within(path: &Path, root: &Path) -> bool {
    let mut components = path.components();
    root.components().all(|root| {
        components.next().is_some_and(|part| {
            compare(Path::new(part.as_os_str()), Path::new(root.as_os_str())).is_eq()
        })
    })
}

#[cfg(windows)]
pub(crate) fn within(path: &Path, root: &Path) -> bool {
    let mut components = path.components();
    root.components().all(|root| {
        components
            .next()
            .is_some_and(|part| component_compare(part, root).is_eq())
    })
}

#[cfg(windows)]
fn component_compare(a: std::path::Component<'_>, b: std::path::Component<'_>) -> Ordering {
    use std::path::{Component, Prefix};
    match (a, b) {
        (Component::Prefix(a), Component::Prefix(b)) => match (a.kind(), b.kind()) {
            (Prefix::Disk(a), Prefix::Disk(b)) => {
                a.to_ascii_uppercase().cmp(&b.to_ascii_uppercase())
            }
            (Prefix::UNC(a, x), Prefix::UNC(b, y)) => {
                ordinal_compare(a, b).then_with(|| ordinal_compare(x, y))
            }
            _ => a.kind().cmp(&b.kind()),
        },
        _ => ordinal_compare(a.as_os_str(), b.as_os_str()),
    }
}

#[cfg(windows)]
fn ordinal_compare(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> Ordering {
    use std::os::windows::ffi::OsStrExt;
    let a: Vec<_> = a.encode_wide().collect();
    let b: Vec<_> = b.encode_wide().collect();
    // Validated policy paths are bounded well below i32::MAX. Ordinal comparison
    // follows Windows case folding without expanding Unicode characters.
    let result = unsafe {
        windows_sys::Win32::Globalization::CompareStringOrdinal(
            a.as_ptr(),
            a.len() as i32,
            b.as_ptr(),
            b.len() as i32,
            1,
        )
    };
    match result {
        1 => Ordering::Less,
        2 => Ordering::Equal,
        3 => Ordering::Greater,
        _ => a.cmp(&b),
    }
}

/// Normalize separators for glob matching just as path components do for rules.
/// Windows case mapping uses the OS filesystem table, not regex ASCII folding.
pub(crate) fn glob_text(text: &str) -> Result<String, Error> {
    let mut normalized = String::new();
    if cfg!(windows)
        && text.starts_with(['/', '\\'])
        && text.chars().nth(1).is_some_and(std::path::is_separator)
    {
        normalized.push('/');
    }
    for part in text
        .split(std::path::is_separator)
        .filter(|part| !part.is_empty())
    {
        if !normalized.is_empty() || text.starts_with(std::path::is_separator) {
            normalized.push('/');
        }
        normalized.push_str(part);
    }
    if normalized.is_empty() || (cfg!(windows) && normalized.ends_with(':')) {
        normalized.push('/');
    }
    #[cfg(windows)]
    {
        uppercase(&normalized)
    }
    #[cfg(target_os = "macos")]
    {
        use unicode_normalization::UnicodeNormalization;
        // Seatbelt matches decomposed UTF-8 pathname bytes, including wildcards.
        Ok(normalized.nfd().collect())
    }
    #[cfg(target_os = "linux")]
    {
        Ok(normalized)
    }
}

#[cfg(windows)]
fn uppercase(text: &str) -> Result<String, Error> {
    use windows_sys::Win32::Globalization::{LCMAP_UPPERCASE, LCMapStringEx};
    let input: Vec<_> = text.encode_utf16().collect();
    let invariant = [0u16];
    // No LCMAP_LINGUISTIC_CASING: filesystem casing, independent of user locale.
    let map = |output: &mut [u16]| unsafe {
        LCMapStringEx(
            invariant.as_ptr(),
            LCMAP_UPPERCASE,
            input.as_ptr(),
            input.len() as i32,
            output.as_mut_ptr(),
            output.len() as i32,
            std::ptr::null(),
            std::ptr::null(),
            0,
        )
    };
    let length = map(&mut []);
    if length == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut output = vec![0; length as usize];
    if map(&mut output) != length {
        return Err(std::io::Error::last_os_error().into());
    }
    // Ordinal path comparison uses UTF-16 code units. LCMapStringEx also folds
    // supplementary characters; preserve their surrogate pairs to keep glob
    // matching consistent with CompareStringOrdinal.
    if output.len() != input.len() {
        return Err(Error::Invalid(
            "Windows path casing changed its length".into(),
        ));
    }
    for (source, mapped) in input.iter().zip(&mut output) {
        if (0xD800..=0xDFFF).contains(source) {
            *mapped = *source;
        }
    }
    String::from_utf16(&output).map_err(|_| Error::Invalid("invalid Windows case mapping".into()))
}
