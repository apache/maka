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

use monty_types::{MontyObject, ObjectRef};
use serde_json::{Number, Value};

pub(crate) fn from_json(value: Value) -> MontyObject {
    match value {
        Value::Null => MontyObject::none(),
        Value::Bool(value) => MontyObject::bool(value),
        Value::String(value) => MontyObject::string(value),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                MontyObject::int(value)
            } else if let Some(value) = value.as_u64() {
                MontyObject::bigint(value.into())
            } else {
                MontyObject::float(value.as_f64().expect("JSON number"))
            }
        }
        Value::Array(values) => MontyObject::list(values.into_iter().map(from_json)),
        Value::Object(values) => MontyObject::dict(
            values
                .into_iter()
                .map(|(key, value)| (MontyObject::string(key), from_json(value))),
        ),
    }
}

pub(crate) fn to_json(value: ObjectRef<'_>) -> Result<Value, String> {
    convert(value, 0)
}

fn convert(value: ObjectRef<'_>, depth: usize) -> Result<Value, String> {
    // Business JSON values have one depth bound, independent of protocol framing.
    // Cycles also terminate here; they can never silently become repr strings.
    if depth >= crate::protocol::MAX_JSON_DEPTH {
        return Err("JSON value is cyclic or exceeds the transport nesting limit".into());
    }
    Ok(match value.type_name() {
        "NoneType" => Value::Null,
        "bool" => Value::Bool(value.as_bool().unwrap()),
        "str" => Value::String(value.as_str().unwrap().into()),
        "int" => {
            let number = value
                .py_repr()
                .parse::<Number>()
                .map_err(|_| "integer is outside the JSON number range")?;
            if !number.is_i64() && !number.is_u64() {
                return Err("integer is outside the JSON integer range".into());
            }
            Value::Number(number)
        }
        "float" => Value::Number(
            Number::from_f64(value.as_float().unwrap()).ok_or("non-finite number is not JSON")?,
        ),
        "list" | "tuple" => Value::Array(
            value
                .items()
                .unwrap()
                .into_iter()
                .map(|item| convert(item, depth + 1))
                .collect::<Result<_, _>>()?,
        ),
        "dict" => {
            let mut values = serde_json::Map::new();
            for (key, item) in value.pairs().unwrap() {
                let key = key.as_str().ok_or("JSON object keys must be strings")?;
                values.insert(key.into(), convert(item, depth + 1)?);
            }
            Value::Object(values)
        }
        name => return Err(format!("{name} cannot cross the JSON boundary")),
    })
}
