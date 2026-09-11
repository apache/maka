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

export type SerializedOperationExecutor<Context> = <T>(
  operation: (context: Context) => Promise<T>,
) => Promise<T>;

/**
 * Admits an operation into its owner before waiting for earlier operations.
 * This lets owner shutdown observe and drain every accepted reservation.
 */
export class SerializedOperationLane<Context> {
  readonly #execute: SerializedOperationExecutor<Context>;
  #tail: Promise<void> = Promise.resolve();

  constructor(execute: SerializedOperationExecutor<Context>) {
    this.#execute = execute;
  }

  run<T>(operation: (context: Context) => Promise<T>): Promise<T> {
    const ready = this.#tail;
    let releaseTail!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseTail();
    };
    let entered = false;
    let execution: Promise<T>;
    try {
      execution = this.#execute(async (context) => {
        entered = true;
        await ready;
        try {
          return await operation(context);
        } finally {
          release();
        }
      });
    } catch (error) {
      release();
      throw error;
    }
    return execution.finally(() => {
      if (!entered) release();
    });
  }
}
