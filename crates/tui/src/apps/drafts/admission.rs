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

impl Instance {
    pub(super) fn draft_fits(&self, root: &str) -> bool {
        self.draft_checkpoint(root)
            .is_some_and(|(checkpoint, _)| checkpoint.capacity_bytes().is_some())
    }

    pub(in crate::apps) fn draft_checkpoint(
        &self,
        root: &str,
    ) -> Option<(saved::Checkpoint, bool)> {
        let review = self.review.as_ref()?;
        let mut candidate = Instance::new(Some(review.entry.clone()), self.address.clone());
        candidate.install(review.view.clone());
        candidate.drafts = review.values.clone();
        for conflict in &review.conflicts {
            if conflict.mine == Some(true) {
                candidate
                    .drafts
                    .insert(conflict.id.clone(), conflict.draft.clone());
            }
        }
        for (id, editor) in &mut candidate.editors {
            let initial = editor.text().to_owned();
            editor.clear_if_unchanged(&initial);
            let text = candidate.drafts.get(id).and_then(Value::as_str)?;
            editor.insert(text);
        }
        let kept = candidate.keeps();
        candidate
            .checkpoint(root, &self.address, None)
            .map(|checkpoint| (checkpoint, kept))
    }
}
