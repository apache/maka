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

import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createMakaAcpAgent } from './maka-acp-agent.js';

export interface MakaAcpStdioServerInput {
  readonly version: string;
}

export interface MakaAcpStdioServerDependencies {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

export async function runMakaAcpStdioServer(
  input: MakaAcpStdioServerInput,
  dependencies: MakaAcpStdioServerDependencies = {},
): Promise<number> {
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  let stdioError: Error | undefined;
  const recordStdioError = (error: Error) => {
    stdioError ??= error;
  };
  stdin.once('error', recordStdioError);
  stdout.once('error', recordStdioError);
  try {
    const stream = ndJsonStream(
      Writable.toWeb(stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(stdin) as ReadableStream<Uint8Array>,
    );
    const connection = createMakaAcpAgent({ version: input.version }).connect(stream);
    await connection.closed;
    if (stdioError) {
      throw stdioError;
    }
    return 0;
  } finally {
    stdin.off('error', recordStdioError);
    stdout.off('error', recordStdioError);
  }
}
