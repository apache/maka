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

//! Resolve file gestures into local paths before taking their native snapshots.

use std::path::{Path, PathBuf};

/// The native snapshot performs the authoritative open and regular-file check.
pub(crate) fn resolve(items: &[String]) -> Result<Vec<PathBuf>, String> {
    if items.is_empty() {
        return Err("The file gesture did not contain any files".into());
    }
    items.iter().map(|item| normalize(item)).collect()
}

pub(crate) fn pasted_directories(items: &[String]) -> Result<Option<String>, String> {
    let paths = resolve(items)?;
    if !paths.iter().any(|path| path.is_dir()) {
        return Ok(None);
    }
    paths
        .iter()
        .map(|path| {
            path.to_str()
                .ok_or_else(|| "The pasted path is not valid Unicode".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|paths| Some(paths.join("\n")))
}

fn drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn file_uri(value: &str) -> bool {
    value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
}

fn normalize(value: &str) -> Result<PathBuf, String> {
    let value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value);
    let path = if file_uri(value) {
        let uri = url::Url::parse(value).map_err(|error| format!("Invalid file URI: {error}"))?;
        if uri.query().is_some() || uri.fragment().is_some() {
            return Err("A selected file URI cannot contain a query or fragment".into());
        }
        #[cfg(not(windows))]
        let windows = {
            let decoded = || {
                percent_encoding::percent_decode_str(uri.path())
                    .decode_utf8()
                    .map_err(|_| "The Windows file URI is not valid Unicode".to_owned())
            };
            if let Some(host) = uri.host_str().filter(|host| *host != "localhost") {
                Some(windows_path(&format!(
                    "\\\\{host}{}",
                    decoded()?.replace('/', "\\")
                ))?)
            } else if uri.path().strip_prefix('/').is_some_and(drive_path) {
                Some(windows_path(&decoded()?[1..])?)
            } else {
                None
            }
        };
        #[cfg(windows)]
        let windows: Option<PathBuf> = None;
        match windows {
            Some(path) => path,
            None => uri
                .to_file_path()
                .map_err(|_| "The file URI does not identify a local absolute path".to_owned())?,
        }
    } else if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else if drive_path(value) || value.starts_with("\\\\") {
        windows_path(value)?
    } else {
        return Err("The selected file needs an absolute path".into());
    };
    Ok(path.components().collect())
}

#[cfg(windows)]
fn windows_path(value: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(value))
}

pub(crate) fn is_wsl() -> bool {
    cfg!(target_os = "linux")
        && std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|release| release.to_ascii_lowercase().contains("microsoft"))
}

#[cfg(not(windows))]
fn windows_path(value: &str) -> Result<PathBuf, String> {
    if !is_wsl() {
        return Err("Windows file paths require Windows or WSL".into());
    }
    let output = std::process::Command::new("wslpath")
        .args(["-u", "--", value])
        .output()
        .map_err(|error| format!("Could not translate the selected Windows path: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not translate the selected Windows path ({})",
            output.status
        ));
    }
    let path = String::from_utf8(output.stdout)
        .map_err(|_| "The translated Windows path is not valid Unicode")?;
    let path = PathBuf::from(path.strip_suffix('\n').unwrap_or(&path));
    if !path.is_absolute() {
        return Err("The translated Windows path is not absolute".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_directories_preserve_path_order_and_leave_file_lists_for_upload() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap().to_owned();
        let file = root.path().join("notes.txt").to_str().unwrap().to_owned();
        std::fs::write(&file, b"notes").unwrap();
        let uri = url::Url::from_file_path(root.path()).unwrap().into();
        let directory_uri = url::Url::from_directory_path(root.path()).unwrap().into();
        for selected in [
            directory.clone(),
            format!("{directory}/"),
            uri,
            directory_uri,
        ] {
            assert_eq!(pasted_directories(&[selected]), Ok(Some(directory.clone())));
        }
        #[cfg(unix)]
        assert_eq!(
            pasted_directories(&["file:///".to_owned()]),
            Ok(Some("/".to_owned()))
        );
        assert_eq!(
            pasted_directories(&[file.clone(), directory.clone()]),
            Ok(Some(format!("{file}\n{directory}")))
        );
        for selected in [file, root.path().join("missing.txt").display().to_string()] {
            assert_eq!(pasted_directories(&[selected]), Ok(None));
        }
    }

    #[test]
    fn native_file_paths_preserve_selected_bytes_through_uri_and_wsl_normalization() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("image with space 中文.png");
        std::fs::write(&file, b"the original selected bytes").unwrap();
        let uri = url::Url::from_file_path(&file).unwrap().to_string();
        let paths = resolve(&[uri]).unwrap();
        assert_eq!(paths, vec![file.clone()]);
        assert_eq!(
            std::fs::read(&paths[0]).unwrap(),
            b"the original selected bytes"
        );
        assert_eq!(
            resolve(&[format!("\"{}\"", file.display())]),
            Ok(vec![file.clone()])
        );
        #[cfg(target_os = "linux")]
        if is_wsl() {
            let output = std::process::Command::new("wslpath")
                .arg("-w")
                .arg(&file)
                .output()
                .unwrap();
            assert!(output.status.success());
            let windows = String::from_utf8(output.stdout).unwrap();
            let windows = windows.strip_suffix('\n').unwrap();
            let uri = nsh_core::platform::clipboard::file_url(windows);
            assert_eq!(resolve(&[windows.to_owned()]), Ok(vec![file.clone()]));
            assert_eq!(resolve(&[uri]), Ok(vec![file]));
        }
    }
}
