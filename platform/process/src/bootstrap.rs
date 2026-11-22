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

//! Windows execution backends and one-shot administrative setup.
mod background;
mod channel;
pub use background::background;
mod desktop;
pub use desktop::{DESKTOP_BOOTSTRAP, desktop, serve_desktop};
mod elevation;
pub use elevation::{
    AdministrativeRequest, Caller, ELEVATED_SETUP, administrative, receive_administrative,
};
mod backend;
pub(crate) mod mxc;
pub use mxc::{HELPER as MXC_HELPER, Lease as MxcLease, serve as serve_mxc};
mod logon;
pub(crate) mod protocol;
mod runner;
pub use backend::{Backend, Launch, Preparation};
pub(crate) mod terminal;
pub use channel::{Channel, Endpoint};
pub use logon::{Identity, RUNNER, Runner};
pub use runner::serve as serve_runner;
