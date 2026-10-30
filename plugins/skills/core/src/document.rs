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

use crate::fields::{
    self, Issue, IssueCode::*, Manifest, PartialManifest, Severity, SkillAttributes,
};
use serde::Serialize;
use std::borrow::Cow;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillDocument {
    pub manifest: Manifest,
    pub body: String,
    pub issues: Vec<Issue>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct InvalidDocument {
    pub manifest: PartialManifest,
    pub body: String,
    pub issues: Vec<Issue>,
}

/// Parse local instructions without granting any tool or filesystem authority.
/// Invalid required metadata cannot produce a loadable document.
pub fn parse(text: &str) -> Result<SkillDocument, Box<InvalidDocument>> {
    let mut result = InvalidDocument::default();
    let source = text.strip_prefix('\u{feff}').unwrap_or(text);
    let normalized = if source.contains("\r\n") {
        Cow::Owned(source.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(source)
    };
    let mut lines = normalized.split_inclusive('\n');
    let delimiter = |line: &str| line.trim_end_matches([' ', '\t']) == "---";
    let first = lines.next().unwrap_or("");
    if !delimiter(first.strip_suffix('\n').unwrap_or(first)) {
        result.body = text.trim_matches(fields::whitespace).into();
        return fail(
            result,
            MissingFrontmatter,
            "SKILL.md must start with a YAML frontmatter block.",
        );
    }
    let start = first.len();
    let mut offset = start;
    let mut closing = None;
    for line in lines {
        if delimiter(line.strip_suffix('\n').unwrap_or(line)) {
            closing = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let Some((end, body_start)) = closing else {
        return fail(
            result,
            MalformedFrontmatter,
            "SKILL.md frontmatter is missing its closing delimiter.",
        );
    };
    let frontmatter = &normalized[start..end];
    result.body = normalized[body_start..]
        .trim_matches(fields::whitespace)
        .into();
    // Arbitrary YAML exists only at this boundary; all runtime-facing fields below are typed.
    let Some(raw) = crate::yaml::parse(frontmatter) else {
        return fail(
            result,
            MalformedFrontmatter,
            "SKILL.md frontmatter is not valid YAML.",
        );
    };
    let Some(mapping) = raw.as_hash() else {
        return fail(
            result,
            MalformedFrontmatter,
            "SKILL.md frontmatter must be a YAML mapping.",
        );
    };
    let issues = &mut result.issues;
    for key in mapping.keys() {
        if !matches!(
            key.as_str(),
            "name"
                | "description"
                | "allowed-tools"
                | "required-tools"
                | "required-capabilities"
                | "license"
                | "compatibility"
                | "metadata"
                | "category"
        ) {
            issues.push(Issue::new(
                UnsupportedField,
                Severity::Warning,
                key,
                format!("Unsupported SKILL.md frontmatter field \"{key}\" is ignored."),
            ));
        }
    }
    let name = fields::required(&raw["name"], "name", MissingName, InvalidName, issues);
    recommend(name.as_deref(), 64, NameTooLong, "name", issues);
    let description = fields::required(
        &raw["description"],
        "description",
        MissingDescription,
        InvalidDescription,
        issues,
    );
    recommend(
        description.as_deref(),
        1024,
        DescriptionTooLong,
        "description",
        issues,
    );
    let mut attributes = SkillAttributes {
        allowed_tools: fields::list(
            &raw["allowed-tools"],
            "allowed-tools",
            InvalidAllowedTools,
            Severity::Warning,
            issues,
        ),
        required_tools: fields::list(
            &raw["required-tools"],
            "required-tools",
            InvalidRequiredTools,
            Severity::Error,
            issues,
        ),
        required_capabilities: fields::list(
            &raw["required-capabilities"],
            "required-capabilities",
            InvalidRequiredCapabilities,
            Severity::Error,
            issues,
        ),
        license: fields::optional(&raw["license"], "license", InvalidLicense, issues),
        compatibility: fields::optional(
            &raw["compatibility"],
            "compatibility",
            InvalidCompatibility,
            issues,
        ),
        ..Default::default()
    };
    recommend(
        attributes.compatibility.as_deref(),
        500,
        CompatibilityTooLong,
        "compatibility",
        issues,
    );
    attributes.metadata = fields::metadata(&raw["metadata"], issues);
    attributes.category = fields::optional(&raw["category"], "category", InvalidCategory, issues);
    match (name, description) {
        (Some(name), Some(description))
            if !issues.iter().any(|i| i.severity == Severity::Error) =>
        {
            Ok(SkillDocument {
                manifest: Manifest {
                    name,
                    description,
                    attributes,
                },
                body: result.body,
                issues: result.issues,
            })
        }
        (name, description) => {
            result.manifest = PartialManifest {
                name,
                description,
                attributes,
            };
            Err(Box::new(result))
        }
    }
}

fn fail(
    mut result: InvalidDocument,
    code: crate::IssueCode,
    message: &str,
) -> Result<SkillDocument, Box<InvalidDocument>> {
    result
        .issues
        .push(Issue::new(code, Severity::Error, "frontmatter", message));
    Err(Box::new(result))
}

fn recommend(
    value: Option<&str>,
    limit: usize,
    code: crate::IssueCode,
    field: &str,
    issues: &mut Vec<Issue>,
) {
    if value.is_some_and(|v| v.chars().count() > limit) {
        issues.push(Issue::new(
            code,
            Severity::Warning,
            field,
            format!("Skill {field} exceeds the Agent Skills {limit}-character recommendation."),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_aliases_are_rejected_without_losing_the_instruction_body() {
        let rejected = parse("---\nname: &name a\ndescription: *name\n---\nbody").unwrap_err();
        assert_eq!(rejected.issues[0].code, MalformedFrontmatter);
        assert_eq!(rejected.body, "body");
    }
}
