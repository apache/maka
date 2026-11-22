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

use super::{form::*, form_decode::ensure};
type Result<T> = std::result::Result<T, &'static str>;

pub(super) fn default_value(spec: &FormFieldSpec) -> Option<FormValue> {
    match spec {
        FormFieldSpec::String { default, .. } | FormFieldSpec::SingleSelect { default, .. } => {
            default.clone().map(FormValue::String)
        }
        FormFieldSpec::Number { default, .. } | FormFieldSpec::Integer { default, .. } => {
            default.map(FormValue::Number)
        }
        FormFieldSpec::Boolean { default } => default.map(FormValue::Boolean),
        FormFieldSpec::MultiSelect { default, .. } => default.clone().map(FormValue::Strings),
    }
}
pub(super) fn valid(spec: &FormFieldSpec, value: &FormValue) -> bool {
    match (spec, value) {
        (
            FormFieldSpec::String {
                min_length,
                max_length,
                format,
                ..
            },
            FormValue::String(v),
        ) => {
            min_length.is_none_or(|n| v.chars().count() >= n)
                && max_length.is_none_or(|n| v.chars().count() <= n)
                && matches_format(v, *format)
        }
        (
            FormFieldSpec::Number {
                minimum, maximum, ..
            }
            | FormFieldSpec::Integer {
                minimum, maximum, ..
            },
            FormValue::Number(v),
        ) => {
            v.is_finite()
                && minimum.is_none_or(|n| *v >= n)
                && maximum.is_none_or(|n| *v <= n)
                && (!matches!(spec, FormFieldSpec::Integer { .. })
                    || (v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0))
        }
        (FormFieldSpec::Boolean { .. }, FormValue::Boolean(_)) => true,
        (FormFieldSpec::SingleSelect { options, .. }, FormValue::String(v)) => {
            options.iter().any(|o| &o.value == v)
        }
        (
            FormFieldSpec::MultiSelect {
                options,
                min_items,
                max_items,
                ..
            },
            FormValue::Strings(v),
        ) => {
            min_items.is_none_or(|n| v.len() >= n)
                && max_items.is_none_or(|n| v.len() <= n)
                && v.iter()
                    .enumerate()
                    .all(|(i, s)| !v[..i].contains(s) && options.iter().any(|o| &o.value == s))
        }
        _ => false,
    }
}
fn matches_format(value: &str, format: Option<FormFormat>) -> bool {
    let Some(format) = format else { return true };
    match format {
        FormFormat::Uri => url::Url::parse(value).is_ok(),
        FormFormat::Email => regress::Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
            .unwrap()
            .find(value)
            .is_some(),
        FormFormat::Date | FormFormat::DateTime => calendar(value, format == FormFormat::DateTime),
    }
}
fn calendar(value: &str, time: bool) -> bool {
    let pattern = if time {
        r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$"
    } else {
        r"^(\d{4})-(\d{2})-(\d{2})$"
    };
    let regex = regress::Regex::new(pattern).unwrap();
    let Some(m) = regex.find(value) else {
        return false;
    };
    let n = |index: usize| {
        m.captures[index]
            .clone()
            .and_then(|r| value[r].parse::<u32>().ok())
            .unwrap_or(0)
    };
    let (year, month, day) = (n(0), n(1), n(2));
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    (1..=12).contains(&month)
        && day >= 1
        && day <= days[(month - 1) as usize]
        && (!time || (n(3) <= 23 && n(4) <= 59 && n(5) <= 59 && n(6) <= 23 && n(7) <= 59))
}
/// Check that required fields have a possible answer without constructing one.
/// Declared lengths can be large; validation must not allocate that answer.
pub(super) fn admit(input: &FormInput) -> Result<()> {
    for field in input.fields.iter().filter(|field| field.required) {
        // Ordinary JavaScript object assignment cannot produce this own property.
        ensure(field.name != "__proto__")?;
        ensure(satisfiable(&field.spec))?;
    }
    Ok(())
}
fn satisfiable(spec: &FormFieldSpec) -> bool {
    if let Some(value) = default_value(spec) {
        return valid(spec, &value);
    }
    match spec {
        FormFieldSpec::String {
            min_length,
            max_length,
            format,
            ..
        } => {
            let min = min_length.unwrap_or(0);
            let max = max_length.unwrap_or(usize::MAX);
            match format {
                Some(FormFormat::Date) => min <= 10 && max >= 10,
                // A complete timestamp is 20 characters; fractional seconds
                // add a dot and at least one digit, and can extend it freely.
                Some(FormFormat::DateTime) => {
                    max >= min.max(20) && (min <= 20 || max >= min.max(22))
                }
                Some(FormFormat::Email) => max >= min.max(5),
                Some(FormFormat::Uri) => max >= min.max(2),
                None => min <= max,
            }
        }
        FormFieldSpec::Integer {
            minimum, maximum, ..
        } => {
            let lower = minimum
                .unwrap_or(-9_007_199_254_740_991.0)
                .max(-9_007_199_254_740_991.0)
                .ceil();
            let upper = maximum
                .unwrap_or(9_007_199_254_740_991.0)
                .min(9_007_199_254_740_991.0)
                .floor();
            lower <= upper
        }
        FormFieldSpec::Number { .. } | FormFieldSpec::Boolean { .. } => true,
        FormFieldSpec::SingleSelect { options, .. } => !options.is_empty(),
        FormFieldSpec::MultiSelect {
            options, min_items, ..
        } => min_items.unwrap_or(0) <= options.len(),
    }
}

#[cfg(test)]
mod tests {
    use crate::capability::FormInput;
    use serde_json::json;

    #[test]
    fn required_form_constraints_are_checked_without_allocating_declared_answers() {
        let input = |field| {
            json!({"message":"Complete request", "requester":{"name":"Tool"},
            "fields":[field]})
        };
        let large: FormInput = serde_json::from_value(input(json!({
            "kind":"string", "name":"answer", "label":"Answer", "required":true,
            "minLength":9_007_199_254_740_991_u64
        })))
        .unwrap();
        assert_eq!(large.fields.len(), 1);
        for field in [
            json!({"kind":"integer", "name":"n", "label":"N", "required":true,
                "minimum":0.1,"maximum":0.9}),
            json!({"kind":"string", "name":"day", "label":"Day", "required":true,
                "format":"date", "maxLength":9}),
            json!({"kind":"string", "name":"time", "label":"Time", "required":true,
                "format":"date-time", "minLength":21,"maxLength":21}),
            json!({"kind":"boolean", "name":"__proto__", "label":"Prototype", "required":true}),
        ] {
            assert!(serde_json::from_value::<FormInput>(input(field)).is_err());
        }
        let email: FormInput = serde_json::from_value(input(json!({
            "kind":"string", "name":"email", "label":"Email", "required":true,
            "format":"email", "minLength":5, "maxLength":5
        })))
        .unwrap();
        let answer: crate::capability::FormResult = serde_json::from_value(json!({
            "action":"accept", "values":{"email":"a@b.c"}
        }))
        .unwrap();
        answer.validate_for_fields(&email.fields).unwrap();
    }
}
