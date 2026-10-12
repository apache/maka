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

#![no_std]

use core::panic::PanicInfo;
use maka_plugin_runtime::{export_plugin, response, Response};

static MANIFEST: &[u8] = br#"{"abiVersion":1,"packageId":"rust-echo","contributions":[{"id":"echo","kind":"tool","tool":{"name":"rust_echo","description":"Rust SDK echo tool","parameters":{"type":"object"}}}]}"#;
static RESULT: &[u8] = br#"{"from":"rust"}"#;

fn invoke(_input: &[u8]) -> Response {
    response(RESULT)
}

#[panic_handler]
fn panic(_info: &PanicInfo<'_>) -> ! {
    loop {}
}

export_plugin!(MANIFEST, invoke);
