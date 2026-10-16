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

//! The `maka-locale` script module: the language the system asks for.
//!
//! Scripts cannot read the environment or the platform's preferences, so
//! the desktop asks here, and gets the TUI's answer: `LC_ALL`, then
//! `LC_MESSAGES`, then `LANG`, then the platform's locale, as a BCP 47 tag
//! (`maka_ui_runtime::locale::system`).
use gpui_shell::{HostModule, HostValue};

pub const NAME: &str = "maka-locale";

const DECLARATIONS: &str = r#"/**
 * The language the system asks for, as a BCP 47 tag such as "zh-CN" or
 * "en-US"; "en" when nothing says.
 */
export function system(): string;
"#;

pub fn module() -> HostModule {
    HostModule::new(NAME)
        .declarations(DECLARATIONS)
        .function("system", |_| {
            Ok(HostValue::from(maka_ui_runtime::locale::system()))
        })
}
