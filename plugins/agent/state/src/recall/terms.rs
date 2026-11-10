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
use std::collections::HashSet;
const GRAM_BITS: u32 = 21;

fn append_token(result: &mut String, key: u64) {
    result.push('g');
    for shift in [2 * GRAM_BITS, GRAM_BITS, 0] {
        let scalar = (key >> shift) & ((1 << GRAM_BITS) - 1);
        if scalar == 0 {
            continue;
        }
        let mut value = scalar - 1;
        let mut encoded = [b'0'; 4];
        for digit in encoded.iter_mut().rev() {
            *digit = b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize];
            value /= 36;
        }
        for byte in encoded {
            result.push(char::from(byte));
        }
    }
}

fn gram_keys(text: &str, minimum: u32) -> Vec<u64> {
    let mut keys = {
        let mut unique = HashSet::<u64>::new();
        let mut window = 0;
        let mut available = 0;
        for scalar in text.chars() {
            // Three nonzero 21-bit lanes fit in 63 bits, including U+0000 as 1.
            window = ((window << GRAM_BITS) | (u64::from(u32::from(scalar)) + 1)) & (u64::MAX >> 1);
            available = (available + 1).min(3);
            for size in minimum..=available {
                unique.insert(window & ((1 << (size * GRAM_BITS)) - 1));
            }
        }
        unique.into_iter().collect::<Vec<_>>()
    };
    keys.sort_unstable();
    keys
}

pub(crate) fn grams(text: &str) -> String {
    let keys = gram_keys(text, 1);
    let mut result = String::new();
    for key in keys {
        if !result.is_empty() {
            result.push(' ');
        }
        append_token(&mut result, key);
    }
    result
}

pub(crate) fn expression(terms: &[String]) -> String {
    terms
        .iter()
        .map(|term| {
            let mut tokens = String::new();
            for key in gram_keys(term, term.chars().count().min(3) as u32) {
                if !tokens.is_empty() {
                    tokens.push_str(" AND ");
                }
                append_token(&mut tokens, key);
            }
            format!("({tokens})")
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}
