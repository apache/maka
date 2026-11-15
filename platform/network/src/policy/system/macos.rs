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

use objc2_cf_network::{
    CFNetworkCopyProxiesForAutoConfigurationScript, CFNetworkCopyProxiesForURL,
    CFNetworkCopySystemProxySettings, CFNetworkExecuteProxyAutoConfigurationURL,
    kCFProxyAutoConfigurationJavaScriptKey, kCFProxyAutoConfigurationURLKey, kCFProxyHostNameKey,
    kCFProxyPortNumberKey, kCFProxyTypeAutoConfigurationJavaScript,
    kCFProxyTypeAutoConfigurationURL, kCFProxyTypeHTTP, kCFProxyTypeHTTPS, kCFProxyTypeKey,
    kCFProxyTypeNone, kCFProxyTypeSOCKS,
};
use objc2_core_foundation::{
    CFArray, CFDictionary, CFError, CFNumber, CFRetained, CFRunLoop, CFStreamClientContext,
    CFString, CFType, CFURL,
};
use reqwest::Url;
use std::{
    ffi::c_void,
    ptr::{self, NonNull},
    time::{Duration, Instant},
};

type Proxy = CFDictionary<CFString, CFType>;

#[derive(PartialEq, Eq, Hash)]
pub(super) struct Config(CFRetained<CFDictionary>);

// SAFETY: CFNetworkCopySystemProxySettings returns an immutable dictionary, and
// immutable Core Foundation collections may be shared between threads.
unsafe impl Send for Config {}
unsafe impl Sync for Config {}

pub(super) fn capture() -> Result<Option<Config>, crate::Error> {
    Ok(unsafe { CFNetworkCopySystemProxySettings() }.map(Config))
}

/// CFNetwork applies the exception list, simple-hostname exclusion, PAC and
/// WPAD exactly as Safari does. Its failure semantics are kept too: a PAC
/// script that cannot be fetched or evaluated means a direct connection.
pub(super) fn resolve(config: &Config, target: &Url) -> Option<Url> {
    let target = CFURL::from_string(None, &CFString::from_str(target.as_str()), None)?;
    let proxies = unsafe { CFNetworkCopyProxiesForURL(&target, &config.0) };
    first(&proxies, &target)
}

fn first(proxies: &CFArray, target: &CFURL) -> Option<Url> {
    let proxies = unsafe { proxies.cast_unchecked::<Proxy>() };
    for proxy in proxies.iter() {
        let kind = proxy
            .get(unsafe { kCFProxyTypeKey })?
            .downcast::<CFString>()
            .ok()?;
        let kind = &*kind;
        if kind == unsafe { kCFProxyTypeNone } {
            return None;
        }
        // kCFProxyTypeHTTPS is the proxy used for https destinations; the
        // proxy itself still speaks plain HTTP (CONNECT).
        let scheme = if kind == unsafe { kCFProxyTypeHTTP } || kind == unsafe { kCFProxyTypeHTTPS }
        {
            "http"
        } else if kind == unsafe { kCFProxyTypeSOCKS } {
            "socks5h"
        } else if kind == unsafe { kCFProxyTypeAutoConfigurationURL } {
            let script = proxy
                .get(unsafe { kCFProxyAutoConfigurationURLKey })?
                .downcast::<CFURL>()
                .ok()?;
            let proxies = execute(&script, target)?;
            return first(&proxies, target);
        } else if kind == unsafe { kCFProxyTypeAutoConfigurationJavaScript } {
            let script = proxy
                .get(unsafe { kCFProxyAutoConfigurationJavaScriptKey })?
                .downcast::<CFString>()
                .ok()?;
            let proxies = unsafe {
                CFNetworkCopyProxiesForAutoConfigurationScript(&script, target, ptr::null_mut())
            }?;
            return first(&proxies, target);
        } else {
            continue;
        };
        let host = proxy
            .get(unsafe { kCFProxyHostNameKey })?
            .downcast::<CFString>()
            .ok()?
            .to_string();
        let port = proxy
            .get(unsafe { kCFProxyPortNumberKey })
            .and_then(|port| port.downcast::<CFNumber>().ok())
            .and_then(|port| port.as_i32())
            .and_then(|port| u16::try_from(port).ok());
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host
        };
        if let Some(proxy) = super::endpoint(
            scheme,
            &match port {
                Some(port) => format!("{host}:{port}"),
                None => host,
            },
        ) {
            return Some(proxy);
        }
    }
    None
}

/// Runs CFNetwork's PAC engine on this thread's run loop. CFNetwork fetches the
/// script, performs WPAD discovery when the URL came from it, and evaluates it.
fn execute(script: &CFURL, target: &CFURL) -> Option<CFRetained<CFArray>> {
    unsafe extern "C-unwind" fn done(
        client: NonNull<c_void>,
        proxies: NonNull<CFArray>,
        error: *mut CFError,
    ) {
        let outcome = unsafe {
            client
                .cast::<Option<Option<CFRetained<CFArray>>>>()
                .as_mut()
        };
        *outcome = Some(
            error
                .is_null()
                .then(|| unsafe { CFRetained::retain(proxies) }),
        );
        if let Some(run_loop) = CFRunLoop::current() {
            run_loop.stop();
        }
    }
    let mut outcome: Option<Option<CFRetained<CFArray>>> = None;
    let mut context = CFStreamClientContext {
        version: 0,
        info: (&raw mut outcome).cast(),
        retain: None,
        release: None,
        copyDescription: None,
    };
    let source = unsafe {
        CFNetworkExecuteProxyAutoConfigurationURL(
            script,
            target,
            Some(done),
            NonNull::from(&mut context),
        )
    };
    let run_loop = CFRunLoop::current()?;
    let mode = CFString::from_static_str("org.maka.network.pac");
    run_loop.add_source(Some(&source), Some(&mode));
    let deadline = Instant::now() + Duration::from_secs(15);
    while outcome.is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        CFRunLoop::run_in_mode(Some(&mode), remaining.as_secs_f64(), true);
    }
    run_loop.remove_source(Some(&source), Some(&mode));
    source.invalidate();
    outcome.flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_cf_network::{
        kCFNetworkProxiesExceptionsList, kCFNetworkProxiesHTTPEnable, kCFNetworkProxiesHTTPPort,
        kCFNetworkProxiesHTTPProxy, kCFNetworkProxiesHTTPSEnable, kCFNetworkProxiesHTTPSPort,
        kCFNetworkProxiesHTTPSProxy, kCFNetworkProxiesProxyAutoConfigEnable,
        kCFNetworkProxiesProxyAutoConfigJavaScript,
    };

    fn settings(entries: &[(&CFString, CFRetained<CFType>)]) -> Config {
        let keys: Vec<&CFString> = entries.iter().map(|(key, _)| *key).collect();
        let values: Vec<&CFType> = entries.iter().map(|(_, value)| &**value).collect();
        Config(unsafe {
            CFRetained::cast_unchecked(CFDictionary::<CFString, CFType>::from_slices(
                &keys, &values,
            ))
        })
    }
    fn number(value: i32) -> CFRetained<CFType> {
        CFNumber::new_i32(value).into()
    }
    fn string(value: &str) -> CFRetained<CFType> {
        CFString::from_str(value).into()
    }
    fn resolved(config: &Config, url: &str) -> Option<String> {
        resolve(config, &Url::parse(url).unwrap()).map(String::from)
    }

    #[test]
    fn manual_proxies_follow_cfnetwork_scheme_and_exception_rules() {
        let config = settings(&[
            (unsafe { kCFNetworkProxiesHTTPEnable }, number(1)),
            (unsafe { kCFNetworkProxiesHTTPProxy }, string("10.0.0.1")),
            (unsafe { kCFNetworkProxiesHTTPPort }, number(8080)),
            (unsafe { kCFNetworkProxiesHTTPSEnable }, number(1)),
            (unsafe { kCFNetworkProxiesHTTPSProxy }, string("10.0.0.2")),
            (unsafe { kCFNetworkProxiesHTTPSPort }, number(8443)),
            (unsafe { kCFNetworkProxiesExceptionsList }, unsafe {
                CFRetained::cast_unchecked(CFArray::from_retained_objects(&[CFString::from_str(
                    "*.internal.example",
                )]))
            }),
        ]);
        assert_eq!(
            resolved(&config, "http://example.com:80/").as_deref(),
            Some("http://10.0.0.1:8080/")
        );
        // The HTTPS proxy is reached over plain HTTP and tunnels with CONNECT.
        assert_eq!(
            resolved(&config, "https://example.com:443/").as_deref(),
            Some("http://10.0.0.2:8443/")
        );
        assert_eq!(resolved(&config, "https://a.internal.example:443/"), None);
    }

    #[test]
    fn pac_scripts_are_evaluated_by_cfnetwork() {
        let config = settings(&[
            (unsafe { kCFNetworkProxiesProxyAutoConfigEnable }, number(1)),
            (
                unsafe { kCFNetworkProxiesProxyAutoConfigJavaScript },
                string(
                    "function FindProxyForURL(url, host) { \
                     if (dnsDomainIs(host, '.direct.example')) return 'DIRECT'; \
                     return 'SOCKS 10.0.0.3:1080; DIRECT'; }",
                ),
            ),
        ]);
        assert_eq!(
            resolved(&config, "https://example.com:443/").as_deref(),
            Some("socks5h://10.0.0.3:1080")
        );
        assert_eq!(resolved(&config, "https://a.direct.example:443/"), None);
    }

    #[test]
    fn unreachable_pac_url_connects_directly_like_safari() {
        let config = settings(&[
            (
                unsafe { objc2_cf_network::kCFNetworkProxiesProxyAutoConfigEnable },
                number(1),
            ),
            (
                unsafe { objc2_cf_network::kCFNetworkProxiesProxyAutoConfigURLString },
                string("http://127.0.0.1:9/proxy.pac"),
            ),
        ]);
        assert_eq!(resolved(&config, "https://example.com:443/"), None);
    }
}
