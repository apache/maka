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
    CFNetworkCopySystemProxySettings, kCFNetworkProxiesProxyAutoConfigEnable,
    kCFNetworkProxiesProxyAutoConfigURLString, kCFNetworkProxiesProxyAutoDiscoveryEnable,
    kCFProxyAutoConfigurationJavaScriptKey, kCFProxyAutoConfigurationURLKey, kCFProxyHostNameKey,
    kCFProxyPortNumberKey, kCFProxyTypeAutoConfigurationJavaScript,
    kCFProxyTypeAutoConfigurationURL, kCFProxyTypeHTTP, kCFProxyTypeHTTPS, kCFProxyTypeKey,
    kCFProxyTypeNone, kCFProxyTypeSOCKS,
};
use objc2_core_foundation::{
    CFArray, CFDictionary, CFError, CFMutableDictionary, CFNumber, CFRetained, CFRunLoop,
    CFRunLoopSource, CFStreamClientContext, CFString, CFType, CFURL,
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
    Ok(unsafe { CFNetworkCopySystemProxySettings() }
        .map(|settings| Config(with_discovery(settings))))
}

/// CFNetworkCopyProxiesForURL ignores "Auto Proxy Discovery". Like Chromium,
/// discover through the DNS WPAD URL, expressed as a PAC URL so CFNetwork
/// still applies the exception list and the order of the other proxies.
fn with_discovery(settings: CFRetained<CFDictionary>) -> CFRetained<CFDictionary> {
    let typed = unsafe { settings.cast_unchecked::<CFString, CFType>() };
    let enabled = |key: &CFString| {
        typed
            .get(key)
            .and_then(|value| value.downcast::<CFNumber>().ok())
            .and_then(|value| value.as_i32())
            == Some(1)
    };
    if !enabled(unsafe { kCFNetworkProxiesProxyAutoDiscoveryEnable })
        || enabled(unsafe { kCFNetworkProxiesProxyAutoConfigEnable })
    {
        return settings;
    }
    let Some(discovered) = (unsafe { CFMutableDictionary::new_copy(None, 0, Some(&settings)) })
    else {
        return settings;
    };
    let typed = unsafe { discovered.cast_unchecked::<CFString, CFType>() };
    typed.set(
        unsafe { kCFNetworkProxiesProxyAutoConfigEnable },
        &CFNumber::new_i32(1),
    );
    typed.set(
        unsafe { kCFNetworkProxiesProxyAutoConfigURLString },
        &CFString::from_static_str("http://wpad/wpad.dat"),
    );
    CFDictionary::new_copy(None, Some(&discovered)).unwrap_or(settings)
}

/// CFNetwork applies the exception list, simple-hostname exclusion and PAC
/// exactly as Safari does, including its failure semantics: a PAC script that
/// cannot be fetched or evaluated falls through to the next configured proxy.
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
            match execute(&script, target) {
                Some(proxies) => return first(&proxies, target),
                None => continue,
            }
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
    // objc2-cf-network declares the callback's proxy list non-null, but
    // CFNetwork passes NULL with an error, so declare the honest signature.
    #[link(name = "CFNetwork", kind = "framework")]
    unsafe extern "C-unwind" {
        fn CFNetworkExecuteProxyAutoConfigurationURL(
            proxy_auto_config_url: &CFURL,
            target_url: &CFURL,
            cb: unsafe extern "C-unwind" fn(*mut c_void, *const CFArray, *mut CFError),
            client_context: *mut CFStreamClientContext,
        ) -> Option<NonNull<CFRunLoopSource>>;
    }
    unsafe extern "C-unwind" fn done(
        client: *mut c_void,
        proxies: *const CFArray,
        error: *mut CFError,
    ) {
        let outcome = unsafe { &mut *client.cast::<Option<Option<CFRetained<CFArray>>>>() };
        *outcome = Some(
            NonNull::new(proxies.cast_mut())
                .filter(|_| error.is_null())
                .map(|proxies| unsafe { CFRetained::retain(proxies) }),
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
        CFRetained::from_raw(CFNetworkExecuteProxyAutoConfigurationURL(
            script,
            target,
            done,
            &mut context,
        )?)
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
    fn unreachable_pac_url_falls_through_to_the_next_configured_proxy() {
        let pac = [
            (unsafe { kCFNetworkProxiesProxyAutoConfigEnable }, number(1)),
            (
                unsafe { kCFNetworkProxiesProxyAutoConfigURLString },
                string("http://127.0.0.1:9/proxy.pac"),
            ),
        ];
        assert_eq!(resolved(&settings(&pac), "https://example.com:443/"), None);
        let mut with_manual = pac.to_vec();
        with_manual.extend([
            (unsafe { kCFNetworkProxiesHTTPSEnable }, number(1)),
            (unsafe { kCFNetworkProxiesHTTPSProxy }, string("10.0.0.2")),
            (unsafe { kCFNetworkProxiesHTTPSPort }, number(8443)),
        ]);
        assert_eq!(
            resolved(&settings(&with_manual), "https://example.com:443/").as_deref(),
            Some("http://10.0.0.2:8443/")
        );
    }

    #[test]
    fn auto_discovery_becomes_the_dns_wpad_script_unless_a_pac_url_is_set() {
        let script = |config: &Config| {
            unsafe { config.0.cast_unchecked::<CFString, CFType>() }
                .get(unsafe { kCFNetworkProxiesProxyAutoConfigURLString })
                .and_then(|url| url.downcast::<CFString>().ok())
                .map(|url| url.to_string())
        };
        let discovery = (
            unsafe { kCFNetworkProxiesProxyAutoDiscoveryEnable },
            number(1),
        );
        let discovered = Config(with_discovery(settings(std::slice::from_ref(&discovery)).0));
        assert_eq!(script(&discovered).as_deref(), Some("http://wpad/wpad.dat"));
        let explicit = Config(with_discovery(
            settings(&[
                discovery,
                (unsafe { kCFNetworkProxiesProxyAutoConfigEnable }, number(1)),
                (
                    unsafe { kCFNetworkProxiesProxyAutoConfigURLString },
                    string("http://pac.example/proxy.pac"),
                ),
            ])
            .0,
        ));
        assert_eq!(
            script(&explicit).as_deref(),
            Some("http://pac.example/proxy.pac")
        );
    }
}
