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

//! Script execution domains supplied by the product. Host admission, receipts,
//! attachment authority and actual cleanup stay with the original Host owner.
use super::{Handler, Result};
use futures_util::future::BoxFuture;
use maka_plugin_core::{package::EntryDeclaration, runtime::Published};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

pub type Exports = BTreeMap<String, Published<Arc<dyn Handler>>>;
pub trait Factory: Send + Sync + 'static {
    fn create(&self) -> Result<Arc<dyn Realm>>;
}
pub trait Realm: Send + Sync + 'static {
    fn load(&self, name: String, source: String) -> Result<Arc<dyn Module>>;
    fn is_terminated(&self) -> bool;
    fn failed(&self) -> BoxFuture<'static, String>;
    /// Completes only when the original domain's worker is physically closed.
    fn shutdown(&self) -> BoxFuture<'static, ()>;
}
pub trait Module: Send + Sync + 'static {
    fn activate(
        &self,
        entry: Arc<EntryDeclaration>,
        configuration: Value,
    ) -> BoxFuture<'static, Result<Exports>>;
    fn close(&self) -> BoxFuture<'static, Result<()>>;
}
