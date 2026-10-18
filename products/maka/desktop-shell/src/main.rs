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

//! The Maka desktop: the gpui-shell command, built inside this workspace
//! against the vendored gpui-base and gpui-fast, that runs the scripts in
//! `app/` (`maka-desktop-shell run --dir app`). It adds a `maka-host` module
//! that reaches the Host named by `MAKA_HOST_ENDPOINT` and `MAKA_HOST_EPOCH`,
//! a `maka-files` module for the file or folder the user picks, a
//! `maka-locale` module with the language the system asks for, the
//! Workbar's terminal (`maka-desktop`'s `Terminal`), and the window Maka
//! opens in (`window`).

mod files;
mod locale;
mod maka_host;
mod terminal;
mod window;

fn main() {
    // Imports are linked against the registry, so register before any load.
    let registered = maka_host::module()
        .and_then(|module| gpui_shell::export_module(module).map_err(|error| error.to_string()));
    if let Err(error) = registered {
        eprintln!("{}: {error}", maka_host::NAME);
        std::process::exit(1);
    }
    if let Err(error) = gpui_shell::export_module(files::module()) {
        eprintln!("{}: {error}", files::NAME);
        std::process::exit(1);
    }
    if let Err(error) = gpui_shell::export_module(locale::module()) {
        eprintln!("{}: {error}", locale::NAME);
        std::process::exit(1);
    }
    let components = match window::components() {
        Ok(components) => components,
        Err(error) => {
            eprintln!("maka-desktop-shell: {error}");
            std::process::exit(1);
        }
    };
    gpui_shell::host::main_with_brand_and_components(
        gpui_shell::host::HostBrand::new("maka-desktop-shell", env!("CARGO_PKG_VERSION")),
        components,
    );
}
