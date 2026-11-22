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

/// Host-prepared adapter input, not provider tokenization or HTTP wire bytes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedContextBreakdown {
    pub system: ContextBucket,
    pub user: ContextBucket,
    pub assistant: ContextBucket,
    /// Messages with the tool role; assistant-embedded results stay in assistant.
    pub tool: ContextBucket,
    pub tool_schemas: ContextBucket,
    pub counts: ContextCounts,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextBucket {
    /// UTF-8 text and compact JSON payload bytes counted by the Host heuristic.
    /// Excludes file encodings, message metadata, request-level provider options
    /// and synthetic framing overhead. Tool definitions are counted in full.
    #[schemars(range(max = 9_007_199_254_740_991_u64))]
    pub content_bytes: u64,
    /// Heuristic: separately rounded text/JSON bytes / 3, plus message/tool
    /// framing and 1024 per media part. Never provider-measured tokens.
    #[schemars(range(max = 9_007_199_254_740_991_u64))]
    pub estimated_tokens: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCounts {
    #[schemars(range(max = 9_007_199_254_740_991_u64))]
    pub messages: u64,
    #[schemars(range(max = 9_007_199_254_740_991_u64))]
    pub media: u64,
    #[schemars(range(max = 9_007_199_254_740_991_u64))]
    pub tool_calls: u64,
    #[schemars(range(max = 9_007_199_254_740_991_u64))]
    /// Result parts across both tool and assistant roles.
    pub tool_results: u64,
    #[schemars(range(max = 9_007_199_254_740_991_u64))]
    pub tools: u64,
}

impl PreparedContextBreakdown {
    /// Combine already-rounded fragments without rounding their byte totals again.
    pub fn accumulate(&mut self, other: &Self) {
        fn add(left: &mut ContextBucket, right: &ContextBucket) {
            left.content_bytes = left.content_bytes.saturating_add(right.content_bytes);
            left.estimated_tokens = left.estimated_tokens.saturating_add(right.estimated_tokens);
        }
        add(&mut self.system, &other.system);
        add(&mut self.user, &other.user);
        add(&mut self.assistant, &other.assistant);
        add(&mut self.tool, &other.tool);
        add(&mut self.tool_schemas, &other.tool_schemas);
        self.counts.messages = self.counts.messages.saturating_add(other.counts.messages);
        self.counts.media = self.counts.media.saturating_add(other.counts.media);
        self.counts.tool_calls = self
            .counts
            .tool_calls
            .saturating_add(other.counts.tool_calls);
        self.counts.tool_results = self
            .counts
            .tool_results
            .saturating_add(other.counts.tool_results);
        self.counts.tools = self.counts.tools.saturating_add(other.counts.tools);
    }

    fn buckets(&self) -> [&ContextBucket; 5] {
        [
            &self.system,
            &self.user,
            &self.assistant,
            &self.tool,
            &self.tool_schemas,
        ]
    }

    pub fn estimated_tokens(&self) -> u64 {
        self.buckets()
            .into_iter()
            .fold(0, |sum, bucket| sum.saturating_add(bucket.estimated_tokens))
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        const MAX: u64 = 9_007_199_254_740_991;
        let mut bytes = 0_u64;
        let mut tokens = 0_u64;
        for bucket in self.buckets() {
            bytes = bytes
                .checked_add(bucket.content_bytes)
                .filter(|sum| *sum <= MAX)
                .ok_or("invalid prepared context breakdown")?;
            tokens = tokens
                .checked_add(bucket.estimated_tokens)
                .filter(|sum| *sum <= MAX)
                .ok_or("invalid prepared context breakdown")?;
        }
        if [
            self.counts.messages,
            self.counts.media,
            self.counts.tool_calls,
            self.counts.tool_results,
            self.counts.tools,
        ]
        .into_iter()
        .any(|count| count > MAX)
        {
            return Err("invalid prepared context breakdown");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_individual_counters_and_aggregate_javascript_integer_bounds() {
        const MAX: u64 = 9_007_199_254_740_991;
        let mut report = PreparedContextBreakdown::default();
        report.user.content_bytes = MAX;
        report.user.estimated_tokens = MAX;
        assert!(report.validate().is_ok());
        report.tool.content_bytes = 1;
        assert!(report.validate().is_err());
        report.tool.content_bytes = 0;
        report.tool.estimated_tokens = 1;
        assert!(report.validate().is_err());
        report.tool.estimated_tokens = 0;
        report.counts.media = MAX + 1;
        assert!(report.validate().is_err());
        report.counts.media = 0;
        report.user.estimated_tokens = u64::MAX;
        report.tool.estimated_tokens = 1;
        assert!(report.validate().is_err());
    }
}
