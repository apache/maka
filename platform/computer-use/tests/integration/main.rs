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

mod native;
mod repl_audio;
#[cfg(feature = "native-desktop")]
mod repl_browser;
mod repl_clipboard;
mod repl_contract;
mod repl_dialogs;
mod repl_native_geometry;
mod repl_native_gtk;
mod repl_playwright;
mod repl_user_tab_context;
mod resource_composition;

#[cfg(all(feature = "native-desktop", target_os = "linux"))]
#[path = "support/linux_wheel.rs"]
mod linux_wheel;
