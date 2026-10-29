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

//! Directly indexed concatenation of canonical raw spans and generated punctuation.
use maka_agent_facts::model::prompt_source::source::{
    ByteCursor, ByteSource, ChargedBuffer, ReadSource, SourceBudget, SourceBytes, SourceRead,
};
use std::{io, ops::Range, sync::Arc};

pub(super) fn metadata_bytes(parts: usize) -> io::Result<usize> {
    let arrays = parts
        .checked_mul(std::mem::size_of::<SourceBytes>())
        .and_then(|bytes| {
            parts
                .checked_add(1)
                .and_then(|count| count.checked_mul(std::mem::size_of::<u64>()))
                .and_then(|offsets| bytes.checked_add(offsets))
        })
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "joined metadata size overflow")
        })?;
    arrays
        .checked_add(
            std::mem::size_of::<Directory>()
                + std::mem::size_of::<Joined>()
                + 4 * std::mem::size_of::<usize>(),
        )
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "joined metadata size overflow"))
}

pub(super) fn join(
    parts: Vec<SourceBytes>,
    owner: Arc<dyn Send + Sync>,
) -> io::Result<SourceBytes> {
    let mut offsets = Vec::with_capacity(parts.len() + 1);
    let mut total = 0u64;
    offsets.push(total);
    for part in &parts {
        let bytes = match part {
            SourceBytes::Inline(bytes) => bytes.len() as u64,
            SourceBytes::Source(source) => source.len().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "indexed raw concatenation requires known source lengths",
                )
            })?,
        };
        total = total.checked_add(bytes).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "joined source length overflow")
        })?;
        offsets.push(total);
    }
    Ok(SourceBytes::Source(Arc::new(Joined {
        directory: Arc::new(Directory {
            parts: parts.into_boxed_slice(),
            offsets: offsets.into_boxed_slice(),
            _owner: owner,
        }),
        range: 0..total,
    })))
}
struct Directory {
    parts: Box<[SourceBytes]>,
    offsets: Box<[u64]>,
    _owner: Arc<dyn Send + Sync>,
}
struct Joined {
    directory: Arc<Directory>,
    range: Range<u64>,
}
impl ByteSource for Joined {
    fn len(&self) -> Option<u64> {
        Some(self.range.end - self.range.start)
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        if range.start > range.end || range.end > self.range.end - self.range.start {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "joined source range exceeds captured bytes",
            ));
        }
        Ok(Arc::new(Self {
            directory: self.directory.clone(),
            range: self.range.start + range.start..self.range.start + range.end,
        }))
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        let part = self
            .directory
            .offsets
            .partition_point(|&offset| offset <= self.range.start)
            .saturating_sub(1);
        Box::new(Cursor {
            directory: self.directory.clone(),
            position: self.range.start,
            end: self.range.end,
            part,
            current: None,
            budget,
        })
    }
}
struct Cursor {
    directory: Arc<Directory>,
    position: u64,
    end: u64,
    part: usize,
    current: Option<Box<dyn ByteCursor>>,
    budget: Arc<dyn SourceBudget>,
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            loop {
                if self.position == self.end {
                    return Ok(SourceRead {
                        buffer,
                        bytes_read: 0,
                        eof: true,
                    });
                }
                if self.current.is_none() {
                    let start = self.directory.offsets[self.part];
                    let end = self.directory.offsets[self.part + 1];
                    let range = self.position - start..end.min(self.end) - start;
                    self.current = Some(
                        self.directory.parts[self.part]
                            .slice(range)?
                            .open(self.budget.clone()),
                    );
                }
                let mut read = self
                    .current
                    .as_mut()
                    .expect("active joined part")
                    .read_chunk(buffer)
                    .await?;
                self.position += read.bytes_read as u64;
                if read.eof {
                    if self.position != self.directory.offsets[self.part + 1].min(self.end) {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "joined source part changed length",
                        ));
                    }
                    self.current = None;
                    self.part += 1;
                }
                if read.bytes_read != 0 {
                    read.eof = self.position == self.end;
                    read.buffer = read.buffer.retain_owner(self.directory.clone());
                    return Ok(read);
                }
                if !read.eof {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "joined source part made no progress",
                    ));
                }
                buffer = read.buffer;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::prompt_source::source::Allocate;
    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
        }
    }
    #[tokio::test]
    async fn ranges_cross_boundaries_and_skip_empty_parts() {
        let source = join(
            vec![
                SourceBytes::Inline((&b""[..]).into()),
                SourceBytes::Inline((&b"abc"[..]).into()),
                SourceBytes::Inline((&b""[..]).into()),
                SourceBytes::Inline((&b"def"[..]).into()),
            ],
            Arc::new(()),
        )
        .unwrap()
        .slice(2..5)
        .unwrap();
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let mut cursor = source.open(budget.clone());
        let mut result = Vec::new();
        loop {
            let read = cursor
                .read_chunk(budget.allocate(2).await.unwrap())
                .await
                .unwrap();
            result.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
            if read.eof {
                break;
            }
        }
        assert_eq!(result, b"cde");
    }
    #[tokio::test]
    async fn suffix_range_never_opens_the_skipped_source() {
        struct Unreadable;
        impl ByteSource for Unreadable {
            fn len(&self) -> Option<u64> {
                Some(3)
            }
            fn open(&self, _: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
                panic!("skipped source must not open")
            }
        }
        let source = join(
            vec![
                SourceBytes::Source(Arc::new(Unreadable)),
                SourceBytes::Inline((&b"def"[..]).into()),
            ],
            Arc::new(()),
        )
        .unwrap()
        .slice(3..6)
        .unwrap();
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let mut cursor = source.open(budget.clone());
        let read = cursor
            .read_chunk(budget.allocate(3).await.unwrap())
            .await
            .unwrap();
        assert_eq!(&read.buffer.as_ref()[..read.bytes_read], b"def");
        assert!(read.eof);
    }
}
