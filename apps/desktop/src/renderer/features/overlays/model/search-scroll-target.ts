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

/**
 * The turn a Search result asked the transcript to scroll to. The nonce tells
 * two picks of the same turn apart; `handled` records that the transcript
 * already scrolled, so a re-render does not scroll again.
 */
export interface SearchScrollTarget {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence?: number;
  readonly nonce: number;
  readonly handled?: boolean;
}

export function consumeSearchScrollTarget(
  current: SearchScrollTarget | null,
  nonce: number,
): SearchScrollTarget | null {
  return current?.nonce === nonce && !current.handled ? { ...current, handled: true } : current;
}
