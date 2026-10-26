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

mod prompt;
use crate::{
    Error, Result,
    input::{Extensions, Message},
};
pub use prompt::{PromptOptions, messages};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub struct Sampling {
    pub max_output_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub stop_sequences: Option<Vec<String>>,
    pub seed: Option<i64>,
}
#[derive(Debug, Default)]
pub enum Format {
    #[default]
    Text,
    Json {
        schema: Option<Value>,
        name: Option<String>,
        description: Option<String>,
    },
}
#[derive(Debug)]
pub enum Tool {
    Function {
        name: String,
        description: Option<String>,
        schema: Value,
        strict: Option<bool>,
    },
    Hosted {
        identifier: String,
    },
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Function(String),
}
#[derive(Debug)]
pub enum Warning {
    Unsupported {
        feature: String,
        details: Option<String>,
    },
    Deprecated {
        setting: String,
        message: String,
    },
}
impl Warning {
    fn unsupported(feature: impl Into<String>) -> Self {
        Self::Unsupported {
            feature: feature.into(),
            details: None,
        }
    }
}
#[derive(Debug)]
pub struct Config {
    pub provider_namespace: String,
    pub structured_output: bool,
    pub multipart_tool_content: bool,
    pub include_usage: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            provider_namespace: "openaiCompatible".into(),
            structured_output: false,
            multipart_tool_content: false,
            include_usage: false,
        }
    }
}
pub struct Request<'a> {
    pub model: String,
    pub messages: &'a [Message],
    pub tools: Vec<Tool>,
    pub tool_choice: Option<ToolChoice>,
    pub sampling: Sampling,
    pub format: Format,
    pub reasoning: Option<String>,
    pub extensions: Extensions,
    pub streaming: bool,
}
pub struct Prepared {
    pub body: Value,
    pub warnings: Vec<Warning>,
    pub metadata_namespace: String,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    user: Option<String>,
    reasoning_effort: Option<String>,
    text_verbosity: Option<String>,
    strict_json_schema: Option<bool>,
}
#[derive(Serialize)]
struct FunctionDefinition {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    parameters: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    strict: Option<bool>,
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Definition {
    Function { function: FunctionDefinition },
}
pub struct PreparedTools {
    pub definitions: Option<Value>,
    pub choice: Option<Value>,
    pub warnings: Vec<Warning>,
}
pub fn prepare_tools(tools: Vec<Tool>, choice: Option<ToolChoice>) -> PreparedTools {
    if tools.is_empty() {
        return PreparedTools {
            definitions: None,
            choice: None,
            warnings: vec![],
        };
    }
    let mut warnings = vec![];
    let definitions = tools
        .into_iter()
        .filter_map(|tool| match tool {
            Tool::Function {
                name,
                description,
                schema,
                strict,
            } => Some(Definition::Function {
                function: FunctionDefinition {
                    name,
                    description,
                    parameters: schema,
                    strict,
                },
            }),
            Tool::Hosted { identifier } => {
                warnings.push(Warning::unsupported(format!(
                    "provider-defined tool {identifier}"
                )));
                None
            }
        })
        .collect::<Vec<_>>();
    let choice = choice.map(|v| match v {
        ToolChoice::Function(name) => json!({"type":"function","function":{"name":name}}),
        other => serde_json::to_value(other).expect("tool choice"),
    });
    PreparedTools {
        definitions: Some(serde_json::to_value(definitions).expect("definitions")),
        choice,
        warnings,
    }
}
fn canonical_namespace(namespace: &str) -> String {
    let mut chars = namespace.chars().peekable();
    let mut canonical = String::new();
    while let Some(c) = chars.next() {
        if matches!(c, '_' | '-') && chars.peek().is_some_and(char::is_ascii_lowercase) {
            canonical.push(chars.next().expect("peeked character").to_ascii_uppercase());
        } else {
            canonical.push(c);
        }
    }
    canonical
}
/// Message projection settings, independent from tools and envelope fields.
pub fn prompt_options(
    namespace: &str,
    provided: &Extensions,
    multipart_tool_content: bool,
) -> PromptOptions {
    let canonical = canonical_namespace(namespace);
    let metadata_namespace = if canonical != namespace
        && provided
            .as_ref()
            .and_then(|provided| provided.get(&canonical))
            .is_some_and(|value| !value.is_null())
    {
        canonical
    } else {
        namespace.to_owned()
    };
    PromptOptions {
        provider_namespace: namespace.to_owned(),
        metadata_namespace,
        multipart_tool_content,
    }
}

/// Selected provider extensions may override standard request fields. Keep that
/// escape hatch at serialization, after typed sampling and format construction.
#[derive(Serialize)]
struct Body {
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frequency_penalty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    presence_penalty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<Value>,
}
/// Prepare the bounded request fields independently from the replayable prompt.
/// The caller owns streaming `messages` after validating these fields.
pub fn prepare_fields(request: Request<'_>, config: &Config) -> Result<Prepared> {
    prepare_inner(request, config, false)
}

pub fn prepare(request: Request<'_>, config: &Config) -> Result<Prepared> {
    prepare_inner(request, config, true)
}

fn prepare_inner(
    request: Request<'_>,
    config: &Config,
    include_messages: bool,
) -> Result<Prepared> {
    let namespace = &config.provider_namespace;
    let canonical = canonical_namespace(namespace);
    let provided = request.extensions.unwrap_or_default();
    let mut warnings = vec![];
    for (old, new) in [
        ("openai-compatible", "openaiCompatible"),
        (namespace.as_str(), canonical.as_str()),
    ] {
        if old != new && provided.get(old).is_some_and(|v| !v.is_null()) {
            warnings.push(Warning::Deprecated {
                setting: format!("providerOptions key '{old}'"),
                message: format!("Use '{new}' instead."),
            });
        }
    }
    let known = [
        "user",
        "reasoningEffort",
        "textVerbosity",
        "strictJsonSchema",
    ];
    let mut merged = BTreeMap::new();
    for key in [
        "openai-compatible",
        "openaiCompatible",
        namespace.as_str(),
        canonical.as_str(),
    ] {
        if let Some(object) = provided.get(key).and_then(Value::as_object) {
            for name in known {
                if let Some(value) = object.get(name) {
                    // Explicit null is invalid for these per-request options.
                    if !(if name == "strictJsonSchema" {
                        value.is_boolean()
                    } else {
                        value.is_string()
                    }) {
                        return Err(Error::InvalidArgument {
                            field: format!("{key}.{name}"),
                            value: value.clone(),
                        });
                    }
                    merged.insert(name, value.clone());
                }
            }
        }
    }
    let options: Options =
        serde_json::from_value(json!(merged)).expect("known options validated at boundary");
    let metadata_namespace =
        if canonical != *namespace && provided.get(&canonical).is_some_and(|v| !v.is_null()) {
            canonical.clone()
        } else {
            namespace.clone()
        };
    let sampling = request.sampling;
    if sampling.top_k.is_some() {
        warnings.push(Warning::unsupported("topK"));
    }
    let response_format = match request.format {
        Format::Text => None,
        Format::Json {
            schema: Some(schema),
            name,
            description,
        } if config.structured_output => {
            let mut schema = json!({"schema":schema,"strict":options.strict_json_schema.unwrap_or(true),"name":name.unwrap_or_else(||"response".into())});
            if let Some(description) = description {
                schema["description"] = json!(description);
            }
            Some(json!({"type":"json_schema","json_schema":schema}))
        }
        Format::Json { schema, .. } => {
            if schema.is_some() {
                warnings.push(Warning::Unsupported {
                    feature: "responseFormat".into(),
                    details: Some(
                        "JSON response format schema is only supported with structuredOutputs"
                            .into(),
                    ),
                });
            }
            Some(json!({"type":"json_object"}))
        }
    };
    let body = Body {
        model: request.model,
        user: options.user,
        max_tokens: sampling.max_output_tokens,
        temperature: sampling.temperature,
        top_p: sampling.top_p,
        frequency_penalty: sampling.frequency_penalty,
        presence_penalty: sampling.presence_penalty,
        stop: sampling.stop_sequences,
        seed: sampling.seed,
        response_format,
    };
    let mut body = serde_json::to_value(body).expect("request body");
    for namespace in [namespace, &canonical] {
        if let Some(object) = provided.get(namespace).and_then(Value::as_object) {
            for (key, value) in object {
                if !known.contains(&key.as_str()) {
                    body[key] = value.clone();
                }
            }
        }
    }
    if let Some(reasoning) = options.reasoning_effort.or(request.reasoning) {
        body["reasoning_effort"] = json!(reasoning);
    }
    if let Some(verbosity) = options.text_verbosity {
        body["verbosity"] = json!(verbosity);
    }
    // Extensions cannot replace the canonical prompt, including in streaming mode.
    body.as_object_mut()
        .expect("request fields")
        .remove("messages");
    if include_messages {
        body["messages"] = json!(messages(
            request.messages,
            &PromptOptions {
                provider_namespace: namespace.clone(),
                metadata_namespace: metadata_namespace.clone(),
                multipart_tool_content: config.multipart_tool_content
            }
        )?);
    }
    let tools = prepare_tools(request.tools, request.tool_choice);
    warnings.extend(tools.warnings);
    if let Some(definitions) = tools.definitions {
        body["tools"] = definitions;
    }
    if let Some(choice) = tools.choice {
        body["tool_choice"] = choice;
    }
    if request.streaming {
        body["stream"] = json!(true);
        if config.include_usage {
            body["stream_options"] = json!({"include_usage":true});
        }
    }
    Ok(Prepared {
        body,
        warnings,
        metadata_namespace,
    })
}
