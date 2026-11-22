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

//! Git binary patch wire format: zlib literals in length-prefixed base85 lines.
//! We emit full images rather than implementing Git's optional delta compression.
use std::io::{self, Write};
const ALPHABET: &[u8; 85] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

pub(super) fn literal(out: &mut Vec<u8>, bytes: &[u8]) -> io::Result<()> {
    writeln!(out, "literal {}", bytes.len())?;
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(bytes)?;
    let compressed = encoder.finish()?;
    for line in compressed.chunks(52) {
        out.push(if line.len() <= 26 {
            b'A' + line.len() as u8 - 1
        } else {
            b'a' + line.len() as u8 - 27
        });
        for block in line.chunks(4) {
            let mut word = [0u8; 4];
            word[..block.len()].copy_from_slice(block);
            let mut number = u32::from_be_bytes(word);
            let mut encoded = [0; 5];
            for digit in encoded.iter_mut().rev() {
                *digit = ALPHABET[(number % 85) as usize];
                number /= 85;
            }
            out.extend_from_slice(&encoded);
        }
        out.push(b'\n');
    }
    out.push(b'\n');
    Ok(())
}
