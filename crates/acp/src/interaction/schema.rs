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

use agent_client_protocol::schema::v2 as acp;
use maka_runtime::{
    capability::{FormField, FormFieldSpec, FormFormat},
    interaction::InteractionQuestion,
};

pub(super) fn questions(questions: &[InteractionQuestion]) -> acp::ElicitationSchema {
    questions.iter().enumerate().fold(
        acp::ElicitationSchema::new(),
        |schema, (index, question)| {
            // The Host allows free-form answers as well as the displayed options.
            let choices = question
                .options
                .iter()
                .map(|option| match &option.description {
                    Some(description) => format!("{}: {description}", option.label),
                    None => option.label.clone(),
                })
                .collect::<Vec<_>>()
                .join("\n");
            schema.property(
                format!("question_{index}"),
                acp::StringPropertySchema::new()
                    .title(question.question.clone())
                    .description(format!("{choices}\nYou may also enter your own answer."))
                    .min_length(1)
                    .max_length(2048),
                false,
            )
        },
    )
}

pub(super) fn form(fields: &[FormField]) -> Result<acp::ElicitationSchema, crate::Error> {
    let mut schema = acp::ElicitationSchema::new();
    for field in fields {
        let property: acp::ElicitationPropertySchema = match &field.spec {
            FormFieldSpec::String {
                default,
                min_length,
                max_length,
                format,
            } => acp::StringPropertySchema::new()
                .title(field.label.clone())
                .description(field.description.clone())
                .default_value(default.clone())
                .min_length(min_length.map(u32::try_from).transpose()?)
                .max_length(max_length.map(u32::try_from).transpose()?)
                .format(format.map(|format| match format {
                    FormFormat::Email => acp::StringFormat::Email,
                    FormFormat::Uri => acp::StringFormat::Uri,
                    FormFormat::Date => acp::StringFormat::Date,
                    FormFormat::DateTime => acp::StringFormat::DateTime,
                }))
                .into(),
            FormFieldSpec::Number {
                default,
                minimum,
                maximum,
            } => acp::NumberPropertySchema::new()
                .title(field.label.clone())
                .description(field.description.clone())
                .default_value(*default)
                .minimum(*minimum)
                .maximum(*maximum)
                .into(),
            FormFieldSpec::Integer {
                default,
                minimum,
                maximum,
            } => acp::IntegerPropertySchema::new()
                .title(field.label.clone())
                .description(field.description.clone())
                .default_value(integer(*default)?)
                .minimum(integer(*minimum)?)
                .maximum(integer(*maximum)?)
                .into(),
            FormFieldSpec::Boolean { default } => acp::BooleanPropertySchema::new()
                .title(field.label.clone())
                .description(field.description.clone())
                .default_value(*default)
                .into(),
            FormFieldSpec::SingleSelect { options, default } => acp::StringPropertySchema::new()
                .title(field.label.clone())
                .description(field.description.clone())
                .default_value(default.clone())
                .one_of(
                    options
                        .iter()
                        .map(|option| acp::EnumOption::new(&option.value, &option.label))
                        .collect::<Vec<_>>(),
                )
                .into(),
            FormFieldSpec::MultiSelect {
                options,
                default,
                min_items,
                max_items,
            } => acp::MultiSelectPropertySchema::titled(
                options
                    .iter()
                    .map(|option| acp::EnumOption::new(&option.value, &option.label))
                    .collect(),
            )
            .title(field.label.clone())
            .description(field.description.clone())
            .default_value(default.clone())
            .min_items(min_items.map(u64::try_from).transpose()?)
            .max_items(max_items.map(u64::try_from).transpose()?)
            .into(),
        };
        schema = schema.property(field.name.clone(), property, field.required);
    }
    Ok(schema)
}

fn integer(value: Option<f64>) -> Result<Option<i64>, crate::Error> {
    value
        .map(|value| {
            if !value.is_finite() || value.fract() != 0.0 || value.abs() > 9_007_199_254_740_991.0 {
                Err("Integer form constraint is outside ACP's exact numeric range".into())
            } else {
                Ok(value as i64)
            }
        })
        .transpose()
}
