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

use serde::Serialize;
use serde_json::ser::Formatter;
use std::io;

/// Serialize interaction records and JSON values with compact ECMAScript numbers.
/// Record equality is semantic; object key order is not a canonical byte contract.
pub fn stringify(value: &impl Serialize) -> Result<String, serde_json::Error> {
    struct JsFormatter;
    impl Formatter for JsFormatter {
        fn write_f64<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: f64,
        ) -> io::Result<()> {
            writer.write_all(ryu_js::Buffer::new().format(value).as_bytes())
        }
        fn write_u64<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: u64,
        ) -> io::Result<()> {
            self.write_f64(writer, value as f64)
        }
        fn write_i64<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: i64,
        ) -> io::Result<()> {
            self.write_f64(writer, value as f64)
        }
        fn write_number_str<W: ?Sized + io::Write>(
            &mut self,
            writer: &mut W,
            value: &str,
        ) -> io::Result<()> {
            let number = value
                .parse::<f64>()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if !number.is_finite() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "ECMAScript numbers must be finite",
                ));
            }
            self.write_f64(writer, number)
        }
    }
    let mut bytes = Vec::new();
    value.serialize(&mut serde_json::Serializer::with_formatter(
        &mut bytes,
        JsFormatter,
    ))?;
    Ok(String::from_utf8(bytes).expect("JSON serialization emits UTF-8"))
}
