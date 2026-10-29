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

use super::Answer;
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor, value::MapAccessDeserializer},
};
use std::{collections::BTreeMap, fmt};

impl<'de> Deserialize<'de> for Answer {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct AnswerVisitor;
        impl<'de> Visitor<'de> for AnswerVisitor {
            type Value = Answer;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a Jev answer object")
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                AnswerWire::deserialize(MapAccessDeserializer::new(map))?
                    .try_into()
                    .map_err(serde::de::Error::custom)
            }
        }
        deserializer.deserialize_map(AnswerVisitor)
    }
}

// Read typed numbers directly: internally tagged Serde buffering turns JSON
// arbitrary_precision decimals into private maps before f64 can decode them.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnswerWire {
    #[serde(rename = "type")]
    kind: Kind,
    #[serde(default, deserialize_with = "present")]
    noul: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    choice: Option<String>,
    #[serde(default, deserialize_with = "present")]
    score: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    confidence: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    probabilities: Option<BTreeMap<String, f64>>,
    #[serde(default, deserialize_with = "present")]
    legend: Option<BTreeMap<String, String>>,
}

enum Kind {
    Noul,
    Choice,
    Score,
}

impl<'de> Deserialize<'de> for Kind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let kind = String::deserialize(deserializer)?;
        match kind.as_str() {
            "noul" => Ok(Self::Noul),
            "choice" => Ok(Self::Choice),
            "score" => Ok(Self::Score),
            _ => Err(serde::de::Error::unknown_variant(
                &kind,
                &["noul", "choice", "score"],
            )),
        }
    }
}

// Absent fields select the variant; explicit null is never a valid field value.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl TryFrom<AnswerWire> for Answer {
    type Error = &'static str;

    fn try_from(wire: AnswerWire) -> Result<Self, Self::Error> {
        match wire {
            AnswerWire {
                kind: Kind::Noul,
                noul: Some(noul),
                choice: None,
                score: None,
                confidence: None,
                probabilities: None,
                legend: None,
            } => Ok(Self::Noul { noul }),
            AnswerWire {
                kind: Kind::Choice,
                noul: None,
                choice: Some(choice),
                score: None,
                confidence: Some(confidence),
                probabilities: Some(probabilities),
                legend: None,
            } => Ok(Self::Choice {
                choice,
                confidence,
                probabilities,
            }),
            AnswerWire {
                kind: Kind::Score,
                noul: None,
                choice: None,
                score: Some(score),
                confidence: Some(confidence),
                probabilities: Some(probabilities),
                legend: Some(legend),
            } => Ok(Self::Score {
                score,
                confidence,
                probabilities,
                legend,
            }),
            _ => Err("fields do not match the Jev answer type"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn answer_schema_and_decoder_accept_json_numbers_and_any_tag_position() {
        let schema: Value = schemars::schema_for!(Answer).into();
        let validator = jsonschema::validator_for(&schema).unwrap();
        for (wire, expected) in [
            (
                r#"{"type":"noul","noul":0.7500}"#,
                json!({"type":"noul","noul":0.75}),
            ),
            (
                r#"{"noul":7.5e-1,"type":"noul"}"#,
                json!({"type":"noul","noul":0.75}),
            ),
            (
                r#"{"noul":0,"type":"noul"}"#,
                json!({"type":"noul","noul":0.0}),
            ),
            (
                r#"{"type":"noul","noul":-0.0}"#,
                json!({"type":"noul","noul":-0.0}),
            ),
            (
                r#"{"choice":"yes","confidence":7.5E-1,"probabilities":{"yes":1e0,"no":0.000},"type":"choice"}"#,
                json!({"type":"choice","choice":"yes","confidence":0.75,"probabilities":{"yes":1.0,"no":0.0}}),
            ),
            (
                r#"{"score":1.00,"confidence":0.7500,"type":"score","probabilities":{"0":0e0,"1":1.000},"legend":{"0":"low","1":"high"}}"#,
                json!({"type":"score","score":1.0,"confidence":0.75,"probabilities":{"0":0.0,"1":1.0},"legend":{"0":"low","1":"high"}}),
            ),
        ] {
            assert!(
                validator.is_valid(&expected),
                "schema rejects answer: {wire}"
            );
            let answer: Answer = serde_json::from_str(wire).unwrap();
            assert_eq!(serde_json::to_value(answer).unwrap(), expected, "{wire}");
        }
    }

    #[test]
    fn answer_wire_rejects_wrong_fields_duplicates_null_and_non_numbers() {
        for wire in [
            r#"null"#,
            r#"[]"#,
            r#"["noul",0.75]"#,
            r#"["noul",0.75,null,null,null,null,null]"#,
            r#"{}"#,
            r#"{"type":"unknown","noul":0.75}"#,
            r#"{"type":null,"noul":0.75}"#,
            r#"{"type":{"noul":null},"noul":0.75}"#,
            r#"{"type":true,"noul":0.75}"#,
            r#"{"type":"noul"}"#,
            r#"{"noul":0.75}"#,
            r#"{"type":"noul","noul":null}"#,
            r#"{"type":"noul","noul":"0.75"}"#,
            r#"{"type":"noul","noul":true}"#,
            r#"{"type":"noul","noul":{"$serde_json::private::Number":"0.75"}}"#,
            r#"{"type":"noul","noul":1e400}"#,
            r#"{"type":"noul","noul":NaN}"#,
            r#"{"type":"noul","noul":0.75,"extra":0}"#,
            r#"{"type":"noul","noul":0.75,"confidence":0.5}"#,
            r#"{"type":"noul","noul":0.75,"choice":null}"#,
            r#"{"type":"noul","noul":0.75,"noul":0.75}"#,
            r#"{"type":"noul","noul":null,"noul":0.75}"#,
            r#"{"type":"noul","noul":0.75,"type":"noul"}"#,
            r#"{"type":"choice","choice":"yes","confidence":0.5}"#,
            r#"{"type":"choice","choice":null,"confidence":0.5,"probabilities":{"yes":1}}"#,
            r#"{"type":"choice","choice":"yes","confidence":null,"probabilities":{"yes":1}}"#,
            r#"{"type":"choice","choice":"yes","confidence":"0.5","probabilities":{"yes":1}}"#,
            r#"{"type":"choice","choice":"yes","confidence":0.5,"probabilities":null}"#,
            r#"{"type":"choice","choice":"yes","confidence":0.5,"probabilities":{"yes":"1"}}"#,
            r#"{"type":"choice","choice":"yes","confidence":0.5,"probabilities":{"yes":{"$serde_json::private::Number":"1"}}}"#,
            r#"{"type":"choice","choice":"yes","confidence":0.5,"probabilities":{"yes":1},"score":0}"#,
            r#"{"type":"score","score":1,"confidence":0.5,"probabilities":{"1":1}}"#,
            r#"{"type":"score","score":null,"confidence":0.5,"probabilities":{"1":1},"legend":{"1":"high"}}"#,
            r#"{"type":"score","score":"1","confidence":0.5,"probabilities":{"1":1},"legend":{"1":"high"}}"#,
            r#"{"type":"score","score":1,"confidence":0.5,"probabilities":{"1":1},"legend":null}"#,
            r#"{"type":"score","score":1,"confidence":0.5,"probabilities":{"1":1},"legend":{"1":"high"},"choice":"yes"}"#,
        ] {
            assert!(serde_json::from_str::<Answer>(wire).is_err(), "{wire}");
        }
    }

    #[test]
    fn answer_schema_rejects_missing_mixed_and_mistyped_variant_fields() {
        let schema: Value = schemars::schema_for!(Answer).into();
        let validator = jsonschema::validator_for(&schema).unwrap();
        for input in [
            json!({"type":"noul","noul":0.75,"confidence":0.5}),
            json!({"type":"choice","choice":"yes","confidence":0.5}),
            json!({"type":"score","score":1,"confidence":0.5,"probabilities":{"1":"1"},"legend":{"1":"high"}}),
        ] {
            assert!(
                !validator.is_valid(&input),
                "schema accepts invalid answer: {input}"
            );
        }
    }
}
