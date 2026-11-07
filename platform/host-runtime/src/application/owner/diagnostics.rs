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

//! Safe scalar evidence from typed storage failures, never their payloads.

use maka_event_log::StoreError;

pub(super) fn cause(error: &StoreError) -> &'static str {
    match error.underlying() {
        StoreError::CommitUnknown(_) => "store_commit_unknown",
        StoreError::Sqlite(_) => "store_sqlite",
        StoreError::Io(_) => "store_io",
        _ => "store_error",
    }
}

pub(super) fn sql_code(error: &StoreError) -> Option<i32> {
    match error.underlying() {
        StoreError::Sqlite(error) | StoreError::CommitUnknown(error) => {
            error.sqlite_error().map(|error| error.extended_code)
        }
        _ => None,
    }
}

pub(super) fn os_code(error: &StoreError) -> Option<i32> {
    match error.underlying() {
        StoreError::Io(error) => error.raw_os_error(),
        _ => None,
    }
}
