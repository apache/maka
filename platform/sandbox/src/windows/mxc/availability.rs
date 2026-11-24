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

use mxc_sdk::v1;
use std::sync::OnceLock;

fn capabilities() -> Option<&'static v1::ProbeFacts> {
    static PROBE: OnceLock<Option<v1::ProbeFacts>> = OnceLock::new();
    PROBE
        .get_or_init(|| v1::probe(None).ok().map(|result| result.probes))
        .as_ref()
}

pub fn is_available() -> bool {
    capabilities().is_some_and(|facts| facts.base_container_api_present)
}

pub(super) fn supports_deny_paths() -> bool {
    capabilities().is_some_and(|facts| facts.base_container_supports_deny_paths)
}
