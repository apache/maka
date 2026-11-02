<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# WebP dimensions before allocation

Source and unmodified dual MIT/Apache-2.0 licenses come from the published
`image-webp`0.2.4 crate. Published VCS metadata names revision
[08b57d473c90148dd4b37a075df365afc3dfcc2b](https://github.com/image-rs/image-webp/tree/08b57d473c90148dd4b37a075df365afc3dfcc2b).
`upstream.json` records original file hashes, before the local patch. The published
manifest and production dependencies remain unchanged. Two upstream YUV test array
lines have trailing whitespace removed for the source hooks; behavior is unchanged.

The container decoder now supplies its expected static canvas or ANMF frame
width/height to the original VP8 decoder. It compares the intrinsic keyframe
header before allocating macroblocks or Y/U/V planes. Previously a small VP8X
canvas could contain a much larger VP8 header, allocating hundreds of MiB before
`InconsistentImageSizes`. This is a codec boundary correction, not an alternate
WebP parser or Maka renderer workaround. Lossless decoding already checks the
expected dimensions before transforms/output allocation. Three lossy paths
(static, animated opaque, animated alpha) use the same early check.

The raw VP8 API without a container retains its intrinsic-dimension behavior;
container callers use the supplied-dimension path. Native image admission still
limits encoded bytes, outer dimensions/pixels, aggregate allocations and actual
concurrent jobs. The image crate's `max_alloc` is not claimed as an allocator sandbox.

The local image-view decoder also propagates its existing memory allowance into
VP8L and alpha Huffman groups, checking table allocations before building them.
VP8 partition buffers grow only from encoded bytes actually read, and animated
canvas allocation uses checked pixel arithmetic. These checks keep request image
preparation accounting effective for compressed inputs and truncated partitions.
