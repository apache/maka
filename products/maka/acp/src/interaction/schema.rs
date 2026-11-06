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

use maka_agent_facts::capability::{FormField, FormFieldSpec, FormFormat};
use maka_agent_facts::interaction::InteractionQuestion;
use serde_json::{Map, Value, json};

pub(super) fn questions(questions: &[InteractionQuestion]) -> Value {
    let properties: Map<_,_> = questions.iter().enumerate().map(|(index, question)| {
        let choices = question.options.iter().map(|option| match &option.description {
            Some(description) => format!("{}: {description}", option.label), None => option.label.clone(),
        }).collect::<Vec<_>>().join("\n");
        (format!("question_{index}"), json!({"type":"string", "title":question.question,"description":format!("{choices}\nYou may also enter your own answer."), "minLength":1,"maxLength":2048}))
    }).collect();
    json!({"type":"object","properties":properties,"required":[]})
}

pub(super) fn form(fields: &[FormField]) -> Result<Value, crate::Error> {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for field in fields {
        let mut property = match &field.spec {
            FormFieldSpec::String {
                default,
                min_length,
                max_length,
                format,
            } => {
                let mut p = json!({"type":"string"});
                optional(&mut p, "default", default)?;
                optional(
                    &mut p,
                    "minLength",
                    &min_length.map(u32::try_from).transpose()?,
                )?;
                optional(
                    &mut p,
                    "maxLength",
                    &max_length.map(u32::try_from).transpose()?,
                )?;
                optional(
                    &mut p,
                    "format",
                    &format.map(|f| match f {
                        FormFormat::Email => "email",
                        FormFormat::Uri => "uri",
                        FormFormat::Date => "date",
                        FormFormat::DateTime => "date-time",
                    }),
                )?;
                p
            }
            FormFieldSpec::Number {
                default,
                minimum,
                maximum,
            } => {
                let mut p = json!({"type":"number"});
                optional(&mut p, "default", default)?;
                optional(&mut p, "minimum", minimum)?;
                optional(&mut p, "maximum", maximum)?;
                p
            }
            FormFieldSpec::Integer {
                default,
                minimum,
                maximum,
            } => {
                let mut p = json!({"type":"integer"});
                optional(&mut p, "default", &integer(*default)?)?;
                optional(&mut p, "minimum", &integer(*minimum)?)?;
                optional(&mut p, "maximum", &integer(*maximum)?)?;
                p
            }
            FormFieldSpec::Boolean { default } => {
                let mut p = json!({"type":"boolean"});
                optional(&mut p, "default", default)?;
                p
            }
            FormFieldSpec::SingleSelect { options, default } => {
                let mut p = json!({"type":"string","oneOf":options.iter().map(|o|json!({"const":o.value,"title":o.label})).collect::<Vec<_>>()});
                optional(&mut p, "default", default)?;
                p
            }
            FormFieldSpec::MultiSelect {
                options,
                default,
                min_items,
                max_items,
            } => {
                let mut p = json!({"type":"array","items":{"anyOf":options.iter().map(|o|json!({"const":o.value,"title":o.label})).collect::<Vec<_>>()}});
                optional(&mut p, "default", default)?;
                optional(&mut p, "minItems", min_items)?;
                optional(&mut p, "maxItems", max_items)?;
                p
            }
        };
        property["title"] = json!(field.label);
        optional(&mut property, "description", &field.description)?;
        properties.insert(field.name.clone(), property);
        if field.required {
            required.push(field.name.clone());
        }
    }
    Ok(json!({"type":"object","properties":properties,"required":required}))
}
fn optional<T: serde::Serialize>(
    object: &mut Value,
    key: &str,
    value: &Option<T>,
) -> Result<(), crate::Error> {
    if let Some(value) = value {
        object[key] = serde_json::to_value(value)?;
    }
    Ok(())
}

fn integer(value: Option<f64>) -> Result<Option<i64>, crate::Error> {
    value
        .map(|value| {
            if !value.is_finite() || value.fract() != 0.0 || value.abs() > 9_007_199_254_740_991.0 {
                Err("Integer form constraint is outside ACP's exact numeric range".into())
            } else {
                Ok(value as i64)
            }
        })
        .transpose()
}
