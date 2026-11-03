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
use serde_json::json;

fn evaluation() -> Evaluation {
    serde_json::from_value(json!({"input":{"ticket":"charged twice","charges":[49,49]},"questions":{
        "duplicate":{"type":"predicate","instructions":"Is this a duplicate charge?"},
        "route":{"type":"choice","instructions":"Route this ticket","choices":[{"value":"billing"},{"value":"technical"}]},
        "urgency":{"type":"score","instructions":"Rate urgency","levels":[{"label":"low"},{"label":"medium"},{"label":"high"}]}
    }})).unwrap()
}
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

#[test]
fn openrouter_responses_preserve_answers_and_structured_legend() {
    let input = evaluation();
    let result = decode(
        Protocol::Jev,
        include_bytes!("fixtures/jev-openrouter.json"),
        &input,
    )
    .unwrap();
    assert_eq!(result.model, "typesafe/jev-1.14-20261014");
    assert_eq!(
        serde_json::to_value(&result).unwrap()["answers"]["duplicate"],
        json!({"type":"predicate","probability":0.98})
    );
    assert_eq!(result.usage.input_tokens, 423);
    let input = Evaluation {
        questions: BTreeMap::from([("urgency".into(), input.questions["urgency"].clone())]),
        ..input
    };
    let result = decode(
        Protocol::Jev,
        include_bytes!("fixtures/jev-structured.json"),
        &input,
    )
    .unwrap();
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(
        value["answers"]["urgency"]["legend"]["0"],
        json!({"severity":"low","when":"Routine question without payment impact"})
    );
    assert_eq!(
        value["answers"]["urgency"]["legend"]["2"],
        json!(["high", "Customer cannot use service"])
    );
    assert!(
        jsonschema::validator_for(&schemars::schema_for!(EvaluationResult).into())
            .unwrap()
            .is_valid(&value)
    );
}
#[test]
fn openai_mixed_answers_and_typed_choices_are_normalized() {
    let input = evaluation();
    let result = decode(
        Protocol::OpenAiDecisions,
        include_bytes!("fixtures/openai.json"),
        &input,
    )
    .unwrap();
    assert_eq!(result.model, "gpt-6-luna");
    assert_eq!(result.usage.input_tokens, 422);
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["answers"]["route"]["choice"], "billing");
    assert_eq!(
        value["answers"]["urgency"]["legend"],
        json!({"0":"low","1":"medium","2":"high"})
    );
    let input:Evaluation=serde_json::from_value(json!({"input":{},"questions":{
        "supported":{"type":"predicate","instructions":{}},
        "typed_value":{"type":"choice","instructions":"Choose boolean true","choices":[{"value":true},{"value":"true"}]}
    }})).unwrap();
    input.validate().unwrap();
    let result = decode(
        Protocol::OpenAiDecisions,
        include_bytes!("fixtures/openai-typed.json"),
        &input,
    )
    .unwrap();
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["answers"]["typed_value"]["choice"], true);
    assert_eq!(
        value["answers"]["typed_value"]["probabilities"][1]["value"],
        "true"
    );
    assert!(
        jsonschema::validator_for(&schemars::schema_for!(EvaluationResult).into())
            .unwrap()
            .is_valid(&value)
    );
    assert!(matches!(
        encode(Protocol::Jev, "jev-latest", &input),
        Err(Error::Unsupported(_))
    ));
}
#[test]
fn requests_preserve_json_and_reject_unsupported_protocol_features() {
    let mut input = evaluation();
    input.questions.insert(
        "check".into(),
        Question::Predicate {
            instructions: json!({"task":"check evidence"}),
            criteria: Some(BTreeMap::from([("true".into(), json!(["supported"]))])),
        },
    );
    let jev: Value =
        serde_json::from_slice(&encode(Protocol::Jev, "jev-latest", &input).unwrap()).unwrap();
    assert_eq!(jev["state"], input.input);
    assert_eq!(
        jev["questions"]["route"]["criteria"],
        json!({"billing":null,"technical":null})
    );
    let openai: Value =
        serde_json::from_slice(&encode(Protocol::OpenAiDecisions, "gpt-6-luna", &input).unwrap())
            .unwrap();
    assert_eq!(
        openai["input"][0]["content"][0],
        json!({"type":"input_json","data":input.input})
    );
    assert_eq!(
        openai["questions"][0]["instructions"][0]["data"]["criteria"],
        json!({"true":["supported"]})
    );
    if let Question::Score { levels, .. } = input.questions.get_mut("urgency").unwrap() {
        levels[0].description = Some(json!({"severity":"low"}));
    }
    assert!(matches!(
        encode(Protocol::OpenAiDecisions, "m", &input),
        Err(Error::Unsupported(_))
    ));
    let jev: Value = serde_json::from_slice(&encode(Protocol::Jev, "m", &input).unwrap()).unwrap();
    assert_eq!(
        jev["questions"]["urgency"]["criteria"][0],
        json!({"label":"low","description":{"severity":"low"}})
    );
    let mut input = evaluation();
    if let Question::Choice { choices, .. } = input.questions.get_mut("route").unwrap() {
        choices.truncate(1);
    }
    assert!(encode(Protocol::Jev, "m", &input).is_ok());
    assert!(matches!(
        encode(Protocol::OpenAiDecisions, "m", &input),
        Err(Error::Unsupported(_))
    ));
    let mut input = evaluation();
    let question = input.questions["duplicate"].clone();
    input.questions = (0..401)
        .map(|i| (i.to_string(), question.clone()))
        .collect();
    assert!(matches!(
        encode(Protocol::OpenAiDecisions, "m", &input),
        Err(Error::Unsupported(_))
    ));
}
#[test]
fn per_question_refusal_succeeds_but_invalid_or_missing_answers_fail() {
    let input = evaluation();
    let original: Value = serde_json::from_slice(include_bytes!("fixtures/openai.json")).unwrap();
    let mut refused = original.clone();
    refused["answers"][0] = json!({"type":"refusal","name":"duplicate"});
    let result = decode(Protocol::OpenAiDecisions, &bytes(&refused), &input).unwrap();
    assert!(matches!(result.answers["duplicate"], Answer::Refusal));
    assert!(matches!(result.answers["route"], Answer::Choice { .. }));
    let mut variants = Vec::new();
    let mut v = original.clone();
    v["answers"].as_array_mut().unwrap().pop();
    variants.push(v);
    let mut v = original.clone();
    v["answers"][1]["name"] = json!("duplicate");
    variants.push(v);
    let mut v = original.clone();
    v["answers"][0]["name"] = json!("unknown");
    variants.push(v);
    let mut v = original.clone();
    v["answers"][0]["probability"] = json!(1.1);
    variants.push(v);
    let mut v = original.clone();
    v["answers"][0]["probability"] = json!(null);
    variants.push(v);
    let mut v = original.clone();
    v["answers"][1]["probabilities"][1] = v["answers"][1]["probabilities"][0].clone();
    variants.push(v);
    let mut v = original.clone();
    v["answers"][2]["score"] = json!(0.0);
    variants.push(v);
    let mut v = original.clone();
    v["answers"][2]["probabilities"][0]["label"] = json!("wrong");
    variants.push(v);
    let mut v = original.clone();
    v["usage"]["input_tokens"] = json!(1_u64 << 53);
    variants.push(v);
    for v in variants {
        assert!(
            matches!(
                decode(Protocol::OpenAiDecisions, &bytes(&v), &input),
                Err(Error::Response)
            ),
            "{v}"
        );
    }
}
