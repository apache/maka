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

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Error, Schema};

/// Shared immutable UTF-8 resource contract. Content schemas are checked by
/// consumers; a resource name never confers access to its bytes.
pub fn text_resource_type() -> ResourceType {
    ResourceType {
        name: "maka.text.utf8".into(),
        version: 1,
    }
}

/// Shared immutable binary bytes. Consumers validate their content separately.
pub fn binary_resource_type() -> ResourceType {
    ResourceType {
        name: "maka.bytes".into(),
        version: 1,
    }
}

/// Public contract definitions are package data, not live registration records.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contract {
    pub name: String,
    pub version: u32,
    pub transport: Transport,
    pub interface: Interface,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Local,
    Remote,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Interface {
    Service {
        methods: BTreeMap<String, Method>,
    },
    Component {
        props: Schema,
        events: BTreeMap<String, Schema>,
        captures: BTreeMap<String, Capture>,
    },
    Value {
        schema: Schema,
    },
    Resource {
        resource: String,
        schema: Schema,
    },
}

// Deserialize the fields directly instead of buffering the entire tagged enum
// as serde Content, which copies every nested schema before building its Value.
impl<'de> Deserialize<'de> for Interface {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case")]
        enum Kind {
            Service,
            Component,
            Value,
            Resource,
        }

        // A present JSON null must remain present for Value fields and must fail
        // for typed fields. Ordinary Option deserialization would lose both rules.
        fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
        where
            D: serde::Deserializer<'de>,
            T: Deserialize<'de>,
        {
            T::deserialize(deserializer).map(Some)
        }

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            kind: Kind,
            #[serde(default, deserialize_with = "present")]
            methods: Option<BTreeMap<String, Method>>,
            #[serde(default, deserialize_with = "present")]
            props: Option<Schema>,
            #[serde(default, deserialize_with = "present")]
            events: Option<BTreeMap<String, Schema>>,
            #[serde(default, deserialize_with = "present")]
            captures: Option<BTreeMap<String, Capture>>,
            #[serde(default, deserialize_with = "present")]
            schema: Option<Schema>,
            #[serde(default, deserialize_with = "present")]
            resource: Option<String>,
        }

        struct FieldsVisitor;
        impl<'de> serde::de::Visitor<'de> for FieldsVisitor {
            type Value = Fields;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an interface object")
            }

            fn visit_map<M: serde::de::MapAccess<'de>>(self, map: M) -> Result<Fields, M::Error> {
                Fields::deserialize(serde::de::value::MapAccessDeserializer::new(map))
            }
        }
        let fields = deserializer.deserialize_map(FieldsVisitor)?;
        let allowed: &'static [&'static str] = match fields.kind {
            Kind::Service => &["kind", "methods"],
            Kind::Component => &["kind", "props", "events", "captures"],
            Kind::Value => &["kind", "schema"],
            Kind::Resource => &["kind", "resource", "schema"],
        };
        for (name, present) in [
            ("methods", fields.methods.is_some()),
            ("props", fields.props.is_some()),
            ("events", fields.events.is_some()),
            ("captures", fields.captures.is_some()),
            ("schema", fields.schema.is_some()),
            ("resource", fields.resource.is_some()),
        ] {
            if present && !allowed.contains(&name) {
                return Err(serde::de::Error::unknown_field(name, allowed));
            }
        }
        fn required<T, E: serde::de::Error>(value: Option<T>, name: &'static str) -> Result<T, E> {
            value.ok_or_else(|| E::missing_field(name))
        }
        Ok(match fields.kind {
            Kind::Service => Self::Service {
                methods: required(fields.methods, "methods")?,
            },
            Kind::Component => Self::Component {
                props: required(fields.props, "props")?,
                events: required(fields.events, "events")?,
                captures: required(fields.captures, "captures")?,
            },
            Kind::Value => Self::Value {
                schema: required(fields.schema, "schema")?,
            },
            Kind::Resource => Self::Resource {
                resource: required(fields.resource, "resource")?,
                schema: required(fields.schema, "schema")?,
            },
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Method {
    pub mode: MethodMode,
    pub input: Schema,
    pub output: Schema,
    /// Bounded transient observations from this mutation, separate from its
    /// original final receipt. Only mutation methods may declare progress.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<Schema>,
    pub resources: BTreeMap<String, ResourceSlot>,
}

/// One declared input slot: its nominal type and whether the caller may omit it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResourceSlot {
    #[serde(rename = "type")]
    pub resource_type: ResourceType,
    pub optional: bool,
}
impl ResourceType {
    pub fn required(self) -> ResourceSlot {
        ResourceSlot {
            resource_type: self,
            optional: false,
        }
    }
    pub fn optional(self) -> ResourceSlot {
        ResourceSlot {
            resource_type: self,
            optional: true,
        }
    }
}

/// Nominal read-only resource shape, not a resource id or authorization token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResourceType {
    pub name: String,
    pub version: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Capture {
    pub input: Schema,
    pub output: CaptureOutput,
}
/// Resource captures enter checked service slots; continuations remain in the
/// original presentation owner and only decide admission of query feedback.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CaptureOutput {
    Resource { resource: ResourceType },
    Continuation,
}
impl ResourceType {
    pub fn validate(&self) -> Result<(), Error> {
        crate::name(&self.name)?;
        if self.version == 0 {
            return Err(Error::Declaration(
                "resource version must be positive".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MethodMode {
    Query,
    Mutation,
    Subscription,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Import {
    pub contract: Contract,
    pub cardinality: Cardinality,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Cardinality {
    One,
    Optional,
    Many { min: usize, max: usize },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Export {
    pub contract: Contract,
    pub availability: Availability,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Required,
    Optional,
}

impl Contract {
    pub fn validate(&self) -> Result<(), Error> {
        crate::name(&self.name)?;
        if self.version == 0 {
            return Err(Error::Declaration(
                "contract version must be positive".into(),
            ));
        }
        match &self.interface {
            Interface::Service { methods } => {
                for (name, method) in methods {
                    crate::name(name)?;
                    crate::schema(&method.input)?;
                    crate::schema(&method.output)?;
                    if let Some(progress) = &method.progress {
                        if method.mode != MethodMode::Mutation {
                            return Err(Error::Declaration(
                                "only mutation methods may declare progress".into(),
                            ));
                        }
                        crate::schema(progress)?;
                    }
                    for (slot, resource) in &method.resources {
                        crate::name(slot)?;
                        resource.resource_type.validate()?;
                    }
                }
            }
            Interface::Component {
                props,
                events,
                captures,
            } => {
                crate::schema(props)?;
                for (name, capture) in captures {
                    crate::name(name)?;
                    crate::schema(&capture.input)?;
                    if let CaptureOutput::Resource { resource } = &capture.output {
                        resource.validate()?;
                    }
                }
                for (name, schema) in events {
                    crate::name(name)?;
                    crate::schema(schema)?;
                }
            }
            Interface::Value { schema } => crate::schema(schema)?,
            Interface::Resource { resource, schema } => {
                crate::name(resource)?;
                crate::schema(schema)?;
            }
        }
        Ok(())
    }

    /// Conservative compatibility: nominal identity AND the full public shape.
    /// Version numbers alone cannot admit a changed declaration.
    pub fn accepts(&self, provider: &Self) -> bool {
        self == provider
    }
}

impl Cardinality {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if let Self::Many { min, max } = self
            && min > max
        {
            return Err(Error::Declaration("invalid import cardinality".into()));
        }
        Ok(())
    }

    pub(crate) fn accepts(&self, total: usize, guaranteed: usize) -> bool {
        match *self {
            Self::One => total == 1 && guaranteed == 1,
            Self::Optional => total <= 1,
            Self::Many { min, max } => guaranteed >= min && total <= max,
        }
    }
}

#[cfg(test)]
mod interface_deserialization_tests {
    use super::Interface;
    use serde_json::{Value, json};

    #[test]
    fn interfaces_round_trip_with_the_tag_before_or_after_fields() {
        for value in [
            json!({"kind": "service", "methods": {"read": {
                "mode": "query", "input": {"type": "object"},
                "output": {"type": "string"}, "resources": {}
            }}}),
            json!({"kind": "component", "props": {}, "events": {"change": true}, "captures": {}}),
            json!({"kind": "value", "schema": true}),
            json!({"kind": "resource", "resource": "text", "schema": {}}),
        ] {
            let fields = value.as_object().unwrap();
            let tag = serde_json::to_string(&fields["kind"]).unwrap();
            let rest = fields
                .iter()
                .filter(|(name, _)| *name != "kind")
                .map(|(name, value)| format!("{name:?}:{value}"))
                .collect::<Vec<_>>()
                .join(",");
            for text in [
                format!("{{\"kind\":{tag},{rest}}}"),
                format!("{{{rest},\"kind\":{tag}}}"),
            ] {
                let interface: Interface = serde_json::from_str(&text).unwrap();
                assert_eq!(serde_json::to_value(&interface).unwrap(), value);
                assert_eq!(
                    serde_json::from_value::<Interface>(value.clone()).unwrap(),
                    interface
                );
            }
        }
    }

    #[test]
    fn null_schema_values_are_present_but_typed_fields_require_their_types() {
        for text in [
            r#"{"kind":"value","schema":null}"#,
            r#"{"kind":"resource","resource":"text","schema":null}"#,
            r#"{"kind":"component","props":null,"events":{},"captures":{}}"#,
        ] {
            let interface: Interface = serde_json::from_str(text).unwrap();
            assert_eq!(
                serde_json::to_value(interface).unwrap(),
                serde_json::from_str::<Value>(text).unwrap()
            );
        }
        for text in [
            r#"{"kind":"service","methods":null}"#,
            r#"{"kind":"component","props":{},"events":null,"captures":{}}"#,
            r#"{"kind":"component","props":{},"events":{},"captures":null}"#,
            r#"{"kind":"resource","resource":null,"schema":{}}"#,
            r#"{"kind":null,"schema":{}}"#,
        ] {
            assert!(serde_json::from_str::<Interface>(text).is_err(), "{text}");
        }
    }

    #[test]
    fn malformed_or_cross_variant_fields_are_rejected() {
        for text in [
            r#"{"kind":"service"}"#,
            r#"{"kind":"component","props":{},"events":{}}"#,
            r#"{"kind":"component","props":{},"captures":{}}"#,
            r#"{"kind":"component","events":{},"captures":{}}"#,
            r#"{"kind":"value"}"#,
            r#"{"kind":"resource","schema":{}}"#,
            r#"{"kind":"resource","resource":"text"}"#,
            r#"{"schema":{}}"#,
            r#"{"kind":"unknown","schema":{}}"#,
            r#"{"kind":"value","schema":{},"extra":true}"#,
            r#"{"kind":"value","kind":"value","schema":{}}"#,
            r#"{"kind":"value","schema":null,"schema":{}}"#,
            r#"{"kind":"component","props":null,"props":{},"events":{},"captures":{}}"#,
            r#"{"kind":"service","methods":{},"schema":null}"#,
            r#"{"kind":"component","props":{},"events":{},"captures":{},"methods":{}}"#,
            r#"{"kind":"value","schema":{},"resource":"text"}"#,
            r#"{"kind":"resource","resource":"text","schema":{},"events":{}}"#,
            r#"["value",null,null,null,null,{},null]"#,
        ] {
            assert!(serde_json::from_str::<Interface>(text).is_err(), "{text}");
        }
    }
}
