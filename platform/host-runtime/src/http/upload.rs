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

//! reqwest boundary for the shared pull-driven upload/custody contract.
use maka_capabilities::http::{RequestBody, upload};
use tokio_util::sync::CancellationToken;

pub(super) fn body(
    input: RequestBody,
    stop: CancellationToken,
) -> (reqwest::Body, upload::Receipt) {
    let (stream, receipt) = upload::track(input, stop);
    (reqwest::Body::wrap_stream(stream), receipt)
}

#[cfg(test)]
mod tests;
