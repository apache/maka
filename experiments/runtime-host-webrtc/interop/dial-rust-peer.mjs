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

import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { noise } from '@libp2p/noise'
import { tcp } from '@libp2p/tcp'
import { webRTC } from '@libp2p/webrtc'
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'

const ECHO_PROTOCOL = '/maka/webrtc-phase-zero/echo/1'
const ECHO_PAYLOAD = new TextEncoder().encode('maka-runtime-host-webrtc-phase-zero')
const [address, expectedPeer] = process.argv.slice(2)

if (address == null || expectedPeer == null) {
  throw new Error('usage: node dial-rust-peer.mjs <relay/webrtc multiaddr> <expected peer id>')
}

const node = await createLibp2p({
  transports: [
    tcp(),
    circuitRelayTransport(),
    webRTC()
  ],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: {
    denyDialMultiaddr: () => false
  },
  services: {
    identify: identify()
  }
})

try {
  const connection = await node.dial(multiaddr(address), {
    signal: AbortSignal.timeout(30_000)
  })
  if (connection.remotePeer.toString() !== expectedPeer) {
    throw new Error(`authenticated peer mismatch: expected ${expectedPeer}`)
  }
  if (!connection.remoteAddr.toString().includes('/webrtc')) {
    throw new Error(`expected a WebRTC connection, got ${connection.remoteAddr}`)
  }

  const stream = await connection.newStream(ECHO_PROTOCOL, {
    signal: AbortSignal.timeout(10_000)
  })
  const chunks = []
  const response = (async () => {
    for await (const chunk of stream) {
      chunks.push(chunk.subarray())
    }
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  })()

  stream.send(ECHO_PAYLOAD)
  await stream.close({ signal: AbortSignal.timeout(10_000) })
  const echoed = await response
  if (!ECHO_PAYLOAD.every((byte, index) => echoed[index] === byte) || echoed.length !== ECHO_PAYLOAD.length) {
    throw new Error('echo payload was corrupted')
  }

  console.log(JSON.stringify({
    event: 'success',
    implementation: 'js-libp2p',
    peerId: expectedPeer,
    path: 'webrtc'
  }))
} finally {
  await node.stop()
}
