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

use super::{Compiled, Policy, Rule, Scope};
use crate::Error;
use std::collections::BTreeSet;

impl Compiled {
    /// Only additional positive grants may widen a policy. Existing deny globs
    /// remain hard exclusions; Host-protected path rules are applied separately.
    pub(crate) fn with_grants(&self, grants: &Self) -> Result<Self, Error> {
        debug_assert!(grants.policy.deny_globs.is_empty());
        let boundaries: BTreeSet<_> = self
            .policy
            .rules
            .iter()
            .chain(&grants.policy.rules)
            .map(|rule| (rule.path.clone(), rule.scope))
            .collect();
        Policy {
            default: self.policy.default.union(grants.policy.default),
            rules: boundaries
                .into_iter()
                .map(|(path, scope)| Rule {
                    access: self
                        .path_access(&path, scope == Scope::Exact)
                        .union(grants.path_access(&path, scope == Scope::Exact)),
                    path,
                    scope,
                })
                .collect(),
            deny_globs: self.policy.deny_globs.clone(),
        }
        .compile()
    }

    /// Inclusion of path rules only. Callers must account for deny globs.
    pub(crate) fn contains_paths(&self, other: &Self) -> bool {
        self.policy.default.intersect(other.policy.default) == other.policy.default
            && self
                .policy
                .rules
                .iter()
                .chain(&other.policy.rules)
                .all(|rule| {
                    [false, true].into_iter().all(|exact| {
                        let requested = other.path_access(&rule.path, exact);
                        self.path_access(&rule.path, exact).intersect(requested) == requested
                    })
                })
    }

    /// Exact pointwise intersection of two materialized policies. Do not compare
    /// a requested spelling against a different symlink target or another host.
    /// All deny globs survive. Failure never falls back to either wider input.
    pub fn intersect(&self, other: &Self) -> Result<Self, Error> {
        let boundaries: BTreeSet<_> = self
            .policy
            .rules
            .iter()
            .chain(&other.policy.rules)
            .map(|rule| (rule.path.clone(), rule.scope))
            .collect();
        let rules = boundaries
            .into_iter()
            .map(|(path, scope)| {
                let exact = scope == Scope::Exact;
                let access = self
                    .path_access(&path, exact)
                    .intersect(other.path_access(&path, exact));
                Rule {
                    path,
                    scope,
                    access,
                }
            })
            .collect();
        let deny_globs = self
            .policy
            .deny_globs
            .iter()
            .chain(&other.policy.deny_globs)
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        Policy {
            default: self.policy.default.intersect(other.policy.default),
            rules,
            deny_globs,
        }
        .compile()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filesystem::Access;
    use std::path::Path;

    #[test]
    fn intersection_is_exact_across_nested_overrides_and_denials() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let paths = [
            "",
            "a",
            "a/item",
            "a/b",
            "a/b/item",
            "a/b/secret",
            "sibling",
        ];
        let accesses = [Access::Read, Access::Write, Access::Deny];
        // All parent/child combinations, both orders, with an exact denial and a
        // global deny pattern: a broad grant must never erase a narrow boundary.
        for default in accesses {
            for parent in accesses {
                for child in accesses {
                    let left = Policy {
                        default,
                        rules: vec![
                            Rule::subtree(root.join("a"), parent),
                            Rule::subtree(root.join("a/b"), child),
                            Rule::exact(root.join("a/b/item"), Access::Read),
                        ],
                        deny_globs: vec![format!("{}/**/secret", root.display())],
                    }
                    .compile()
                    .unwrap();
                    for right_access in accesses {
                        let right = Policy {
                            default: Access::Write,
                            rules: vec![
                                Rule::subtree(root.join("a/b"), right_access),
                                Rule::exact(root.join("a/item"), Access::Deny),
                            ],
                            deny_globs: vec![],
                        }
                        .compile()
                        .unwrap();
                        let result = left.intersect(&right).unwrap();
                        let reversed = right.intersect(&left).unwrap();
                        let sandbox = |policy: &Compiled| crate::Sandbox::Managed {
                            filesystem: policy.policy().clone(),
                            network: crate::Network::Denied,
                        };
                        assert!(sandbox(&left).contains(&sandbox(&result)).unwrap());
                        assert!(sandbox(&right).contains(&sandbox(&result)).unwrap());
                        for path in paths.map(|p| root.join(p)) {
                            let expected = left.access(&path).intersect(right.access(&path));
                            assert_eq!(result.access(&path), expected, "{path:?}");
                            assert_eq!(reversed.access(&path), expected, "{path:?}");
                        }
                        assert_eq!(result.access(Path::new("relative")), Access::Deny);
                    }
                }
            }
        }
    }

    #[test]
    fn duplicate_rule_order_and_unknown_wire_values_cannot_widen_authority() {
        let temp = tempfile::tempdir().unwrap();
        let rules = vec![
            Rule::subtree(temp.path(), Access::Deny),
            Rule::subtree(temp.path(), Access::Write),
            Rule::subtree(temp.path(), Access::Read),
        ];
        for rules in [rules.clone(), rules.into_iter().rev().collect()] {
            let compiled = Policy {
                default: Access::Write,
                rules,
                deny_globs: vec![],
            }
            .compile()
            .unwrap();
            assert_eq!(compiled.access(&temp.path().join("child")), Access::Deny);
        }
        let value = serde_json::json!({"default":"write","rules":[],"denyGlobs":[],"typo":[]});
        assert!(serde_json::from_value::<Policy>(value).is_err());
        assert!(serde_json::from_str::<Access>("\"none\"").is_err());
        #[cfg(target_os = "macos")]
        {
            let denied = temp.path().join("é//secret");
            let alias = temp.path().join("e\u{301}/secret");
            let compiled = Policy {
                default: Access::Write,
                rules: vec![
                    Rule::exact(denied.clone(), Access::Deny),
                    Rule::exact(alias.clone(), Access::Write),
                ],
                deny_globs: vec![],
            }
            .compile()
            .unwrap();
            assert_eq!(compiled.policy().rules.len(), 1);
            assert_eq!(compiled.access(&denied), Access::Deny);
            assert_eq!(compiled.access(&alias), Access::Deny);
        }
    }
}
