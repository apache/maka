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

use std::{
    collections::{BTreeMap, VecDeque, hash_map::RandomState},
    hash::BuildHasher,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const COOLDOWN: Duration = Duration::from_secs(5 * 60);
const MAX_FAILURES: usize = 64;

/// Runtime-wide disposable transport memory. Route fingerprints keep cooldown
/// bounded without retaining credentials or unbounded endpoint strings.
pub struct Shared {
    pub cache: Arc<Semaphore>,
    routes: RandomState,
    failures: Mutex<VecDeque<(u64, Instant)>>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            cache: Arc::new(Semaphore::new(super::cache::CACHE_LIMIT as usize)),
            routes: RandomState::new(),
            failures: Mutex::new(VecDeque::new()),
        }
    }
}

impl Shared {
    pub fn route(&self, url: &str, headers: &BTreeMap<String, String>, network: u64) -> u64 {
        self.routes.hash_one((url, headers, network))
    }

    pub fn deferred(&self, route: u64, now: Instant) -> bool {
        let mut failures = self.failures.lock().unwrap();
        failures.retain(|(_, until)| *until > now);
        failures.iter().any(|(key, _)| *key == route)
    }

    pub fn defer(&self, route: u64, now: Instant) {
        let mut failures = self.failures.lock().unwrap();
        failures.retain(|(key, until)| *key != route && *until > now);
        if failures.len() == MAX_FAILURES {
            failures.pop_front();
        }
        failures.push_back((route, now + COOLDOWN));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_is_route_scoped_expires_and_retains_only_bounded_recent_failures() {
        let shared = Shared::default();
        let now = Instant::now();
        let direct = 1;
        let headers = BTreeMap::from([("authorization".into(), "Bearer first".into())]);
        let route = shared.route("https://api.example/responses", &headers, direct);
        shared.defer(route, now);
        assert!(shared.deferred(route, now + COOLDOWN - Duration::from_millis(1)));
        let changed_headers = BTreeMap::from([("authorization".into(), "Bearer second".into())]);
        assert!(!shared.deferred(
            shared.route("https://api.example/responses", &changed_headers, direct),
            now
        ));
        assert!(!shared.deferred(
            shared.route("https://other.example/responses", &headers, direct),
            now
        ));
        let proxy = 2;
        assert!(!shared.deferred(
            shared.route("https://api.example/responses", &headers, proxy),
            now
        ));
        assert!(!shared.deferred(route, now + COOLDOWN));
        assert!(shared.failures.lock().unwrap().is_empty());
        for key in 0..100 {
            shared.defer(key, now);
        }
        assert_eq!(shared.failures.lock().unwrap().len(), MAX_FAILURES);
        assert!(!shared.deferred(0, now));
        assert!(shared.deferred(99, now));
        shared.defer(99, now + Duration::from_secs(1));
        assert_eq!(shared.failures.lock().unwrap().len(), MAX_FAILURES);
    }
}
