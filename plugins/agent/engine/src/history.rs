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

//! Pure canonical prompt projection and request-owned preparation resources.
pub(crate) mod canonical_prompt;
pub(crate) mod capture_arena;
pub(crate) mod frozen;
pub(crate) mod images;
pub(crate) mod measure_source;
pub(crate) mod preparation;
pub mod preparation_io;
mod references;
pub(crate) mod request_backing;
pub(crate) mod resources;
pub(crate) mod semantic;
pub(crate) mod serialize_source;
pub(crate) mod source_summary;
pub(crate) mod user;
