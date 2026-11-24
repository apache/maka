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

//! Minimal, deterministic ICU MessageFormat subset parser and validator.

use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamType {
    Text,
    Count,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Node {
    Literal(String),
    Var(String),
    Hash,
    Plural {
        var: String,
        cases: Vec<(PluralSelector, Vec<Node>)>,
    },
    Select {
        var: String,
        cases: Vec<(String, Vec<Node>)>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PluralSelector {
    Exact(i64),
    Zero,
    One,
    Two,
    Few,
    Many,
    Other,
}

pub fn parse_message(input: &str) -> Result<Vec<Node>, String> {
    let mut parser = Parser {
        bytes: input.as_bytes(),
        pos: 0,
    };
    let nodes = parser.parse_nodes(false, false)?;
    if parser.pos != parser.bytes.len() {
        return Err(format!(
            "unexpected trailing character at byte {}",
            parser.pos
        ));
    }
    Ok(nodes)
}

pub fn collect_params(nodes: &[Node], out: &mut BTreeMap<String, ParamType>) -> Result<(), String> {
    for node in nodes {
        match node {
            Node::Literal(_) | Node::Hash => {}
            Node::Var(name) => {
                out.entry(name.clone()).or_insert(ParamType::Text);
            }
            Node::Plural { var, cases } => {
                out.insert(var.clone(), ParamType::Count);
                for (_, branch) in cases {
                    collect_params(branch, out)?;
                }
            }
            Node::Select { var, cases } => {
                if let Some(prev) = out.get(var) {
                    if *prev == ParamType::Count {
                        return Err(format!(
                            "variable {var} used as both plural count and select text"
                        ));
                    }
                }
                out.insert(var.clone(), ParamType::Text);
                for (_, branch) in cases {
                    collect_params(branch, out)?;
                }
            }
        }
    }
    Ok(())
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if b.is_ascii_whitespace() {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn read_ident(&mut self) -> Result<String, String> {
        self.skip_ws();
        let start = self.pos;
        while let Some(b) = self.peek() {
            if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'=' {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == start {
            return Err(format!("expected identifier at byte {}", self.pos));
        }
        Ok(String::from_utf8(self.bytes[start..self.pos].to_vec()).unwrap())
    }

    fn parse_nodes(&mut self, stop_on_rbrace: bool, in_plural: bool) -> Result<Vec<Node>, String> {
        let mut nodes = Vec::new();
        let mut lit = String::new();
        let flush = |lit: &mut String, nodes: &mut Vec<Node>| {
            if !lit.is_empty() {
                nodes.push(Node::Literal(std::mem::take(lit)));
            }
        };

        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if b == b'}' {
                if stop_on_rbrace {
                    flush(&mut lit, &mut nodes);
                    return Ok(nodes);
                }
                return Err(format!("unmatched closing brace at byte {}", self.pos));
            }
            if b == b'#' && in_plural {
                flush(&mut lit, &mut nodes);
                nodes.push(Node::Hash);
                self.pos += 1;
                continue;
            }
            if b == b'\'' {
                if self.bytes.get(self.pos + 1) == Some(&b'\'') {
                    lit.push('\'');
                    self.pos += 2;
                    continue;
                }
                if matches!(
                    self.bytes.get(self.pos + 1),
                    Some(b'{') | Some(b'}') | Some(b'#')
                ) {
                    self.pos += 1;
                    while self.pos < self.bytes.len() {
                        if self.bytes[self.pos] == b'\'' {
                            if self.bytes.get(self.pos + 1) == Some(&b'\'') {
                                lit.push('\'');
                                self.pos += 2;
                            } else {
                                self.pos += 1;
                                break;
                            }
                        } else {
                            let rest = std::str::from_utf8(&self.bytes[self.pos..]).unwrap();
                            let ch = rest.chars().next().unwrap();
                            lit.push(ch);
                            self.pos += ch.len_utf8();
                        }
                    }
                    continue;
                }
                lit.push('\'');
                self.pos += 1;
                continue;
            }
            if b == b'{' {
                flush(&mut lit, &mut nodes);
                nodes.push(self.parse_brace()?);
                continue;
            }
            let rest = std::str::from_utf8(&self.bytes[self.pos..]).unwrap();
            let ch = rest.chars().next().unwrap();
            lit.push(ch);
            self.pos += ch.len_utf8();
        }

        if stop_on_rbrace {
            return Err("unclosed brace in ICU message".into());
        }
        flush(&mut lit, &mut nodes);
        Ok(nodes)
    }

    fn parse_brace(&mut self) -> Result<Node, String> {
        debug_assert_eq!(self.peek(), Some(b'{'));
        self.pos += 1;
        let var = self.read_ident()?;
        if !valid_var_name(&var) {
            return Err(format!("invalid placeholder name {var:?}"));
        }
        self.skip_ws();
        match self.peek() {
            Some(b'}') => {
                self.pos += 1;
                Ok(Node::Var(var))
            }
            Some(b',') => {
                self.pos += 1;
                let kind = self.read_ident()?;
                self.skip_ws();
                if self.peek() != Some(b',') {
                    return Err(format!("expected comma after {kind} at byte {}", self.pos));
                }
                self.pos += 1;
                match kind.as_str() {
                    "plural" => {
                        let mut cases = Vec::new();
                        let mut has_other = false;
                        loop {
                            self.skip_ws();
                            if self.peek() == Some(b'}') {
                                self.pos += 1;
                                break;
                            }
                            let sel_str = self.read_ident()?;
                            let selector = parse_plural_selector(&sel_str)?;
                            if selector == PluralSelector::Other {
                                has_other = true;
                            }
                            self.skip_ws();
                            if self.peek() != Some(b'{') {
                                return Err(format!(
                                    "expected opening brace for plural branch {sel_str}"
                                ));
                            }
                            self.pos += 1;
                            let body = self.parse_nodes(true, true)?;
                            if self.peek() != Some(b'}') {
                                return Err(format!(
                                    "expected closing brace for plural branch {sel_str}"
                                ));
                            }
                            self.pos += 1;
                            cases.push((selector, body));
                        }
                        if !has_other {
                            return Err(format!("plural on {var} must include an other branch"));
                        }
                        Ok(Node::Plural { var, cases })
                    }
                    "select" => {
                        let mut cases = Vec::new();
                        let mut has_other = false;
                        loop {
                            self.skip_ws();
                            if self.peek() == Some(b'}') {
                                self.pos += 1;
                                break;
                            }
                            let key = self.read_ident()?;
                            if key == "other" {
                                has_other = true;
                            }
                            self.skip_ws();
                            if self.peek() != Some(b'{') {
                                return Err(format!(
                                    "expected opening brace for select branch {key}"
                                ));
                            }
                            self.pos += 1;
                            let body = self.parse_nodes(true, false)?;
                            if self.peek() != Some(b'}') {
                                return Err(format!(
                                    "expected closing brace for select branch {key}"
                                ));
                            }
                            self.pos += 1;
                            cases.push((key, body));
                        }
                        if !has_other {
                            return Err(format!("select on {var} must include an other branch"));
                        }
                        Ok(Node::Select { var, cases })
                    }
                    other => Err(format!("unsupported ICU format type {other:?}")),
                }
            }
            _ => Err(format!("expected closing brace or comma after {var}")),
        }
    }
}

fn valid_var_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn parse_plural_selector(raw: &str) -> Result<PluralSelector, String> {
    if let Some(num) = raw.strip_prefix('=') {
        let val: i64 = num
            .parse()
            .map_err(|_| format!("invalid exact plural selector {raw:?}"))?;
        return Ok(PluralSelector::Exact(val));
    }
    match raw {
        "zero" => Ok(PluralSelector::Zero),
        "one" => Ok(PluralSelector::One),
        "two" => Ok(PluralSelector::Two),
        "few" => Ok(PluralSelector::Few),
        "many" => Ok(PluralSelector::Many),
        "other" => Ok(PluralSelector::Other),
        _ => Err(format!("unknown plural selector {raw:?}")),
    }
}
