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
import {
  MCP_SECRET_WITHHELD_MESSAGE,
  mcpSecretInventory,
  scrubKnownMcpSecrets,
} from '../mcp-secrets.js';

describe('MCP secret inventory and scrubbing', () => {
  it('substitutes longer secrets before their prefixes', () => {
    // With both configured, replacing `abcd` first would shred `abcdEFGH`
    // into `[redacted]EFGH` and leave its tail exposed.
    const scrubbed = scrubKnownMcpSecrets('token abcdEFGH and abcd here', {
      substitute: ['abcd', 'abcdEFGH'],
      withhold: [],
    });
    assert.equal(scrubbed, 'token [redacted] and [redacted] here');
    assert.doesNotMatch(scrubbed, /EFGH/u);
  });

  it('bounded-substitutes short fragments of a longer credential instead of withholding', () => {
    // "Bearer x" splits into the one-character part "x": withholding on it
    // would collapse every message containing that letter, but ignoring it
    // would leak an upstream that reflects the bare fragment. It is
    // substituted at token boundaries only.
    const inventory = mcpSecretInventory({
      url: 'https://api.example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    assert.deepEqual(inventory.withhold, []);
    assert.deepEqual(inventory.substituteBounded, ['x']);
    const scrubbed = scrubKnownMcpSecrets('an x marks the spot; Bearer x leaked', inventory);
    assert.notEqual(scrubbed, MCP_SECRET_WITHHELD_MESSAGE);
    assert.doesNotMatch(scrubbed, /Bearer x/u);
    // The standalone fragment is gone; words merely containing the
    // character are untouched.
    assert.equal(scrubbed, 'an [redacted] marks the spot; [redacted] leaked');
    assert.equal(
      scrubKnownMcpSecrets('token x expired for example.com', inventory),
      'token [redacted] expired for example.com',
    );

    // A whole credential VALUE too short to splice still withholds.
    const short = mcpSecretInventory({
      url: 'https://api.example.com/mcp',
      headers: { Authorization: 'k7#' },
    });
    assert.deepEqual(short.withhold, ['k7#']);
    assert.equal(scrubKnownMcpSecrets('echoing k7# back', short), MCP_SECRET_WITHHELD_MESSAGE);
  });
});
