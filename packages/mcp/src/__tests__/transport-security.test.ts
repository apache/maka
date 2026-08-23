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
import { assertTransportSecurity, urlProvenance } from '../transport-security.js';

describe('transport security provenance', () => {
  const remoteRoot = urlProvenance(new URL('https://api.example.com/mcp'));
  const loopbackRoot = urlProvenance(new URL('http://127.0.0.1:8080/mcp'));

  it('allows public https regardless of provenance', () => {
    assert.doesNotThrow(() =>
      assertTransportSecurity(new URL('https://as.example.com/token'), remoteRoot),
    );
    assert.doesNotThrow(() =>
      assertTransportSecurity(new URL('https://as.example.com/token'), loopbackRoot),
    );
  });

  it('refuses remotely supplied https aimed back into the machine or network', () => {
    // A remote server's OAuth metadata naming an internal https destination
    // is a request-forgery primitive (blind SSRF): the client would issue
    // the GET/POST from inside the user's network.
    for (const url of [
      'https://127.0.0.1:8443/latest/meta-data/',
      'https://localhost:8443/admin',
      'https://169.254.169.254/latest/meta-data/',
      'https://192.168.1.1/router',
      'https://10.0.0.5/internal',
      'https://172.16.0.9/internal',
      'https://100.64.0.1/cgnat',
    ]) {
      assert.throws(() => assertTransportSecurity(new URL(url), remoteRoot), /refused remotely/u);
    }
    // A loopback trust root keeps its local machine reachable; an internal
    // configured endpoint keeps its own network reachable.
    assert.doesNotThrow(() =>
      assertTransportSecurity(new URL('https://127.0.0.1:8443/token'), loopbackRoot),
    );
    const internalRoot = urlProvenance(new URL('https://10.1.2.3/mcp'));
    assert.doesNotThrow(() =>
      assertTransportSecurity(new URL('https://10.0.0.5/token'), internalRoot),
    );
    assert.throws(
      () => assertTransportSecurity(new URL('https://127.0.0.1:8443/x'), internalRoot),
      /refused remotely/u,
    );
    // Privately-RESOLVING names are accepted risk (no resolve here): a
    // hostname passes even under a remote root.
    assert.doesNotThrow(() =>
      assertTransportSecurity(new URL('https://intranet.corp/token'), remoteRoot),
    );
  });

  it('never allows cleartext http off the machine', () => {
    assert.throws(
      () => assertTransportSecurity(new URL('http://api.example.com/mcp'), remoteRoot),
      /non-loopback hosts require https/u,
    );
    assert.throws(
      () => assertTransportSecurity(new URL('http://10.0.0.5/mcp'), loopbackRoot),
      /non-loopback hosts require https/u,
    );
  });

  it('refuses a remotely supplied loopback destination when the server is remote', () => {
    // A remote https server redirecting (or pointing its OAuth metadata) at
    // the user's own machine is a pivot, not a convenience.
    assert.throws(
      () => assertTransportSecurity(new URL('http://127.0.0.1:9999/steal'), remoteRoot),
      /remotely supplied loopback/u,
    );
    assert.throws(
      () => assertTransportSecurity(new URL('http://localhost:22/'), remoteRoot),
      /remotely supplied loopback/u,
    );
  });

  it('allows loopback http when the user configured a loopback trust root', () => {
    assert.doesNotThrow(() =>
      assertTransportSecurity(new URL('http://127.0.0.1:8080/mcp'), loopbackRoot),
    );
    // A local AS on a different loopback port is part of the same local
    // trust decision the user already made.
    assert.doesNotThrow(() =>
      assertTransportSecurity(new URL('http://127.0.0.1:9000/authorize'), loopbackRoot),
    );
  });

  it('refuses non-HTTP schemes outright', () => {
    assert.throws(
      () => assertTransportSecurity(new URL('file:///etc/passwd'), loopbackRoot),
      /non-HTTP/u,
    );
  });
});
