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

//! Linux has no OS proxy resolver. Like Chromium, read KDE's kioslaverc on
//! KDE and GNOME's `org.gnome.system.proxy` settings elsewhere. Their PAC and
//! WPAD modes need a JavaScript engine, so those connect directly, as Maka
//! always has on Linux.

use crate::Error;
use hyper_util::client::proxy::matcher::Matcher;
use reqwest::Url;
use std::{collections::HashMap, path::PathBuf, process::Command};

#[derive(PartialEq, Eq, Hash)]
pub(super) struct Config {
    http: Option<Url>,
    https: Option<Url>,
    socks: Option<Url>,
    /// `NO_PROXY` syntax.
    exceptions: String,
    /// KDE's "use proxy only for the listed hosts".
    reversed: bool,
}

pub(super) fn capture() -> Result<Option<Config>, Error> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    if desktop
        .split(':')
        .any(|name| name.eq_ignore_ascii_case("KDE"))
    {
        let home = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
        return match home.and_then(|home| std::fs::read_to_string(home.join("kioslaverc")).ok()) {
            Some(text) => Ok(kde(&text, |name| std::env::var(name).ok())),
            None => Ok(None),
        };
    }
    match Command::new("gsettings")
        .args(["list-recursively", "org.gnome.system.proxy"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => gnome(&String::from_utf8_lossy(&output.stdout)),
        _ => Ok(None),
    }
}

pub(super) fn resolve(config: &Config, target: &Url) -> Option<Url> {
    let excepted = Matcher::builder()
        .all("http://excepted.invalid")
        .no(config.exceptions.as_str())
        .build()
        .intercept(&target.as_str().parse().ok()?)
        .is_none();
    if excepted != config.reversed {
        return None;
    }
    match target.scheme() {
        "https" => config.https.as_ref(),
        "http" => config.http.as_ref(),
        _ => None,
    }
    .or(config.socks.as_ref())
    .cloned()
}

/// Parses `gsettings list-recursively org.gnome.system.proxy`.
fn gnome(listing: &str) -> Result<Option<Config>, Error> {
    let values: HashMap<(&str, &str), &str> = listing
        .lines()
        .filter_map(|line| {
            let (schema, rest) = line.trim().split_once(' ')?;
            let (key, value) = rest.split_once(' ')?;
            Some(((schema, key), value.trim()))
        })
        .collect();
    let get = |schema: &str, key: &str| values.get(&(schema, key)).copied().unwrap_or_default();
    let text = |schema: &str, key: &str| {
        strings(get(schema, key))
            .into_iter()
            .next()
            .unwrap_or_default()
    };
    if text("org.gnome.system.proxy", "mode") != "manual" {
        return Ok(None);
    }
    let proxy = |protocol: &str, scheme: &str| {
        let schema = format!("org.gnome.system.proxy.{protocol}");
        let host = text(&schema, "host");
        let port = get(&schema, "port")
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)?;
        if host.is_empty() {
            return None;
        }
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host
        };
        super::endpoint(scheme, &format!("{host}:{port}"))
    };
    let mut http = proxy("http", "http");
    if let Some(http) = http.as_mut()
        && get("org.gnome.system.proxy.http", "use-authentication") == "true"
    {
        let user = text("org.gnome.system.proxy.http", "authentication-user");
        let password = text("org.gnome.system.proxy.http", "authentication-password");
        if http.set_username(&user).is_err() || http.set_password(Some(&password)).is_err() {
            return Err(Error::InvalidProxy);
        }
    }
    Ok(Some(Config {
        // An unset HTTPS proxy reuses the HTTP proxy, as glib-networking does.
        https: proxy("https", "http").or_else(|| http.clone()),
        http,
        socks: proxy("socks", "socks5h"),
        exceptions: exceptions(strings(get("org.gnome.system.proxy", "ignore-hosts"))),
        reversed: false,
    }))
}

/// Parses the `[Proxy Settings]` group of KDE's kioslaverc.
fn kde(text: &str, environment: impl Fn(&str) -> Option<String>) -> Option<Config> {
    let mut values = HashMap::new();
    let mut inside = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            inside = line == "[Proxy Settings]";
        } else if inside && let Some((key, value)) = line.split_once('=') {
            let key = key.split_once('[').map_or(key, |(key, _)| key).trim();
            values.insert(key, value.trim());
        }
    }
    // Type 1 stores addresses; type 4 stores the names of environment
    // variables holding them.
    let get = |key: &str| {
        let value = values.get(key).copied().unwrap_or_default();
        match values.get("ProxyType").copied() {
            Some("1") => Some(value.to_owned()),
            Some("4") => Some(environment(value).unwrap_or_default()),
            _ => None,
        }
    };
    get("ProxyType")?;
    // KDE writes "http://host port"; newer releases also accept "host:port".
    let proxy = |key: &str, scheme: &str| {
        let value = get(key)?;
        let value = value.as_str();
        let address = value.split_once("://").map_or(value, |(_, rest)| rest);
        let address = match address.rsplit_once(' ') {
            Some((host, port)) => format!("{}:{}", host.trim(), port.trim()),
            None => address.to_owned(),
        };
        super::endpoint(scheme, &address)
    };
    Some(Config {
        http: proxy("httpProxy", "http"),
        https: proxy("httpsProxy", "http"),
        socks: proxy("socksProxy", "socks5h"),
        exceptions: exceptions(get("NoProxyFor")?.split(',').map(str::to_owned).collect()),
        reversed: values.get("ReversedException") == Some(&"true"),
    })
}

/// GVariant text values: every quoted string, in order.
fn strings(value: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut chars = value.chars();
    while let Some(quote) = chars.by_ref().find(|c| matches!(c, '\'' | '"')) {
        let mut current = String::new();
        while let Some(c) = chars.next() {
            match c {
                '\\' => current.extend(chars.next()),
                c if c == quote => break,
                c => current.push(c),
            }
        }
        found.push(current);
    }
    found
}

/// Desktop exception lists accept `*.example.com`; NO_PROXY spells it `.example.com`.
fn exceptions(entries: Vec<String>) -> String {
    entries
        .iter()
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            entry
                .strip_prefix('*')
                .filter(|rest| !rest.is_empty())
                .unwrap_or(entry)
        })
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(config: &Config, url: &str) -> Option<String> {
        resolve(config, &Url::parse(url).unwrap()).map(String::from)
    }

    const GNOME_MANUAL: &str = "\
org.gnome.system.proxy autoconfig-url ''
org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.0/8', '::1', '*.corp.example', '10.0.0.0/8']
org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy use-same-proxy true
org.gnome.system.proxy.ftp host ''
org.gnome.system.proxy.ftp port 0
org.gnome.system.proxy.http authentication-password 'p@ss\\'word'
org.gnome.system.proxy.http authentication-user 'me'
org.gnome.system.proxy.http enabled false
org.gnome.system.proxy.http host '127.0.0.1'
org.gnome.system.proxy.http port 7890
org.gnome.system.proxy.http use-authentication true
org.gnome.system.proxy.https host '127.0.0.1'
org.gnome.system.proxy.https port 7891
org.gnome.system.proxy.socks host ''
org.gnome.system.proxy.socks port 0
";

    #[test]
    fn gnome_manual_settings_select_by_scheme_and_honor_exceptions() {
        let config = gnome(GNOME_MANUAL).unwrap().unwrap();
        assert_eq!(
            resolved(&config, "http://example.com:80/").as_deref(),
            Some("http://me:p%40ss'word@127.0.0.1:7890/")
        );
        assert_eq!(
            resolved(&config, "https://example.com:443/").as_deref(),
            Some("http://127.0.0.1:7891/")
        );
        for url in [
            "https://a.corp.example:443/",
            "https://corp.example:443/",
            "https://10.2.3.4:443/",
        ] {
            assert_eq!(resolved(&config, url), None, "{url}");
        }
    }

    #[test]
    fn gnome_socks_is_the_fallback_for_every_scheme() {
        let config = gnome(
            "org.gnome.system.proxy mode 'manual'\n\
             org.gnome.system.proxy ignore-hosts @as []\n\
             org.gnome.system.proxy.socks host 'proxy.example'\n\
             org.gnome.system.proxy.socks port 1080\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            resolved(&config, "https://example.com:443/").as_deref(),
            Some("socks5h://proxy.example:1080")
        );
    }

    #[test]
    fn gnome_modes_without_a_manual_proxy() {
        assert!(
            gnome("org.gnome.system.proxy mode 'none'\n")
                .unwrap()
                .is_none()
        );
        assert!(gnome("").unwrap().is_none());
        assert!(
            gnome("org.gnome.system.proxy mode 'auto'\n")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn gnome_https_reuses_the_http_proxy_before_socks() {
        let config = gnome(
            "org.gnome.system.proxy mode 'manual'\n\
             org.gnome.system.proxy.http host 'proxy.example'\n\
             org.gnome.system.proxy.http port 8080\n\
             org.gnome.system.proxy.socks host 'socks.example'\n\
             org.gnome.system.proxy.socks port 1080\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            resolved(&config, "https://example.com:443/").as_deref(),
            Some("http://proxy.example:8080/")
        );
    }

    #[test]
    fn kde_manual_settings_support_both_address_spellings_and_reversal() {
        let config = kde_text(
            "[General]\nProxyType=0\n\n[Proxy Settings]\n\
             NoProxyFor=localhost,*.corp.example\n\
             ProxyType=1\n\
             httpProxy=http://127.0.0.1 7890\n\
             httpsProxy[$e]=127.0.0.1:7891\n\
             socksProxy=socks://127.0.0.1 7892\n",
        )
        .unwrap();
        assert_eq!(
            resolved(&config, "http://example.com:80/").as_deref(),
            Some("http://127.0.0.1:7890/")
        );
        assert_eq!(
            resolved(&config, "https://example.com:443/").as_deref(),
            Some("http://127.0.0.1:7891/")
        );
        assert_eq!(resolved(&config, "https://a.corp.example:443/"), None);

        let reversed = kde_text(
            "[Proxy Settings]\nProxyType=1\nReversedException=true\n\
             NoProxyFor=.corp.example\nsocksProxy=socks://127.0.0.1 7892\n",
        )
        .unwrap();
        assert_eq!(resolved(&reversed, "https://example.com:443/"), None);
        assert_eq!(
            resolved(&reversed, "https://a.corp.example:443/").as_deref(),
            Some("socks5h://127.0.0.1:7892")
        );
    }

    fn kde_text(text: &str) -> Option<Config> {
        kde(text, |_| None)
    }

    #[test]
    fn kde_environment_type_reads_the_named_variables() {
        let config = kde(
            "[Proxy Settings]\nProxyType=4\nhttpsProxy=CORP_PROXY\nNoProxyFor=CORP_NO_PROXY\n",
            |name| match name {
                "CORP_PROXY" => Some("http://proxy.corp:8080".into()),
                "CORP_NO_PROXY" => Some(".internal.corp".into()),
                _ => None,
            },
        )
        .unwrap();
        assert_eq!(
            resolved(&config, "https://example.com:443/").as_deref(),
            Some("http://proxy.corp:8080/")
        );
        assert_eq!(resolved(&config, "https://a.internal.corp:443/"), None);
        assert_eq!(resolved(&config, "http://example.com:80/"), None);
    }

    #[test]
    fn kde_types_without_a_manual_proxy() {
        for kind in ["0", "2", "3"] {
            assert!(kde_text(&format!("[Proxy Settings]\nProxyType={kind}\n")).is_none());
        }
    }
}
