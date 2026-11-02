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

//! Compact derived descriptors using Postcard's typed enum and integer encoding.
//! Descriptor declarations and their Serde layout define the storage schema.
use super::super::invalid;
use crate::StoreError;
use serde::{Serialize, de::DeserializeOwned};
pub(crate) fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, StoreError> {
    postcard::to_allocvec(value).map_err(|error| invalid(error.to_string()))
}
pub(crate) fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, StoreError> {
    let (value, remaining) =
        postcard::take_from_bytes(bytes).map_err(|error| invalid(error.to_string()))?;
    if !remaining.is_empty() {
        return Err(invalid("trailing directory descriptor bytes"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests;
