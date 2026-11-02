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

pub(super) fn identify(executable: &Path) -> Result<Option<BrowserFamily>, ToolError> {
    let name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(
        name.as_str(),
        "google chrome"
            | "chrome.exe"
            | "chrome"
            | "google-chrome"
            | "google-chrome-stable"
            | "chromium"
            | "chromium-browser"
            | "chromium.exe"
    ) {
        return Ok(None);
    }
    let product = product(executable)?;
    let is_product = |name: &str| {
        product == name
            || product
                .strip_prefix(name)
                .and_then(|version| version.strip_prefix(' '))
                .and_then(|version| version.as_bytes().first())
                .is_some_and(u8::is_ascii_digit)
    };
    let family = if product == "com.google.Chrome" || is_product("Google Chrome") {
        BrowserFamily::Chrome
    } else if product == "org.chromium.Chromium" || is_product("Chromium") {
        BrowserFamily::Chromium
    } else {
        return Err(failed(format!(
            "cannot identify native-host browser {}: {product}",
            executable.display()
        )));
    };
    Ok(Some(family))
}

#[cfg(target_os = "linux")]
fn product(executable: &Path) -> Result<String, ToolError> {
    let output = std::process::Command::new(executable)
        .arg("--version")
        .output()
        .map_err(failed)?;
    if !output.status.success() {
        return Err(failed(format!(
            "browser version failed for {}: {}",
            executable.display(),
            output.status
        )));
    }
    String::from_utf8(output.stdout)
        .map(|text| text.trim().to_owned())
        .map_err(failed)
}

#[cfg(target_os = "macos")]
fn product(executable: &Path) -> Result<String, ToolError> {
    let contents = executable
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| failed("browser executable lacks its application bundle"))?;
    let output = std::process::Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(contents.join("Info.plist"))
        .output()
        .map_err(failed)?;
    if !output.status.success() {
        return Err(failed(format!(
            "browser bundle identity failed for {}: {}",
            executable.display(),
            output.status
        )));
    }
    String::from_utf8(output.stdout)
        .map(|text| text.trim().to_owned())
        .map_err(failed)
}

#[cfg(windows)]
fn product(executable: &Path) -> Result<String, ToolError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };
    fn query<'a>(block: &'a [u8], key: &str) -> Option<&'a [u8]> {
        let string_value = key.starts_with("\\StringFileInfo\\");
        let key: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
        let mut value = std::ptr::null_mut();
        let mut length = 0;
        // SAFETY: block is the successful GetFileVersionInfoW result and lives
        // through this borrowed view. VerQueryValueW supplies its byte extent.
        if unsafe { VerQueryValueW(block.as_ptr().cast(), key.as_ptr(), &mut value, &mut length) }
            == 0
            || value.is_null()
        {
            return None;
        }
        // String lengths are UTF-16 units; Translation length is bytes.
        let bytes = if string_value {
            length as usize * 2
        } else {
            length as usize
        };
        // SAFETY: Windows returns a view within the live version block above.
        Some(unsafe { std::slice::from_raw_parts(value.cast(), bytes) })
    }
    let filename: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: filename is NUL-terminated and the output storage is writable.
    let size = unsafe { GetFileVersionInfoSizeW(filename.as_ptr(), std::ptr::null_mut()) };
    if size == 0 {
        return Err(failed(std::io::Error::last_os_error()));
    }
    let mut block = vec![0_u8; size as usize];
    // SAFETY: block has precisely the size requested by Windows for this file.
    if unsafe { GetFileVersionInfoW(filename.as_ptr(), 0, size, block.as_mut_ptr().cast()) } == 0 {
        return Err(failed(std::io::Error::last_os_error()));
    }
    let translations = query(&block, "\\VarFileInfo\\Translation")
        .ok_or_else(|| failed("browser executable lacks version translations"))?;
    for pair in translations.chunks_exact(4) {
        let language = u16::from_le_bytes([pair[0], pair[1]]);
        let codepage = u16::from_le_bytes([pair[2], pair[3]]);
        if let Some(bytes) = query(
            &block,
            &format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\ProductName"),
        ) {
            let words: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|word| u16::from_le_bytes([word[0], word[1]]))
                .take_while(|word| *word != 0)
                .collect();
            return String::from_utf16(&words).map_err(failed);
        }
    }
    Err(failed("browser executable lacks ProductName"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "reads the product identity of an explicitly supplied installed browser"]
    fn installed_browser_product_identifies_its_registration_family() {
        let executable = std::env::var_os("MAKA_HANDOFF_BROWSER_EXECUTABLE")
            .expect("set the actual browser executable path");
        let expected = match std::env::var("MAKA_HANDOFF_BROWSER_FAMILY").as_deref() {
            Ok("chrome") => BrowserFamily::Chrome,
            Ok("chromium") => BrowserFamily::Chromium,
            _ => panic!("set MAKA_HANDOFF_BROWSER_FAMILY to chrome or chromium"),
        };
        assert_eq!(identify(Path::new(&executable)).unwrap(), Some(expected));
    }
}
