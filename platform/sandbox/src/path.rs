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
use std::{cmp::Ordering, path::Path};

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
