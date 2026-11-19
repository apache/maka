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
use maka_agent_facts::interaction::*;
use serde_json::json;

fn questions() -> serde_json::Value {
    json!([{"question":"Line\n","options":[{"label":"Yes"},{"label":"No"}]}])
}

#[test]
fn publication_projects_but_canonical_reads_preserve_and_collisions_fail() {
    let raw = json!({"kind":"question","toolUseId":"tool","questions":questions()});
    assert_eq!(
        serde_json::to_value(decode_request(&raw).unwrap()).unwrap(),
        raw
    );
    let projected = project_question_request("tool", &questions()).unwrap();
    assert_eq!(
        serde_json::to_value(projected).unwrap()["questions"][0]["question"],
        "Line\\u{A}"
    );
    let collision = json!([{"question":"Choose","options":[{"label":"\n"},{"label":"\\u{A}"}]}]);
    assert!(project_question_request("tool", &collision).is_err());
    let expansion = json!([{"question":"\n".repeat(1024),"options":[{"label":"A"},{"label":"B"}]}]);
    assert_eq!(
        serde_json::to_value(project_question_request("tool", &expansion).unwrap()).unwrap()["questions"]
            [0]["question"],
        "\\u{A}".repeat(1024)
    );
    let null =
        json!([{"question":"Choose","options":[{"label":"A","description":null},{"label":"B"}]}]);
    assert!(project_question_request("tool", &null).is_err());
}

#[test]
fn answers_bind_count_not_labels_and_public_construction_preserves_semantics() {
    let request = project_question_request("tool", &questions()).unwrap();
    for answer in [
        None,
        Some("free text".into()),
        Some(" ".into()),
        Some("😀".repeat(513)),
    ] {
        let answer = InteractionAnswer::Question {
            answers: vec![answer],
        };
        answer.validate_for_request(&request).unwrap();
        let outcome = answer.clone().into_outcome(2);
        outcome.validate_for_request(&request).unwrap();
        assert!(answer.matches_outcome(&outcome));
        assert_eq!(outcome.committed_at(), 2);
        assert!(
            !answer.matches_outcome(&InteractionOutcome::QuestionAnswer {
                answers: vec![Some("different".into())],
                committed_at: 2
            })
        );
    }
    for answers in [vec![], vec![Some(String::new())], vec![None, None]] {
        let answer = InteractionAnswer::Question { answers };
        assert!(answer.validate_for_request(&request).is_err());
        assert!(
            answer
                .into_outcome(2)
                .validate_for_request(&request)
                .is_err()
        );
    }
    // A question nobody answered in time is closed by the Host.
    assert!(
        InteractionOutcome::Closure {
            reason: ClosureReason::TimedOut,
            committed_at: 2
        }
        .validate_for_request(&request)
        .is_ok()
    );
    let mut invalid = request;
    if let InteractionRequest::Question { questions, .. } = &mut invalid {
        questions[0].options[0].label = questions[0].options[1].label.clone();
    }
    assert!(invalid.validate().is_err());
}

#[test]
fn complete_question_answer_survives_outcome_timestamp() {
    let answer = InteractionAnswer::Question {
        answers: vec![Some("\n".repeat(1355)); 3],
    };
    answer.validate().unwrap();
    let outcome = answer.into_outcome(MAX_SAFE_INTEGER);
    outcome.validate().unwrap();
    assert_eq!(outcome.committed_at(), MAX_SAFE_INTEGER);
    assert_eq!(
        serde_json::to_value(outcome).unwrap()["answers"],
        json!(vec![Some("\n".repeat(1355)); 3])
    );
}
