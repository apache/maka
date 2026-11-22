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
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, net::IpAddr, num::NonZeroU16};

/// Destination authority, independent of the upstream proxy used to reach it.
/// A domain grant does not authorize its subdomains or other ports.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Destination {
    #[serde(deserialize_with = "deserialize_host")]
    #[schemars(length(min = 1, max = 253))]
    host: String,
    port: NonZeroU16,
}

impl Destination {
    pub fn new(host: &str, port: u16) -> Result<Self, Error> {
        Ok(Self {
            host: normalize_host(host)?,
            port: NonZeroU16::new(port)
                .ok_or_else(|| Error::Invalid("network port must be nonzero".into()))?,
        })
    }
    pub fn host(&self) -> &str {
        &self.host
    }
    pub fn port(&self) -> u16 {
        self.port.get()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Network {
    Denied,
    Allowed,
    Restricted { destinations: BTreeSet<Destination> },
}

impl Network {
    pub fn destination(destination: Destination) -> Self {
        Self::Restricted {
            destinations: BTreeSet::from([destination]),
        }
    }
    pub fn allows(&self, destination: &Destination) -> bool {
        match self {
            Self::Allowed => true,
            Self::Denied => false,
            Self::Restricted { destinations } => destinations.contains(destination),
        }
    }
    pub fn contains(&self, required: &Self) -> bool {
        match (self, required) {
            (Self::Allowed, _) | (_, Self::Denied) => true,
            (_, Self::Restricted { destinations }) if destinations.is_empty() => true,
            (
                Self::Restricted { destinations },
                Self::Restricted {
                    destinations: required,
                },
            ) => required.is_subset(destinations),
            _ => false,
        }
    }
    pub fn intersect(&self, other: &Self) -> Self {
        match (self, other) {
            (Self::Denied, _) | (_, Self::Denied) => Self::Denied,
            (Self::Allowed, other) | (other, Self::Allowed) => other.clone(),
            (Self::Restricted { destinations: a }, Self::Restricted { destinations: b }) => {
                Self::from_destinations(a.intersection(b).cloned().collect())
            }
        }
    }
    pub(crate) fn union(&self, other: &Self) -> Self {
        match (self, other) {
            (Self::Allowed, _) | (_, Self::Allowed) => Self::Allowed,
            (Self::Denied, other) | (other, Self::Denied) => other.clone(),
            (Self::Restricted { destinations: a }, Self::Restricted { destinations: b }) => {
                Self::from_destinations(a.union(b).cloned().collect())
            }
        }
    }
    fn from_destinations(destinations: BTreeSet<Destination>) -> Self {
        if destinations.is_empty() {
            Self::Denied
        } else {
            Self::Restricted { destinations }
        }
    }
}

fn normalize_host(value: &str) -> Result<String, Error> {
    if value.is_empty()
        || value.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(c, '/' | '\\' | '@' | '?' | '#' | '%' | '*')
        })
    {
        return Err(Error::Invalid(
            "network destination must be a host without credentials, path or wildcard".into(),
        ));
    }
    if let Ok(ip) = value.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    let host = url::Host::parse(value.trim_end_matches('.'))
        .map_err(|_| Error::Invalid("invalid network destination host".into()))?;
    let host = match host {
        url::Host::Domain(host) => host,
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => ip.to_string(),
    };
    if host.is_empty() || host.len() > 253 {
        return Err(Error::Invalid(
            "network destination host exceeds its size limit".into(),
        ));
    }
    Ok(host)
}

fn deserialize_host<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    normalize_host(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destination_grants_preserve_port_and_host_boundaries_through_partial_approval() {
        let first = Destination::new("EXAMPLE.com.", 443).unwrap();
        let second = Destination::new("example.com", 80).unwrap();
        let grant = Network::destination(first.clone());
        assert!(grant.allows(&Destination::new("example.com", 443).unwrap()));
        assert!(!grant.allows(&second));
        assert!(!grant.allows(&Destination::new("child.example.com", 443).unwrap()));
        assert!(!grant.allows(&Destination::new("example.com.evil", 443).unwrap()));
        let combined = grant.union(&Network::destination(second));
        assert!(combined.contains(&grant));
        assert!(!grant.contains(&combined));
        assert_eq!(combined.intersect(&grant), grant);
        assert!(!grant.contains(&Network::Allowed));
        assert_eq!(Network::Allowed.intersect(&grant), grant);
        assert_eq!(
            Destination::new("[::1]", 443).unwrap(),
            Destination::new("::1", 443).unwrap()
        );
        for host in [
            "example.com/path",
            "user@example.com",
            "*.example.com",
            "example.com%00",
            "example.com:443",
        ] {
            assert!(Destination::new(host, 443).is_err(), "{host}");
        }
        let encoded = serde_json::to_value(&combined).unwrap();
        assert_eq!(
            serde_json::from_value::<Network>(encoded).unwrap(),
            combined
        );
    }
}
