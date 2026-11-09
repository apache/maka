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

//! Stable execution correlation supplied by the admitted producer, never authority.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ExecutionCorrelation(String);
impl ExecutionCorrelation {
    pub fn new(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        if value.is_empty() {
            Err("execution correlation must not be empty")
        } else {
            Ok(Self(value))
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for ExecutionCorrelation {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}
impl From<ExecutionCorrelation> for String {
    fn from(value: ExecutionCorrelation) -> Self {
        value.0
    }
}

#[cfg(test)]
mod tests {
    use super::ExecutionCorrelation;

    #[test]
    fn scalar_round_trip_preserves_the_original_value_and_rejects_empty_input() {
        let original = ExecutionCorrelation::new("execution-a").unwrap();
        assert_eq!(serde_json::to_string(&original).unwrap(), "\"execution-a\"");
        let restored: ExecutionCorrelation = serde_json::from_str("\"execution-a\"").unwrap();
        assert_eq!(restored, original);
        assert!(ExecutionCorrelation::new("").is_err());
        assert!(ExecutionCorrelation::try_from(String::new()).is_err());
        assert!(serde_json::from_str::<ExecutionCorrelation>("\"\"").is_err());
    }
}
