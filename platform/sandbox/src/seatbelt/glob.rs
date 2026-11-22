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

use crate::{Error, filesystem::compile_glob};
use regex_syntax::hir::{Class, Hir, HirKind, Repetition};

/// Both kernel filters derive from the same glob parser used by Host checks.
/// Ancestors are prefixes before a separator in any matching path; protecting
/// only a glob's literal prefix would leave rename escapes under alternatives.
pub(super) fn compile(pattern: &str) -> Result<(String, Option<String>), Error> {
    let glob = compile_glob(pattern)?;
    let tree = regex_syntax::ParserBuilder::new()
        .utf8(false)
        .dot_matches_new_line(true)
        .build()
        .parse(glob.regex())
        .map_err(|error| Error::Invalid(error.to_string()))?;
    let denied = format!("^({})(/.*)?$", render(&tree)?);
    let ancestors = parents(&tree)
        .map(|tree| render(&tree).map(|body| format!("^({body})$")))
        .transpose()?;
    Ok((denied, ancestors))
}

fn parents(tree: &Hir) -> Option<Hir> {
    match tree.kind() {
        HirKind::Empty | HirKind::Look(_) => None,
        HirKind::Literal(literal) => {
            let alternatives: Vec<_> = literal
                .0
                .iter()
                .enumerate()
                .filter(|(_, byte)| **byte == b'/')
                .map(|(index, _)| Hir::literal(literal.0[..index].to_vec()))
                .collect();
            (!alternatives.is_empty()).then(|| Hir::alternation(alternatives))
        }
        HirKind::Class(Class::Bytes(class)) => class
            .ranges()
            .iter()
            .any(|range| range.start() <= b'/' && b'/' <= range.end())
            .then(Hir::empty),
        HirKind::Class(Class::Unicode(class)) => class
            .ranges()
            .iter()
            .any(|range| range.start() <= '/' && '/' <= range.end())
            .then(Hir::empty),
        HirKind::Capture(capture) => parents(&capture.sub),
        HirKind::Alternation(parts) => {
            let alternatives: Vec<_> = parts.iter().filter_map(parents).collect();
            (!alternatives.is_empty()).then(|| Hir::alternation(alternatives))
        }
        HirKind::Concat(parts) => {
            let mut prefix = Vec::new();
            let mut alternatives = Vec::new();
            for part in parts {
                if let Some(parent) = parents(part) {
                    let mut branch = prefix.clone();
                    branch.push(parent);
                    alternatives.push(Hir::concat(branch));
                }
                prefix.push(part.clone());
            }
            (!alternatives.is_empty()).then(|| Hir::alternation(alternatives))
        }
        HirKind::Repetition(repetition) => {
            if repetition.max == Some(0) {
                return None;
            }
            parents(&repetition.sub).map(|parent| {
                Hir::concat(vec![
                    Hir::repetition(Repetition {
                        min: 0,
                        max: repetition.max.map(|max| max - 1),
                        greedy: true,
                        sub: repetition.sub.clone(),
                    }),
                    parent,
                ])
            })
        }
    }
}

fn render(tree: &Hir) -> Result<String, Error> {
    let rendered = match tree.kind() {
        HirKind::Empty | HirKind::Look(_) => String::new(),
        HirKind::Literal(literal) => std::str::from_utf8(&literal.0)
            .map_err(|_| Error::Unsupported("non-Unicode glob fragment".into()))?
            .chars()
            .map(escape)
            .collect(),
        HirKind::Class(Class::Unicode(class)) => {
            let mut literals = Vec::new();
            for range in class.ranges() {
                for scalar in range.start() as u32..=range.end() as u32 {
                    let Some(character) = char::from_u32(scalar) else {
                        continue;
                    };
                    literals.push(escape(character));
                }
            }
            format!("({})", literals.join("|"))
        }
        HirKind::Class(Class::Bytes(class)) => {
            let mut class = class.clone();
            let negated = class
                .ranges()
                .first()
                .is_some_and(|range| range.start() == 0);
            if negated {
                class.negate();
            }
            if negated && class.ranges().is_empty() {
                return Ok(".".into());
            }
            let mut ranges = Vec::new();
            for range in class.ranges() {
                if !range.end().is_ascii() {
                    return Err(Error::Unsupported("Seatbelt cannot enforce non-ASCII byte classes; use literal path rules or alternatives".into()));
                }
                ranges.push(regex_syntax::hir::ClassUnicodeRange::new(
                    range.start() as char,
                    range.end() as char,
                ));
            }
            let mut class = regex_syntax::hir::ClassUnicode::new(ranges);
            if negated {
                class.negate();
            }
            render_class(&class)
        }
        HirKind::Capture(capture) => render(&capture.sub)?,
        HirKind::Concat(parts) => {
            let mut result = String::new();
            for part in parts {
                result.push_str(&render(part)?);
            }
            result
        }
        HirKind::Alternation(parts) => {
            let parts = parts.iter().map(render).collect::<Result<Vec<_>, _>>()?;
            let optional = parts.iter().any(String::is_empty);
            let parts: Vec<_> = parts.into_iter().filter(|part| !part.is_empty()).collect();
            if parts.is_empty() {
                String::new()
            } else {
                format!("({}){}", parts.join("|"), if optional { "?" } else { "" })
            }
        }
        HirKind::Repetition(repetition) => {
            let count = match (repetition.min, repetition.max) {
                (0, None) => "*".into(),
                (1, None) => "+".into(),
                (0, Some(1)) => "?".into(),
                (min, Some(max)) if min == max => format!("{{{min}}}"),
                (min, Some(max)) => format!("{{{min},{max}}}"),
                (min, None) => format!("{{{min},}}"),
            };
            format!("({}){count}", render(&repetition.sub)?)
        }
    };
    Ok(rendered)
}

fn render_class(class: &regex_syntax::hir::ClassUnicode) -> String {
    let mut class = class.clone();
    // argv cannot contain NUL. Negate classes containing it, so the generated
    // expression remains representable without changing valid path matches.
    let negate = class
        .ranges()
        .first()
        .is_some_and(|range| range.start() == '\0');
    if negate {
        class.negate();
    }
    if negate && class.ranges().is_empty() {
        return ".".into();
    }
    let mut result = if negate {
        "[^".to_owned()
    } else {
        "[".to_owned()
    };
    for range in class.ranges() {
        result.push_str(&escape(range.start()));
        if range.start() != range.end() {
            result.push('-');
            result.push_str(&escape(range.end()));
        }
    }
    result.push(']');
    result
}

fn escape(character: char) -> String {
    if ".+*?()|[]{}^$\\-".contains(character) {
        format!("\\{character}")
    } else {
        character.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_byte_classes_fail_instead_of_losing_denials() {
        assert!(matches!(
            compile("/workspace/*[é]*"),
            Err(Error::Unsupported(_))
        ));
    }
}
