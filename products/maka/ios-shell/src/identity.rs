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

use maka_remote_client::DeviceIdentity;
use std::path::Path;

#[cfg(not(target_os = "ios"))]
pub fn load(support_dir: &Path) -> Result<DeviceIdentity, String> {
    DeviceIdentity::load_or_create(&support_dir.join("device.ed25519"))
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "ios")]
pub fn load(support_dir: &Path) -> Result<DeviceIdentity, String> {
    #[cfg(target_abi = "sim")]
    const MISSING_ENTITLEMENT: i32 = -34018;

    let identity = match load_keychain() {
        Ok(identity) => identity,
        #[cfg(target_abi = "sim")]
        Err(KeychainError::Security(err)) if err.code() == MISSING_ENTITLEMENT => {
            return load_simulator_file(support_dir);
        }
        Err(KeychainError::Security(err)) => return Err(err.to_string()),
        Err(KeychainError::Seed(err)) => return Err(err),
    };
    // A pre-release file may already have been copied by a backup. Never import it.
    match std::fs::remove_file(support_dir.join("device.ed25519")) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("remove old device identity: {err}")),
    }
    Ok(identity)
}

#[cfg(all(target_os = "ios", target_abi = "sim"))]
fn load_simulator_file(support_dir: &Path) -> Result<DeviceIdentity, String> {
    use objc2_foundation::{NSNumber, NSURL, NSURLIsExcludedFromBackupKey};
    use std::{ffi::CString, os::unix::ffi::OsStrExt, ptr::NonNull};

    let path = support_dir.join("simulator-device.ed25519");
    let identity = DeviceIdentity::load_or_create(&path).map_err(|err| err.to_string())?;
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|err| err.to_string())?;
    // SAFETY: path is a live NUL-terminated filesystem path; the resource key
    // accepts an NSNumber boolean.
    unsafe {
        let url = NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
            NonNull::from(path.as_c_str()).cast(),
            false,
            None,
        );
        url.setResourceValue_forKey_error(
            Some(&NSNumber::numberWithBool(true)),
            NSURLIsExcludedFromBackupKey,
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(identity)
}

#[cfg(target_os = "ios")]
enum KeychainError {
    Security(security_framework::base::Error),
    Seed(String),
}

#[cfg(target_os = "ios")]
impl From<security_framework::base::Error> for KeychainError {
    fn from(err: security_framework::base::Error) -> Self {
        Self::Security(err)
    }
}

#[cfg(target_os = "ios")]
fn load_keychain() -> Result<DeviceIdentity, KeychainError> {
    use core_foundation::{
        base::TCFType, data::CFData, dictionary::CFDictionary, string::CFString,
    };
    use security_framework::{
        access_control::{ProtectionMode, SecAccessControl},
        passwords::{PasswordOptions, generic_password},
    };
    use security_framework_sys::{
        base::{errSecDuplicateItem as DUPLICATE, errSecItemNotFound as NOT_FOUND},
        item::kSecValueData,
        keychain_item::SecItemAdd,
    };
    use zeroize::Zeroizing;

    let keychain_query = || {
        let mut options =
            PasswordOptions::new_generic_password("org.apache.maka.remote", "ed25519");
        options.set_access_synchronized(Some(false));
        options
    };
    let decode = |bytes| {
        let bytes: Zeroizing<Vec<u8>> = Zeroizing::new(bytes);
        let mut seed = Zeroizing::new([0; 32]);
        if bytes.len() != seed.len() {
            return Err(KeychainError::Seed(
                "invalid device identity in Keychain".into(),
            ));
        }
        seed.copy_from_slice(&bytes);
        Ok(DeviceIdentity::from_secret(seed))
    };
    match generic_password(keychain_query()) {
        Ok(bytes) => decode(bytes),
        Err(err) if err.code() == NOT_FOUND => {
            let identity =
                DeviceIdentity::generate().map_err(|err| KeychainError::Seed(err.to_string()))?;
            let access = SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
                0,
            )?;
            let mut options = keychain_query();
            options.set_access_control(access);
            // The high-level setter upserts. Use SecItemAdd without an output pointer
            // so a concurrent creator wins and we don't replace its seed.
            #[allow(deprecated)]
            let mut attributes = options.query;
            // SAFETY: kSecValueData is the framework's static CFString key.
            let value_key = unsafe { CFString::wrap_under_get_rule(kSecValueData) };
            attributes.push((
                value_key,
                CFData::from_buffer(identity.secret_bytes()).as_CFType(),
            ));
            let query = CFDictionary::from_CFType_pairs(&attributes);
            // SAFETY: query holds live CF types; no result allocation requested.
            match unsafe { SecItemAdd(query.as_concrete_TypeRef(), std::ptr::null_mut()) } {
                0 => Ok(identity),
                DUPLICATE => decode(generic_password(keychain_query())?),
                status => Err(security_framework::base::Error::from_code(status).into()),
            }
        }
        Err(err) => Err(err.into()),
    }
}
