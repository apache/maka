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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLoopbackHost, isPrivateRangeHost } from '../mcp.js';

describe('MCP host classification', () => {
  it('classifies IPv6 literals by parsed bytes, not spelling', () => {
    // WHATWG URL parsing canonicalizes hostnames, so the same address
    // arrives in different spellings depending on how it was written; the
    // classifier must agree across all of them.
    for (const spelling of [
      '[::ffff:127.0.0.1]',
      '[::FFFF:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[0:0:0:0:0:ffff:7f00:1]',
    ]) {
      assert.equal(isPrivateRangeHost(spelling), true, spelling);
      // The asymmetry is deliberate: teaching isLoopbackHost the mapped
      // spelling would flip its fail-closed cleartext refusal into
      // fail-open. The mapped loopback must land on the PRIVATE side.
      assert.equal(isLoopbackHost(spelling), false, spelling);
    }
    // The canonical URL round-trip agrees with the raw spellings.
    assert.equal(isPrivateRangeHost(new URL('https://[::ffff:192.168.1.1]/').hostname), true);
    assert.equal(isPrivateRangeHost(new URL('https://[64:ff9b::10.0.0.5]/').hostname), true);
  });

  it('covers the whole fe80::/10 link-local range, not just the fe8 spelling', () => {
    for (const inner of ['fe80::1', 'fe9a::1', 'feaf::1', 'febf::1']) {
      assert.equal(isPrivateRangeHost(`[${inner}]`), true, inner);
    }
    assert.equal(isPrivateRangeHost('[fec0::1]'), false);
  });

  it('classifies deprecated IPv4-compatible ::/96 embeddings by their bytes', () => {
    // RFC 4291 §2.5.5.1 — deprecated, but a byte-level embedding the
    // classifier must know regardless of whether modern stacks still
    // translate it: the gate's correctness must not rest on the other
    // end's network stack.
    assert.equal(isPrivateRangeHost(new URL('https://[::192.168.1.1]/').hostname), true);
    assert.equal(isPrivateRangeHost(new URL('https://[::127.0.0.1]/').hostname), true);
    assert.equal(isPrivateRangeHost('[::c0a8:101]'), true);
    assert.equal(isPrivateRangeHost('[::7f00:1]'), true);
    assert.equal(isPrivateRangeHost('[::a00:5]'), true); // ::10.0.0.5
    // Public v4-compatible stays global; the unspecified address reaches
    // the local machine on common stacks and is private (fail closed).
    assert.equal(isPrivateRangeHost('[::808:808]'), false);
    assert.equal(isPrivateRangeHost('[::]'), true);
    assert.equal(isPrivateRangeHost('[::2]'), false);
  });

  it('keeps global addresses reachable and fails closed on garbage', () => {
    assert.equal(isPrivateRangeHost('[2606:4700::1]'), false);
    assert.equal(isPrivateRangeHost('[::ffff:808:808]'), false); // mapped 8.8.8.8
    assert.equal(isPrivateRangeHost('[64:ff9b::808:808]'), false);
    assert.equal(isPrivateRangeHost('[::1]'), false); // isLoopbackHost's positive case
    assert.equal(isLoopbackHost('[::1]'), true);
    // An unparseable bracketed literal is treated as private: the SSRF
    // gate fails closed on spellings it cannot classify.
    assert.equal(isPrivateRangeHost('[not-an-address]'), true);
    assert.equal(isPrivateRangeHost('[1::2::3]'), true);
  });
});
