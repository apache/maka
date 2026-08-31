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
const [relayAddress] = process.argv.slice(2)

if (relayAddress == null) {
  throw new Error('usage: node answer-rust-peer.mjs <relay multiaddr>')
}

const node = await createLibp2p({
  addresses: {
    listen: ['/p2p-circuit', '/webrtc']
  },
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

let resolveEcho
let rejectEcho
const echoHandled = new Promise((resolve, reject) => {
  resolveEcho = resolve
  rejectEcho = reject
})

await node.handle(ECHO_PROTOCOL, async (stream) => {
  try {
    const request = new Uint8Array(ECHO_PAYLOAD.length)
    let offset = 0
    for await (const chunk of stream) {
      const bytes = chunk.subarray()
      const remaining = request.length - offset
      if (bytes.length > remaining) {
        throw new Error('echo request exceeded the expected size')
      }
      request.set(bytes, offset)
      offset += bytes.length
      if (offset === request.length) {
        break
      }
    }
    if (offset !== request.length || !ECHO_PAYLOAD.every((byte, index) => request[index] === byte)) {
      throw new Error('echo request was corrupted')
    }

    stream.send(request)
    await stream.close({ signal: AbortSignal.timeout(10_000) })
    resolveEcho()
  } catch (error) {
    rejectEcho(error)
  }
})

try {
  await node.dial(multiaddr(relayAddress), {
    signal: AbortSignal.timeout(10_000)
  })

  const deadline = Date.now() + 20_000
  while (!node.getMultiaddrs().some(address => address.toString().includes('/p2p-circuit/webrtc'))) {
    if (Date.now() >= deadline) {
      throw new Error('relay reservation did not yield a WebRTC listen address')
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  console.log(JSON.stringify({
    event: 'ready',
    implementation: 'js-libp2p',
    peerId: node.peerId.toString()
  }))
  await echoHandled
  console.log(JSON.stringify({
    event: 'success',
    implementation: 'js-libp2p',
    peerId: node.peerId.toString(),
    path: 'webrtc'
  }))
} finally {
  await node.stop()
}
