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

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, schemars::JsonSchema)]
pub struct FormInput {
    pub message: String,
    pub requester: FormRequester,
    pub fields: Vec<FormField>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FormRequester {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FormOption {
    pub value: String,
    pub label: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, schemars::JsonSchema)]
pub struct FormField {
    pub name: String,
    pub label: String,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(flatten)]
    pub spec: FormFieldSpec,
}
#[derive(Clone, Debug, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FormFieldSpec {
    String {
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        min_length: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_length: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<FormFormat>,
    },
    Number {
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        maximum: Option<f64>,
    },
    Integer {
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        minimum: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        maximum: Option<f64>,
    },
    Boolean {
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<bool>,
    },
    SingleSelect {
        options: Vec<FormOption>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<String>,
    },
    MultiSelect {
        options: Vec<FormOption>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        min_items: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_items: Option<usize>,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum FormFormat {
    Email,
    Uri,
    Date,
    DateTime,
}

#[derive(Clone, Debug, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum FormValue {
    String(String),
    Number(f64),
    Boolean(bool),
    Strings(Vec<String>),
}

#[derive(Clone, Debug, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum FormResult {
    Accept { values: BTreeMap<String, FormValue> },
    Decline,
    Cancel,
}

macro_rules! decode_form {
    ($ty:ty, $decode:path) => {
        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = serde_json::Value::deserialize(deserializer)?;
                $decode(&value).map_err(serde::de::Error::custom)
            }
        }
    };
}
decode_form!(FormInput, super::form_decode::decode_input);
decode_form!(FormField, super::form_decode::field);
decode_form!(FormResult, super::form_decode::decode_form_result);

impl FormInput {
    pub fn validate(&self) -> Result<(), &'static str> {
        for field in &self.fields {
            match &field.spec {
                FormFieldSpec::Number {
                    default,
                    minimum,
                    maximum,
                }
                | FormFieldSpec::Integer {
                    default,
                    minimum,
                    maximum,
                } if [default, minimum, maximum]
                    .into_iter()
                    .flatten()
                    .any(|n| !n.is_finite()) =>
                {
                    return Err("Non-finite form number");
                }
                _ => {}
            }
        }
        super::form_decode::decode_input(&serde_json::to_value(self).map_err(|_| "Invalid form")?)?;
        Ok(())
    }
}
impl FormResult {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.validate_values()?;
        Ok(())
    }
    pub(crate) fn validate_values(&self) -> Result<(), &'static str> {
        if let Self::Accept { values } = self
            && values
                .values()
                .any(|v| matches!(v, FormValue::Number(n) if !n.is_finite()))
        {
            return Err("Non-finite form value");
        }
        super::form_result_decode::decode_form_result(
            &serde_json::to_value(self).map_err(|_| "Invalid form")?,
        )?;
        Ok(())
    }
    pub fn validate_for_fields(&self, fields: &[FormField]) -> Result<(), &'static str> {
        self.validate_values()?;
        if let Self::Accept { values } = self
            && (values
                .keys()
                .any(|key| !fields.iter().any(|f| &f.name == key))
                || fields.iter().any(|f| match values.get(&f.name) {
                    Some(value) => !super::form_validation::valid(&f.spec, value),
                    None => f.required,
                }))
        {
            return Err("Form answer does not match request fields");
        }
        Ok(())
    }
}
