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

use super::Wire;

// Matches core/model-metadata.ts openAiAdapterApiProtocol; available wires still
// constrain this preference, so compatible Chat-only providers stay on Chat.
pub(super) fn resolve(provider: &str, model: &str) -> Wire {
    let lower = model.to_ascii_lowercase();
    if lower.starts_with("gpt-5")
        || lower.starts_with("gpt-6")
        || (provider == "deepseek"
            && matches!(
                lower.as_str(),
                "deepseek-flash" | "deepseek-v4-flash" | "deepseek-v4-pro"
            ))
        || (provider == "opencode-go" && model == "muse-spark-1.2-contributor")
        || (matches!(provider, "alibaba-token-plan" | "alibaba-token-plan-cn")
            && model == "qwen3.8-max")
        || (matches!(provider, "xai" | "xai-oauth") && model == "grok-4.5")
    {
        Wire::OpenaiResponses
    } else {
        Wire::OpenaiChatCompletions
    }
}
