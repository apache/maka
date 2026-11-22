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

use super::error::ModelError;
use serde::Serialize;
use std::io;

/// Count serialized bytes without making another full copy of model/image data.
/// Stop serialization at the boundary instead of allocating then rejecting.
pub fn bytes(value: &impl Serialize, maximum: u32) -> Result<u32, ModelError> {
    count(value, maximum, true)
}

/// Reserve queue capacity without rejecting a larger individual request.
/// Such a request takes the whole window and therefore runs alone.
pub fn reservation(value: &impl Serialize, capacity: u32) -> Result<u32, ModelError> {
    count(value, capacity, false)
}

fn count(value: &impl Serialize, maximum: u32, reject_excess: bool) -> Result<u32, ModelError> {
    struct Counter {
        used: u32,
        maximum: u32,
        reject_excess: bool,
    }
    impl io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let remaining = self.maximum.saturating_sub(self.used);
            if bytes.len() > remaining as usize && self.reject_excess {
                return Err(io::Error::other("serialized value exceeds byte budget"));
            }
            self.used += bytes.len().min(remaining as usize) as u32;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        used: 0,
        maximum,
        reject_excess,
    };
    serde_json::to_writer(&mut counter, value)
        .map_err(|error| ModelError::Adapter(error.to_string()))?;
    Ok(counter.used.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queue_reservations_saturate_while_event_limits_still_reject() {
        let value = serde_json::json!({"content":"large screenshot request"});
        assert_eq!(reservation(&value, 8).unwrap(), 8);
        assert!(bytes(&value, 8).is_err());
        assert_eq!(
            reservation(&value, 1024).unwrap(),
            bytes(&value, 1024).unwrap()
        );
    }
}
