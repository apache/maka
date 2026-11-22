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
mod product;

fn main() {
    if std::env::var_os("CARGO_FEATURE_DESKTOP_TESTS").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    {
        // Native UI cases run on the main thread. Match NSH's engine stack reserve.
        const STACK_BYTES: u64 = 8 << 20;
        match std::env::var("CARGO_CFG_TARGET_ENV").as_deref() {
            Ok("msvc") => println!("cargo:rustc-link-arg-tests=/STACK:{STACK_BYTES}"),
            _ => println!("cargo:rustc-link-arg-tests=-Wl,--stack,{STACK_BYTES}"),
        }
    }
    product::bundle();
    println!("cargo:rerun-if-env-changed=MAKA_NATIVE_PACKAGE_VERSION");
    if let Ok(version) = std::env::var("MAKA_NATIVE_PACKAGE_VERSION") {
        assert!(
            !version.is_empty()
                && version.len() <= 256
                && version
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')),
            "invalid native package version"
        );
        println!("cargo:rustc-env=MAKA_NATIVE_PACKAGE_VERSION={version}");
    }
}
