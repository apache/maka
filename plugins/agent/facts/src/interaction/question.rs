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

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InteractionQuestion {
    #[schemars(length(min = 1))]
    pub question: String,
    #[schemars(length(min = 2, max = 3))]
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QuestionOption {
    #[schemars(length(min = 1))]
    pub label: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "description"
    )]
    #[schemars(with = "String", length(min = 1))]
    pub description: Option<String>,
}

// Missing descriptions are allowed; explicit null is not.
fn description<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}

fn required_text(value: &str) -> Result<(), &'static str> {
    if value.is_empty() {
        return Err("Invalid question text length");
    }
    Ok(())
}

pub(super) fn validate_questions(questions: &[InteractionQuestion]) -> Result<(), &'static str> {
    if !(1..=3).contains(&questions.len()) {
        return Err("Invalid question count");
    }
    for question in questions {
        required_text(&question.question)?;
        if !(2..=3).contains(&question.options.len()) {
            return Err("Invalid question option count");
        }
        let mut labels = HashSet::new();
        for option in &question.options {
            required_text(&option.label)?;
            if let Some(description) = &option.description {
                required_text(description)?;
            }
            if !labels.insert(&option.label) {
                return Err("Duplicate question option label");
            }
        }
    }
    Ok(())
}

pub(super) fn validate_answers(answers: &[Option<String>]) -> Result<(), &'static str> {
    if !(1..=3).contains(&answers.len()) {
        return Err("Invalid question answer count");
    }
    for answer in answers.iter().flatten() {
        required_text(answer)?;
    }
    Ok(())
}

pub(super) fn validate_answer_count(
    answers: &[Option<String>],
    questions: &[InteractionQuestion],
) -> Result<(), &'static str> {
    if answers.len() != questions.len() {
        return Err("Question answer count does not match request");
    }
    Ok(())
}
