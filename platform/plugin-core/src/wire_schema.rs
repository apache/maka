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
//! Schema-only projections; these types never hold runtime values or authority.
use schemars::{JsonSchema, Schema, SchemaGenerator};
use std::{borrow::Cow, marker::PhantomData};

/// `Option<T>` with required field presence, matching serde's explicit nullable
/// inputs and serialized nullable outputs. No runtime DTO wrapper is introduced.
pub struct RequiredNullable<T>(PhantomData<T>);
impl<T: JsonSchema> JsonSchema for RequiredNullable<T> {
    fn schema_name() -> Cow<'static, str> {
        Option::<T>::schema_name()
    }
    fn inline_schema() -> bool {
        true
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        Option::<T>::json_schema(generator)
    }
}
