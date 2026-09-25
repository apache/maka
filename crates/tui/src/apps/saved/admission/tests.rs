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

use super::*;
use maka_plugins::{
    authorization::{Capability, Request, Target},
    terminal_ui::view::{Reply, Tone, build::*},
};

#[test]
fn short_field_null_anchors_cannot_cross_the_encoded_checkpoint_boundary() {
    let root = "a".repeat(64);
    let app = crate::apps::tests::app();
    let entry = crate::apps::tests::instance(&app).entry.clone().unwrap();
    let key = crate::apps::tests::key().at(serde_json::json!("r".repeat(8000)));
    let mut view = crate::apps::tests::form();
    view.fields = (0..9)
        .map(|index| {
            line(
                format!("field{index}"),
                if index < 4 {
                    "a".repeat(13300)
                } else {
                    String::new()
                },
                16384,
            )
        })
        .collect();
    view.actions[0].fields = view.fields.iter().map(|field| field.id.clone()).collect();
    view.actions[0].recovery = Some(serde_json::json!("q".repeat(8000)));
    view.root = text("body", "", Tone::Normal);
    let padding =
        maka_plugins::terminal_ui::view::MAX_BYTES - 64 - serde_json::to_vec(&view).unwrap().len();
    view.root = text("body", "p".repeat(padding), Tone::Normal);
    view.validate().unwrap();
    let mut instance = Instance::new(Some(entry), key.clone());
    instance.install(view);
    instance.submit("save", "en");
    let mut pending = instance
        .frozen_pending(instance.pending.as_ref().unwrap())
        .unwrap();
    pending.input.validate().unwrap();
    pending.proposal = Some(Request {
        operation_id: uuid::Uuid::new_v4(),
        title: "Files".into(),
        target: Target::Directory { path: "/".into() },
        capabilities: [Capability::ReadFiles].into(),
    });
    for overflow in [0, 1] {
        let mut checkpoint = instance.checkpoint(&root, &key, Some(&pending)).unwrap();
        let bytes = serde_json::to_vec(&checkpoint).unwrap();
        let mut maximum: Checkpoint = serde_json::from_slice(&bytes).unwrap();
        for (id, cursor) in &mut maximum.cursors {
            *cursor = Cursor::largest(maximum.drafts[id].as_str().unwrap());
        }
        let extra = MAX_BYTES + overflow - serde_json::to_vec(&maximum).unwrap().len();
        let proposal = checkpoint
            .pending
            .as_mut()
            .unwrap()
            .proposal
            .as_mut()
            .unwrap();
        let Target::Directory { path } = &mut proposal.target else {
            unreachable!()
        };
        path.push_str(&"\"".repeat(extra / 2));
        if !extra.is_multiple_of(2) {
            path.push('a');
        }
        proposal.validate().unwrap();
        Reply::Consent {
            request: proposal.clone(),
        }
        .validate()
        .unwrap();
        checkpoint.validate(&root).unwrap();
        let bytes = serde_json::to_vec(&checkpoint).unwrap();
        let mut maximum: Checkpoint = serde_json::from_slice(&bytes).unwrap();
        for (id, cursor) in &mut maximum.cursors {
            *cursor = Cursor::largest(maximum.drafts[id].as_str().unwrap());
        }
        assert_eq!(
            serde_json::to_vec(&maximum).unwrap().len(),
            MAX_BYTES + overflow
        );
        assert_eq!(checkpoint.admit_cursors(), overflow == 0);
    }
}
