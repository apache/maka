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

#![cfg_attr(windows, windows_subsystem = "windows")]

//! Feasibility probe: the gpui-shell command, built inside this workspace
//! against the vendored gpui-base and gpui-fast, with a `maka-host` module
//! that reaches the Host named by `MAKA_HOST_ENDPOINT` and `MAKA_HOST_EPOCH`.

mod maka_host;

fn main() {
    // Imports are linked against the registry, so register before any load.
    let registered = maka_host::module()
        .and_then(|module| gpui_shell::export_module(module).map_err(|error| error.to_string()));
    if let Err(error) = registered {
        eprintln!("{}: {error}", maka_host::NAME);
        std::process::exit(1);
    }
    gpui_shell::host::main_with_components(gpui_shell::FrozenComponentRegistry::default());
}
