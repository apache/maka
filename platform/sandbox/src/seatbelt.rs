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

use crate::{
    Error, Network,
    filesystem::{Access, Compiled, Rule, Scope},
    launch::Launch,
};
use std::{collections::BTreeSet, ffi::OsString, path::Path};

mod glob;

pub(crate) fn prepare(
    filesystem: &Compiled,
    network: &Network,
    proxy: Option<std::net::SocketAddr>,
) -> Result<Launch, Error> {
    let policy = filesystem.policy();
    // These paths are already materialized on the execution host. Do not resolve
    // a changed symlink here and silently authorize a different target.
    for rule in &policy.rules {
        validate_anchor(&rule.path)?;
    }
    for pattern in &policy.deny_globs {
        let literal_end = pattern.find(['*', '?', '[', '{']).unwrap_or(pattern.len());
        let root = if literal_end == pattern.len() {
            pattern.as_str()
        } else {
            let separator = pattern[..literal_end].rfind('/').unwrap_or(0);
            &pattern[..separator.max(1)]
        };
        validate_anchor(Path::new(root))?;
    }
    let mut profile = include_str!("seatbelt/base.sbpl").to_owned();
    let mut args = Vec::<OsString>::new();
    let mut rules = vec![Rule::subtree("/", policy.default)];
    rules.extend(policy.rules.iter().cloned());
    for (index, rule) in rules.iter().enumerate() {
        args.push(format!("-DP{index}={}", rule.path.display()).into());
    }
    for (operation, permits) in [
        (
            "file-read* file-map-executable",
            Access::can_read as fn(Access) -> bool,
        ),
        ("file-write*", Access::can_write as fn(Access) -> bool),
    ] {
        for (index, rule) in rules.iter().enumerate().filter(|(_, r)| permits(r.access)) {
            let mut filters = vec![filter(index, rule.scope)];
            for (excluded, child) in rules.iter().enumerate().skip(1) {
                if !permits(child.access) && (index == 0 || more_specific(child, rule)) {
                    filters.push(format!("(require-not {})", filter(excluded, child.scope)));
                }
            }
            profile.push_str(&format!(
                "\n(allow {operation} (require-all {}))",
                filters.join(" ")
            ));
        }
    }
    // A rename of an allowed ancestor could move protected descendants outside
    // their pathname rules. Anchor every rule and its parents against replacement.
    let anchors: BTreeSet<_> = policy
        .rules
        .iter()
        .flat_map(|rule| rule.path.ancestors())
        .collect();
    for (index, path) in anchors.iter().enumerate() {
        args.push(format!("-DA{index}={}", path.display()).into());
        profile.push_str(&format!("\n(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal (param \"A{index}\"))))"));
    }
    profile.push_str("\n(deny system-fcntl (fcntl-command 80 110))");
    profile.push_str("\n(deny mach-lookup (xpc-service-name-prefix \"\"))");
    if network == &Network::Allowed {
        profile.push_str(include_str!("seatbelt/network.sbpl"));
        // The system resolver uses this Unix socket even for ordinary DNS.
        profile.push_str("\n(allow network-outbound (remote unix-socket (path-literal \"/private/var/run/mDNSResponder\")))");
        // Other Host Unix sockets remain outside the IP network grant.
        profile.push_str("\n(allow network-outbound (remote ip \"*:*\"))\n(allow network-inbound (local ip \"*:*\"))\n(allow network-bind (local ip \"*:*\"))");
    } else if matches!(network, Network::Restricted { .. }) {
        let proxy = proxy
            .ok_or_else(|| Error::Unsupported("restricted network requires its gateway".into()))?;
        // Seatbelt's `tcp` localhost matcher includes both address families.
        // Grant only the family actually owned by this gateway, not an unrelated
        // listener on the same port in the other family.
        let protocol = if proxy.is_ipv4() { "tcp4" } else { "tcp6" };
        profile.push_str(include_str!("seatbelt/network.sbpl"));
        profile.push_str(&format!(
            "\n(allow network-outbound (remote {protocol} \"localhost:{}\"))",
            proxy.port()
        ));
    }
    for (index, pattern) in policy.deny_globs.iter().enumerate() {
        let (denied, parents) = glob::compile(pattern)?;
        args.push(format!("-DG{index}={denied}").into());
        profile.push_str(&format!(
            "\n(deny file-read* file-write* file-map-executable (regex (param \"G{index}\")))"
        ));
        if let Some(parents) = parents {
            args.push(format!("-DGP{index}={parents}").into());
            profile.push_str(&format!("\n(deny file-write-unlink (require-all (vnode-type DIRECTORY) (regex (param \"GP{index}\"))))"));
        }
    }
    args.splice(0..0, [OsString::from("-p"), profile.into()]);
    args.push("--".into());
    Ok(Launch::Wrapped {
        program: "/usr/bin/sandbox-exec".into(),
        args,
    })
}

fn filter(index: usize, scope: Scope) -> String {
    match scope {
        Scope::Exact => format!("(literal (param \"P{index}\"))"),
        Scope::Subtree => {
            format!("(require-any (literal (param \"P{index}\")) (subpath (param \"P{index}\")))")
        }
    }
}

fn more_specific(child: &Rule, parent: &Rule) -> bool {
    if crate::path::compare(&child.path, &parent.path).is_eq() {
        child.scope > parent.scope || (child.scope == parent.scope && child.access > parent.access)
    } else {
        parent.scope == Scope::Subtree && crate::path::within(&child.path, &parent.path)
    }
}

fn validate_anchor(path: &Path) -> Result<(), Error> {
    for ancestor in path.ancestors() {
        match ancestor.canonicalize() {
            Ok(canonical) if crate::path::compare(&canonical, ancestor).is_eq() => return Ok(()),
            Ok(_) => {
                return Err(Error::Invalid(format!(
                    "sandbox path must be materialized: {}",
                    path.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(Error::Invalid(
        "sandbox path has no existing ancestor".into(),
    ))
}
