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

use maka_skills::{
    Catalog, DiscoveredSkill, DiscoverySnapshot, HostCapabilities, Preference, Preferences,
    SkillLocation, parse,
};
use maka_skills::{SkillScope, SkillSource};
use std::{collections::BTreeMap, path::Path};

fn skill(id: &str, name: &str, body: &str) -> DiscoveredSkill {
    DiscoveredSkill {
        location: SkillLocation {
            reference: format!("project:maka:{id}"),
            id: id.into(),
            path: Path::new("/fixture/skills").join(id),
            discovery_root: "/fixture".into(),
            scope: SkillScope::Project,
            source: SkillSource::Maka,
            precedence: 0,
        },
        document: parse(&format!(
            "---\nname: '{}'\ndescription: work carefully\n---\n{body}",
            name.replace('\'', "''")
        ))
        .unwrap(),
        content_sha256: format!("sha256:{}", "0".repeat(64)),
        shadowed_by: None,
        resources: Default::default(),
    }
}

#[test]
fn execution_fingerprint_covers_frozen_content_and_resolution_inputs() {
    let mut discovery = DiscoverySnapshot {
        inventory: vec![skill("review", "Review", "old instructions")],
        rejected: Vec::new(),
        diagnostics: Vec::new(),
    };
    let mut preferences = Preferences::Available(BTreeMap::new());
    let mut host = HostCapabilities {
        tools: ["Read".into(), "Shell".into()].into(),
        capabilities: ["network".into(), "files".into()].into(),
    };
    let digest =
        |discovery: &DiscoverySnapshot, preferences: &Preferences, host: &HostCapabilities| {
            Catalog {
                discovery,
                preferences,
                host,
            }
            .fingerprint()
            .unwrap()
        };
    let original = digest(&discovery, &preferences, &host);
    host.tools = ["Shell".into(), "Read".into()].into();
    host.capabilities = ["files".into(), "network".into()].into();
    assert_eq!(digest(&discovery, &preferences, &host), original);
    assert_ne!(
        digest(&discovery, &Preferences::Unavailable, &host),
        original
    );

    // Discovery computes this digest over the complete SKILL.md bytes.
    discovery.inventory[0].document.body = "new instructions".into();
    discovery.inventory[0].content_sha256 =
        maka_agent_facts::artifact::content_digest(b"new SKILL.md bytes");
    let content = digest(&discovery, &preferences, &host);
    assert_ne!(
        content, original,
        "unchanged tool schemas cannot hide changed instructions"
    );
    discovery.inventory[0].location.path = "/moved/review".into();
    let moved = digest(&discovery, &preferences, &host);
    assert_ne!(
        moved, content,
        "relative references depend on the discovered path"
    );
    preferences = Preferences::Available(BTreeMap::from([(
        "project:maka:review".into(),
        Preference {
            enabled: false,
            pinned: false,
        },
    )]));
    let disabled = digest(&discovery, &preferences, &host);
    assert_ne!(disabled, moved);
    host.capabilities.remove("network");
    assert_ne!(digest(&discovery, &preferences, &host), disabled);
}
