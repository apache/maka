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

use objc2::rc::{Retained, autoreleasepool};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSBundle, NSString, NSURL};
use std::{
    ffi::c_void,
    path::{Path, PathBuf},
};

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn LSRegisterURL(url: *const c_void, update: u8) -> i32;
}

pub(super) fn register(bundle: &Path) -> Result<(), String> {
    autoreleasepool(|_| {
        let url = file_url(bundle)?;
        // SAFETY: NSURL is toll-free bridged to CFURLRef. The retained URL
        // remains alive through the synchronous call; Boolean is UInt8.
        let status = unsafe { LSRegisterURL((&*url as *const NSURL).cast(), 1) };
        if status != 0 {
            return Err(format!(
                "LSRegisterURL failed for {} (OSStatus {status})",
                bundle.display()
            ));
        }
        validate(bundle)
    })
}

#[cfg(feature = "native-desktop")]
pub(crate) fn identifier(bundle: &Path) -> Result<String, String> {
    autoreleasepool(|_| {
        let url = file_url(bundle)?;
        NSBundle::bundleWithURL(&url)
            .and_then(|application| application.bundleIdentifier())
            .map(|identifier| identifier.to_string())
            .ok_or_else(|| {
                format!(
                    "Application bundle {} has no bundle identifier",
                    bundle.display()
                )
            })
    })
}

pub(crate) fn validate(bundle: &Path) -> Result<(), String> {
    autoreleasepool(|_| {
        let url = file_url(bundle)?;
        let application = NSBundle::bundleWithURL(&url)
            .ok_or_else(|| format!("macOS cannot read application bundle {}", bundle.display()))?;
        let identifier = application.bundleIdentifier().ok_or_else(|| {
            format!(
                "Application bundle {} has no bundle identifier",
                bundle.display()
            )
        })?;
        let resolved = NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&identifier)
            .and_then(|url| url.path())
            .map(|path| PathBuf::from(path.to_string()));
        validate_resolution(bundle, &identifier.to_string(), resolved.as_deref())
    })
}

fn file_url(bundle: &Path) -> Result<Retained<NSURL>, String> {
    let path = bundle.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve application bundle {}: {error}",
            bundle.display()
        )
    })?;
    let path = path
        .to_str()
        .ok_or_else(|| format!("Application bundle path is not UTF-8: {}", path.display()))?;
    Ok(NSURL::fileURLWithPath_isDirectory(
        &NSString::from_str(path),
        true,
    ))
}

fn validate_resolution(
    bundle: &Path,
    identifier: &str,
    resolved: Option<&Path>,
) -> Result<(), String> {
    let resolved = resolved.ok_or_else(|| {
        format!(
            "LaunchServices cannot resolve application {identifier} at {}",
            bundle.display()
        )
    })?;
    let actual = resolved.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve registered application {identifier} at {}: {error}",
            resolved.display()
        )
    })?;
    let expected = bundle.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve application bundle {}: {error}",
            bundle.display()
        )
    })?;
    if actual != expected {
        return Err(format!(
            "LaunchServices resolves application {identifier} to {}, not {}",
            actual.display(),
            expected.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_identity_requires_resolution_to_the_same_installed_bundle() {
        let root = tempfile::tempdir().unwrap();
        let installed = root.path().join("installed.app");
        let packaged = root.path().join("packaged.app");
        std::fs::create_dir(&installed).unwrap();
        std::fs::create_dir(&packaged).unwrap();
        let alias = root.path().join("alias.app");
        std::os::unix::fs::symlink(&installed, &alias).unwrap();
        assert!(validate_resolution(&installed, "test.identity", Some(&alias)).is_ok());
        assert!(
            validate_resolution(&installed, "test.identity", None)
                .unwrap_err()
                .contains("LaunchServices cannot resolve application test.identity")
        );
        let mismatch =
            validate_resolution(&installed, "test.identity", Some(&packaged)).unwrap_err();
        assert!(mismatch.contains("packaged.app"));
        assert!(mismatch.contains("installed.app"));
    }
}
