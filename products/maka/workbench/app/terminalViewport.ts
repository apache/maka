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

type Viewport = {
  metadata: { size: { rows: number }; cursor: { y: number } };
  offset: number;
};

export function createTerminalViewport<T extends Viewport>(
  display: (offset: number, rows: number) => T,
) {
  let followOffset = 0;
  return (offset: number | null, rows: number): T & { followOffset: number } => {
    let frame = display(offset ?? followOffset, rows);
    followOffset = Math.max(
      0,
      frame.metadata.size.rows - Math.max(rows, frame.metadata.cursor.y + 1),
    );
    if (offset === null && frame.offset !== followOffset) {
      frame = display(followOffset, rows);
    }
    return { ...frame, followOffset };
  };
}
