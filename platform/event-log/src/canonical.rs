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

//! Lossless canonical events over immutable headers and typed body slots.
pub(crate) mod migration;
mod read;
mod recipe;
mod source;
mod write;

pub(crate) use read::{COLUMNS, JOINS, json, json_on_handle, one};
pub(crate) use recipe::projection;
pub(crate) use source::{
    SPAN_COLUMNS, SpanMetadata, with_span, with_span_metadata, with_span_on_row,
};
pub(crate) use write::publish;
