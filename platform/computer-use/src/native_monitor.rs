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

//! Trusted lifetime of fixed native monitor work already admitted by the Host.

use crate::ComputerAppTarget;
use maka_agent_facts::tools::ToolError;
use std::{future::Future, pin::Pin, sync::Arc};

pub type NativeMonitorFuture =
    Pin<Box<dyn Future<Output = Result<(), ToolError>> + Send + 'static>>;

/// Actual native producer, sealed before its same-owner cleanup is observed.
pub trait NativeMonitorResource: Send + Sync {
    fn seal_admission(&self);
    fn close(&self) -> NativeMonitorFuture;
}

/// One accepted fixed monitor callback, retained until its actual terminal result.
pub trait NativeMonitorPermit: Send {
    fn complete(self: Box<Self>, result: Result<(), ToolError>);
}

/// Carries an existing Host permission and revocation boundary, never a new grant.
/// It is not serialized or exposed to JavaScript. Ordinary actions still require
/// their original Host admission; only the fixed native monitor uses this lease.
pub trait NativeMonitorAuthority: Send + Sync {
    fn subject(&self) -> &ComputerAppTarget;
    /// Validate current authority before any native work becomes possible.
    fn attach(self: Arc<Self>, resource: Arc<dyn NativeMonitorResource>) -> NativeMonitorFuture;
    /// Synchronous callback admission; no Host I/O or blocking on an async future.
    fn try_admit(&self) -> Result<Box<dyn NativeMonitorPermit>, ToolError>;
}
