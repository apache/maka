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

use crate::yaml::Value;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAttributes {
    pub allowed_tools: Vec<String>,
    pub required_tools: Vec<String>,
    pub required_capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility: Option<String>,
    pub metadata: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Manifest {
    pub name: String,
    pub description: String,
    #[serde(flatten)]
    pub attributes: SkillAttributes,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PartialManifest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(flatten)]
    pub attributes: SkillAttributes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Warning,
    Error,
}

pub use crate::SkillValidationCode as IssueCode;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    pub code: IssueCode,
    pub severity: Severity,
    pub message: String,
    pub field: String,
}

impl Issue {
    pub(crate) fn new(
        code: IssueCode,
        severity: Severity,
        field: &str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            severity,
            field: field.into(),
            message: message.into(),
        }
    }
}

// ECMAScript whitespace, shared with the existing skill token/frontmatter contract.
pub(crate) fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(crate) fn clean(value: &str) -> String {
    value.chars().filter(|c| !matches!(c, '\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}'))
        .collect::<String>().trim_matches(whitespace).into()
}

pub(crate) fn required(
    value: &Value,
    field: &str,
    missing: IssueCode,
    invalid: IssueCode,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    let cleaned = value.as_str().map(clean);
    if value.is_null() || cleaned.as_ref().is_some_and(String::is_empty) {
        issues.push(Issue::new(
            missing,
            Severity::Error,
            field,
            format!("Skill {field} is required and must not be empty."),
        ));
        None
    } else if cleaned.is_none() {
        issues.push(Issue::new(
            invalid,
            Severity::Error,
            field,
            format!("Skill {field} must be a string."),
        ));
        None
    } else {
        cleaned
    }
}

pub(crate) fn optional(
    value: &Value,
    field: &str,
    code: IssueCode,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    if value.is_null() {
        return None;
    }
    match value.as_str().map(clean) {
        Some(text) if !text.is_empty() => Some(text),
        _ => {
            issues.push(Issue::new(
                code,
                Severity::Warning,
                field,
                format!("Optional skill field {field} must be a non-empty string when provided."),
            ));
            None
        }
    }
}

pub(crate) fn list(
    value: &Value,
    field: &str,
    code: IssueCode,
    severity: Severity,
    issues: &mut Vec<Issue>,
) -> Vec<String> {
    if value.is_null() || value.as_str() == Some("") {
        return Vec::new();
    }
    let candidates: Vec<Option<&str>> = match value {
        Value::String(text) => text
            .trim_matches(whitespace)
            .split(|c| whitespace(c) || c == ',')
            .filter(|s| !s.is_empty())
            .map(Some)
            .collect(),
        Value::Array(items) => items.iter().map(Value::as_str).collect(),
        _ => {
            issues.push(Issue::new(code, severity, field, format!("Skill field {field} must be a space- or comma-separated string or a string list.")));
            return Vec::new();
        }
    };
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut invalid = value.as_str().is_some_and(|text| {
        let text = text.trim_matches(whitespace);
        text.is_empty() || text.starts_with(',') || text.ends_with(',')
    });
    for candidate in candidates {
        match candidate.map(clean) {
            Some(token) if !token.is_empty() && !token.chars().any(whitespace) => {
                if seen.insert(token.clone()) {
                    result.push(token);
                }
            }
            _ => invalid = true,
        }
    }
    // An empty YAML sequence is valid; whitespace-only strings are not.
    if value.as_vec().is_some_and(Vec::is_empty) {
        invalid = false;
    }
    if invalid {
        issues.push(Issue::new(
            code,
            severity,
            field,
            format!(
                "Skill field {field} contains a non-string, empty, or whitespace-bearing entry."
            ),
        ));
    }
    result
}

pub(crate) fn metadata(value: &Value, issues: &mut Vec<Issue>) -> BTreeMap<String, String> {
    if value.is_null() {
        return BTreeMap::new();
    }
    let Some(entries) = value.as_hash() else {
        issues.push(Issue::new(
            IssueCode::InvalidMetadata,
            Severity::Warning,
            "metadata",
            "Skill metadata must be a mapping of string keys to string values.",
        ));
        return BTreeMap::new();
    };
    let mut result = BTreeMap::new();
    for (key, value) in entries {
        if let Some(text) = value.as_str() {
            result.insert(key.clone(), clean(text));
        } else {
            issues.push(Issue::new(
                IssueCode::InvalidMetadata,
                Severity::Warning,
                &format!("metadata.{key}"),
                format!("Skill metadata value for \"{key}\" must be a string and was ignored."),
            ));
        }
    }
    result
}
