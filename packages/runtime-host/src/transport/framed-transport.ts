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

import type { Socket } from 'node:net';
import {
  FramedByteStreamTransport,
  RuntimeHostTransportError,
  type RuntimeHostByteStream,
} from './framed-byte-stream-transport.js';

export { RuntimeHostTransportError };

export class FramedTransport extends FramedByteStreamTransport {
  constructor(readonly socket: Socket) {
    super(socketByteStream(socket));
  }
}

function socketByteStream(socket: Socket): RuntimeHostByteStream {
  return {
    closed: new Promise((resolve) => socket.once('close', resolve)),
    onData: (listener) => {
      socket.on('data', (chunk) =>
        listener(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
      );
    },
    onEnd: (listener) => {
      socket.once('end', listener);
    },
    onError: (listener) => {
      socket.once('error', listener);
    },
    write: (chunk) =>
      new Promise((resolve, reject) => {
        socket.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
    closeAfterFlush: () => socket.destroySoon(),
    abort: (error) => socket.destroy(error),
    pause: () => socket.pause(),
    resume: () => socket.resume(),
  };
}
