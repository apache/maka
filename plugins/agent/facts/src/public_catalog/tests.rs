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

#[test]
fn catalog_content_uses_decoded_keys_and_keeps_numeric_and_array_identity() {
    let original =
        PublicCatalogBody::from_json(r#"{"a":0,"\u0061":1,"items":[1,2]}"#.into()).unwrap();
    let equivalent = PublicCatalogBody::from_json(r#"{"items":[1,2],"a":1}"#.into()).unwrap();
    assert!(original.same_content(&equivalent).unwrap());
    for changed in [r#"{"a":1.0,"items":[1,2]}"#, r#"{"a":1,"items":[2,1]}"#] {
        assert!(
            !original
                .same_content(&PublicCatalogBody::from_json(changed.into()).unwrap())
                .unwrap()
        );
    }
}

#[test]
fn malformed_catalog_content_is_an_error_even_in_unknown_or_overwritten_fields() {
    for input in [
        r#"{"unknown":"\ud800","unknown":null}"#,
        "[1,]",
        "{} trailing",
    ] {
        assert!(
            PublicCatalogBody::from_json(input.into()).is_err(),
            "{input}"
        );
    }
    let malformed: &RawValue = serde_json::from_str(r#""\ud800""#).unwrap();
    let valid: &RawValue = serde_json::from_str(r#""valid""#).unwrap();
    assert!(equal(malformed, valid).is_err());
    assert!(equal(valid, malformed).is_err());
}
