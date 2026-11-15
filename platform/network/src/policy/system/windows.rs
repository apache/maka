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

use super::wininet::{bypassed, select};
use reqwest::Url;
use std::{ffi::c_void, ptr, sync::OnceLock};
use windows_sys::{
    Win32::{
        Foundation::{GetLastError, GlobalFree},
        Networking::WinHttp::{
            ERROR_WINHTTP_LOGIN_FAILURE, WINHTTP_ACCESS_TYPE_NAMED_PROXY,
            WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_AUTO_DETECT_TYPE_DHCP,
            WINHTTP_AUTO_DETECT_TYPE_DNS_A, WINHTTP_AUTOPROXY_AUTO_DETECT,
            WINHTTP_AUTOPROXY_CONFIG_URL, WINHTTP_AUTOPROXY_OPTIONS,
            WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WINHTTP_PROXY_INFO,
            WinHttpGetIEProxyConfigForCurrentUser, WinHttpGetProxyForUrl, WinHttpOpen,
            WinHttpSetTimeouts,
        },
    },
    core::PWSTR,
};

/// The current user's Internet Settings, as Edge and WinINet read them.
#[derive(PartialEq, Eq, Hash)]
pub(super) struct Config {
    auto_detect: bool,
    auto_config_url: Option<String>,
    proxy: Option<String>,
    bypass: Option<String>,
}

pub(super) fn capture() -> Result<Option<Config>, crate::Error> {
    let mut raw = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut raw) } == 0 {
        return Ok(None);
    }
    Ok(Some(Config {
        auto_detect: raw.fAutoDetect != 0,
        auto_config_url: take(raw.lpszAutoConfigUrl),
        proxy: take(raw.lpszProxy),
        bypass: take(raw.lpszProxyBypass),
    }))
}

/// Automatic configuration wins; when discovery or the script fails, WinINet
/// falls back to the manual proxy, and so do we.
pub(super) fn resolve(config: &Config, target: &Url) -> Option<Url> {
    if (config.auto_detect || config.auto_config_url.is_some())
        && let Some(list) = automatic(config, target)
    {
        return list.and_then(|list| select(&list, target.scheme()));
    }
    let proxy = config.proxy.as_deref()?;
    if config
        .bypass
        .as_deref()
        .is_some_and(|list| bypassed(list, target))
    {
        return None;
    }
    select(proxy, target.scheme())
}

struct Session(*mut c_void);
// SAFETY: WinHTTP session handles may be used from any thread.
unsafe impl Send for Session {}
unsafe impl Sync for Session {}

/// `None` when auto-configuration failed; `Some(None)` for a direct result.
fn automatic(config: &Config, target: &Url) -> Option<Option<String>> {
    // One process-wide session keeps WinHTTP's PAC download and result cache.
    static SESSION: OnceLock<Option<Session>> = OnceLock::new();
    let session = SESSION
        .get_or_init(|| {
            let handle = unsafe {
                WinHttpOpen(
                    ptr::null(),
                    WINHTTP_ACCESS_TYPE_NO_PROXY,
                    ptr::null(),
                    ptr::null(),
                    0,
                )
            };
            if handle.is_null() {
                return None;
            }
            unsafe { WinHttpSetTimeouts(handle, 10_000, 10_000, 10_000, 10_000) };
            Some(Session(handle))
        })
        .as_ref()?;
    let script = config.auto_config_url.as_deref().map(wide);
    let mut options = WINHTTP_AUTOPROXY_OPTIONS {
        dwFlags: if config.auto_detect {
            WINHTTP_AUTOPROXY_AUTO_DETECT
        } else {
            0
        } | if script.is_some() {
            WINHTTP_AUTOPROXY_CONFIG_URL
        } else {
            0
        },
        dwAutoDetectFlags: if config.auto_detect {
            WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A
        } else {
            0
        },
        lpszAutoConfigUrl: script
            .as_ref()
            .map_or(ptr::null(), |script| script.as_ptr()),
        ..Default::default()
    };
    let target = wide(target.as_str());
    let mut info = WINHTTP_PROXY_INFO::default();
    let mut resolved =
        unsafe { WinHttpGetProxyForUrl(session.0, target.as_ptr(), &mut options, &mut info) } != 0;
    // Domain credentials go only to a PAC URL the user configured, never to a
    // server the network advertised through WPAD (Microsoft's retry pattern).
    if !resolved && script.is_some() && unsafe { GetLastError() } == ERROR_WINHTTP_LOGIN_FAILURE {
        options.dwFlags = WINHTTP_AUTOPROXY_CONFIG_URL;
        options.dwAutoDetectFlags = 0;
        options.fAutoLogonIfChallenged = 1;
        resolved =
            unsafe { WinHttpGetProxyForUrl(session.0, target.as_ptr(), &mut options, &mut info) }
                != 0;
    }
    if !resolved {
        return None;
    }
    let list = take(info.lpszProxy);
    take(info.lpszProxyBypass);
    Some(
        (info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY)
            .then_some(list)
            .flatten(),
    )
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

/// Copies and frees a string WinHTTP allocated for the caller.
fn take(value: PWSTR) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let length = (0..).take_while(|&i| unsafe { *value.add(i) } != 0).count();
    let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, length) });
    unsafe { GlobalFree(value.cast()) };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}
