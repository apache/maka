//! Benchmarks for [`Parser`], the streaming input parser.
//!
//! This currently only tests the time/throughput of bracketed paste. Bracketed paste includes
//! arbitrary content, so the OSC sequence can reach very very long lengths.

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use termina::Parser;

/// Matches the read buffer size used by the real event sources (see
/// `src/event/source/unix.rs`), since bytes only trickle into the parser a chunk at a time.
const CHUNK_SIZE: usize = 1024;

fn bracketed_paste(content_len: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(content_len + 12);
    bytes.extend_from_slice(b"\x1b[200~");
    bytes.extend(std::iter::repeat(b'a').take(content_len));
    bytes.extend_from_slice(b"\x1b[201~");
    bytes
}

fn paste(c: &mut Criterion) {
    let mut group = c.benchmark_group("paste");

    for size in [1_000, 20_000, 200_000] {
        let input = bracketed_paste(size);
        group.throughput(Throughput::Bytes(input.len() as u64));
        group.bench_with_input(BenchmarkId::from_parameter(size), &input, |b, input| {
            b.iter(|| {
                let mut parser = Parser::default();
                for chunk in input.chunks(CHUNK_SIZE) {
                    // Mirrors `src/event/source/unix.rs`: `maybe_more` is true when a read fills
                    // the whole buffer, since more bytes are likely still waiting to be read.
                    parser
                        .parse(black_box(chunk), chunk.len() == CHUNK_SIZE)
                        .unwrap();
                }
                while let Some(event) = parser.pop() {
                    black_box(event);
                }
            })
        });
    }

    group.finish();
}

criterion_group!(benches, paste);
criterion_main!(benches);
