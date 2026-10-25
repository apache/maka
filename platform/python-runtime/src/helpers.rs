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

use maka_code_runtime::{CellContext, CellDiagnostic, CellDiagnosticKind, CellOutput};
use serde_json::{Value, json};

pub(crate) fn invoke(
    name: &str,
    mut args: Vec<Value>,
    mut kwargs: serde_json::Map<String, Value>,
    context: &CellContext,
) -> Result<Value, CellDiagnostic> {
    for value in args.iter().chain(kwargs.values()) {
        crate::protocol::validate_json(value)?;
    }
    let fields: &[&str] = match name {
        "text" | "notify" | "audio" | "generated_image" => &["value"],
        "image" => &["value", "detail"],
        "store" => &["key", "value"],
        "load" => &["key"],
        "exit" | "yield_control" => &[],
        _ => return Err(error("unknown Python helper")),
    };
    if args.len() > fields.len() {
        return Err(error("too many helper arguments"));
    }
    for field in fields.iter().take(args.len()) {
        if kwargs.contains_key(*field) {
            return Err(error("argument supplied twice"));
        }
    }
    for field in fields.iter().skip(args.len()) {
        match kwargs.remove(*field) {
            Some(value) => args.push(value),
            None if name == "image" && *field == "detail" => args.push(Value::Null),
            None => return Err(error(format!("missing argument: {field}"))),
        }
    }
    if !kwargs.is_empty() {
        return Err(error("unknown helper keyword argument"));
    }
    match name {
        "text" => context.emit(CellOutput::Text {
            text: display(&args[0]),
        })?,
        "notify" => context.notify(display(&args[0]))?,
        "store" => {
            let key = key(&args[0])?.to_owned();
            context.store(key, args.remove(1))?;
        }
        "load" => return Ok(context.load(key(&args[0])?)?.unwrap_or(Value::Null)),
        "yield_control" => context.yield_output(),
        "exit" => {}
        "image" => {
            let value = &args[0];
            let detail = if !args[1].is_null() {
                args[1].clone()
            } else {
                value
                    .get("detail")
                    .or_else(|| value.pointer("/_meta/codex~1imageDetail"))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            if value.get("ref").is_some() {
                emit(
                    context,
                    json!({"kind":"image","image":{"mimeType":value.get("mimeType"),"ref":value.get("ref"),"detail":detail}}),
                )?;
            } else {
                media(
                    context,
                    "image",
                    value.get("image_url").unwrap_or(value),
                    detail,
                )?;
            }
        }
        "audio" => media(
            context,
            "audio",
            args[0].get("audio_url").unwrap_or(&args[0]),
            Value::Null,
        )?,
        "generated_image" => {
            media(
                context,
                "image",
                args[0]
                    .get("image_url")
                    .ok_or_else(|| error("missing image_url"))?,
                Value::Null,
            )?;
            if let Some(hint) = args[0].get("output_hint").filter(|value| !value.is_null()) {
                context.emit(CellOutput::Text {
                    text: display(hint),
                })?;
            }
        }
        _ => unreachable!(),
    }
    Ok(Value::Null)
}
fn media(
    context: &CellContext,
    kind: &str,
    value: &Value,
    detail: Value,
) -> Result<(), CellDiagnostic> {
    let content = if let Some(url) = value.as_str() {
        let (mime, data) = url
            .strip_prefix("data:")
            .and_then(|value| value.split_once(";base64,"))
            .ok_or_else(|| error("expected a base64 data URL"))?;
        if !mime.starts_with(&format!("{kind}/"))
            || !data
                .trim_end_matches('=')
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
            || data.len() - data.trim_end_matches('=').len() > 2
        {
            return Err(error("expected a base64 data URL"));
        }
        json!({"type":kind,"mimeType":mime,"data":data})
    } else {
        if value.get("type").and_then(Value::as_str) != Some(kind) {
            return Err(error(format!("expected a {kind} content block")));
        }
        json!({"type":kind,"mimeType":value.get("mimeType"),"data":value.get("data")})
    };
    emit(
        context,
        json!({"kind":"media","content":content,"detail":detail}),
    )
}
fn emit(context: &CellContext, value: Value) -> Result<(), CellDiagnostic> {
    context.emit(serde_json::from_value(value).map_err(error)?)
}
fn key(value: &Value) -> Result<&str, CellDiagnostic> {
    value
        .as_str()
        .ok_or_else(|| error("store key must be a string"))
}
fn display(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
pub(crate) fn error(message: impl std::fmt::Display) -> CellDiagnostic {
    CellDiagnostic::new(CellDiagnosticKind::ExecutionError, message.to_string())
}
