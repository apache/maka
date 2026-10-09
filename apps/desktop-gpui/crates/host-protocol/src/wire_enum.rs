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

//! A string enum that keeps values it does not recognize.
//!
//! The TypeScript decoders reject unknown literals, but a client that did so
//! would break whenever a newer Host adds a status or mode. Each generated enum
//! therefore carries an `Other(String)` variant that preserves the wire value,
//! and serializes back to exactly what it read.

/// Declares an open string enum.
///
/// ```ignore
/// wire_enum! {
///     /// Docs.
///     pub enum SessionStatus {
///         Active = "active" | "review" | "done",
///         Running = "running",
///     }
/// }
/// ```
///
/// Literals after the first `|` are decode-only aliases; serialization always
/// writes the first literal.
macro_rules! wire_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $(
                $(#[$variant_meta:meta])*
                $variant:ident = $wire:literal $(| $alias:literal)*
            ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        pub enum $name {
            $(
                $(#[$variant_meta])*
                $variant,
            )+
            /// A value this client does not recognize, preserved verbatim.
            Other(String),
        }

        impl $name {
            /// The wire literal for this value.
            pub fn as_str(&self) -> &str {
                match self {
                    $(Self::$variant => $wire,)+
                    Self::Other(value) => value,
                }
            }

            /// Parses a wire literal, keeping unknown values in `Other`.
            pub fn from_wire(value: &str) -> Self {
                match value {
                    $($wire $(| $alias)* => Self::$variant,)+
                    other => Self::Other(other.to_owned()),
                }
            }
        }

        impl ::std::fmt::Display for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <String as ::serde::Deserialize>::deserialize(deserializer)?;
                Ok(Self::from_wire(&value))
            }
        }
    };
}

/// Declares a zero-sized crate-private type for a fixed discriminator field,
/// such as `kind: "hello"` on a struct that is not part of a tagged enum.
/// It serializes the literal and rejects any other value on decode.
macro_rules! wire_tag {
    ($(#[$meta:meta])* $name:ident = $wire:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
        pub(crate) struct $name;

        impl $name {
            pub(crate) const WIRE: &'static str = $wire;
        }

        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(Self::WIRE)
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <String as ::serde::Deserialize>::deserialize(deserializer)?;
                if value == Self::WIRE {
                    Ok(Self)
                } else {
                    Err(<D::Error as ::serde::de::Error>::invalid_value(
                        ::serde::de::Unexpected::Str(&value),
                        &Self::WIRE,
                    ))
                }
            }
        }
    };
}

/// Declares an open tagged union: a JSON object whose `tag` field selects the
/// payload type, like TypeScript's discriminated unions.
///
/// ```ignore
/// wire_union! {
///     /// Docs.
///     pub enum SessionFrameEvent in "type" {
///         ToolStart(SessionToolStart) = "tool_start",
///         ToolProgress(SessionToolProgress) = "tool_progress",
///     }
/// }
/// ```
///
/// Each payload is decoded from the object with the tag removed, so payload
/// structs do not declare the tag (and may deny unknown fields in tests). A
/// value whose tag is not listed becomes `Unknown(Value)`, kept verbatim with
/// its tag, and serializes back unchanged. A listed tag with a malformed body
/// and an object without a string tag are decode errors.
macro_rules! wire_union {
    (
        $(#[$meta:meta])*
        pub enum $name:ident in $tag:literal {
            $(
                $(#[$variant_meta:meta])*
                $variant:ident($payload:ty) = $wire:literal
            ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq)]
        #[non_exhaustive]
        pub enum $name {
            $(
                $(#[$variant_meta])*
                $variant($payload),
            )+
            /// A value whose tag this client does not recognize, kept
            /// verbatim, tag included.
            Unknown(::serde_json::Value),
        }

        impl $name {
            /// The name of the discriminating field.
            pub const TAG_FIELD: &'static str = $tag;

            /// The wire tag of this value (empty for an `Unknown` value whose
            /// tag is not a string).
            pub fn tag(&self) -> &str {
                match self {
                    $(Self::$variant(_) => $wire,)+
                    Self::Unknown(value) => value
                        .get($tag)
                        .and_then(::serde_json::Value::as_str)
                        .unwrap_or_default(),
                }
            }
        }

        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use ::serde::ser::Error as _;
                let (wire, payload) = match self {
                    $(Self::$variant(payload) => (
                        $wire,
                        ::serde_json::to_value(payload).map_err(S::Error::custom)?,
                    ),)+
                    Self::Unknown(value) => return value.serialize(serializer),
                };
                let ::serde_json::Value::Object(fields) = payload else {
                    return Err(S::Error::custom(concat!(
                        stringify!($name),
                        " payload did not encode as an object"
                    )));
                };
                let mut tagged = ::serde_json::Map::new();
                tagged.insert($tag.to_owned(), ::serde_json::Value::from(wire));
                tagged.extend(fields);
                tagged.serialize(serializer)
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                use ::serde::de::Error as _;
                let mut value = <::serde_json::Value as ::serde::Deserialize>::deserialize(deserializer)?;
                let Some(tag) = value.get($tag).and_then(::serde_json::Value::as_str) else {
                    return Err(D::Error::custom(concat!(
                        stringify!($name),
                        " has no string `",
                        $tag,
                        "` field"
                    )));
                };
                match tag {
                    $($wire => {
                        if let Some(fields) = value.as_object_mut() {
                            fields.remove($tag);
                        }
                        ::serde_json::from_value(value)
                            .map(Self::$variant)
                            .map_err(|error| D::Error::custom(format!(
                                "{} `{}`: {error}",
                                stringify!($name),
                                $wire
                            )))
                    })+
                    _ => Ok(Self::Unknown(value)),
                }
            }
        }
    };
}

#[cfg(test)]
mod tests {
    #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    pub struct Point {
        x: i32,
    }

    wire_union! {
        /// A test union.
        pub enum Shape in "kind" {
            Point(Point) = "point",
            Raw(serde_json::Value) = "raw",
        }
    }

    #[test]
    fn union_decodes_known_tags_without_the_tag_field() {
        let shape: Shape =
            serde_json::from_value(serde_json::json!({"kind": "point", "x": 1})).expect("decode");
        assert_eq!(shape, Shape::Point(Point { x: 1 }));
        assert_eq!(shape.tag(), "point");
        assert_eq!(Shape::TAG_FIELD, "kind");
        assert_eq!(
            serde_json::to_value(&shape).expect("encode"),
            serde_json::json!({"kind": "point", "x": 1})
        );
    }

    #[test]
    fn union_value_payloads_round_trip() {
        let wire = serde_json::json!({"kind": "raw", "a": [1, 2]});
        let shape: Shape = serde_json::from_value(wire.clone()).expect("decode");
        assert_eq!(shape, Shape::Raw(serde_json::json!({"a": [1, 2]})));
        assert_eq!(serde_json::to_value(&shape).expect("encode"), wire);
    }

    #[test]
    fn union_keeps_unknown_tags_verbatim() {
        let wire = serde_json::json!({"kind": "circle", "r": 2});
        let shape: Shape = serde_json::from_value(wire.clone()).expect("decode");
        assert_eq!(shape, Shape::Unknown(wire.clone()));
        assert_eq!(shape.tag(), "circle");
        assert_eq!(serde_json::to_value(&shape).expect("encode"), wire);
    }

    #[test]
    fn union_rejects_malformed_known_tags_and_missing_tags() {
        assert!(serde_json::from_value::<Shape>(serde_json::json!({"kind": "point"})).is_err());
        assert!(
            serde_json::from_value::<Shape>(serde_json::json!({"kind": "point", "x": 1, "y": 2}))
                .is_err()
        );
        assert!(serde_json::from_value::<Shape>(serde_json::json!({"x": 1})).is_err());
        assert!(serde_json::from_value::<Shape>(serde_json::json!({"kind": 3})).is_err());
    }

    wire_tag! {
        /// A test tag.
        SampleTag = "sample"
    }

    #[test]
    fn tag_accepts_only_its_literal() {
        assert_eq!(serde_json::from_str::<SampleTag>("\"sample\"").expect("decode"), SampleTag);
        assert!(serde_json::from_str::<SampleTag>("\"other\"").is_err());
        assert_eq!(serde_json::to_string(&SampleTag).expect("encode"), "\"sample\"");
    }

    wire_enum! {
        /// A test enum.
        pub enum Sample {
            First = "first" | "legacy_first",
            Second = "second",
        }
    }

    #[test]
    fn known_values_round_trip() {
        let value: Sample = serde_json::from_str("\"second\"").expect("decode");
        assert_eq!(value, Sample::Second);
        assert_eq!(serde_json::to_string(&value).expect("encode"), "\"second\"");
    }

    #[test]
    fn aliases_decode_to_the_canonical_value() {
        let value: Sample = serde_json::from_str("\"legacy_first\"").expect("decode");
        assert_eq!(value, Sample::First);
        assert_eq!(serde_json::to_string(&value).expect("encode"), "\"first\"");
    }

    #[test]
    fn unknown_values_are_preserved() {
        let value: Sample = serde_json::from_str("\"third\"").expect("decode");
        assert_eq!(value, Sample::Other("third".into()));
        assert_eq!(serde_json::to_string(&value).expect("encode"), "\"third\"");
    }

    #[test]
    fn non_strings_are_rejected() {
        assert!(serde_json::from_str::<Sample>("1").is_err());
    }
}
