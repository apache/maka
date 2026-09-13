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

import { useRef } from 'react';
import type { TurnViewModel } from './materialize.js';
import {
  createTranscriptProjection,
  type TranscriptProjection,
  type TranscriptProjectionInput,
} from './transcript-projection.js';

/**
 * Render-time access to the session's incremental transcript projection.
 *
 * Projecting during render (rather than in an effect) keeps the turns the
 * component renders and the turns the projection last produced the same object
 * graph — an effect would publish them a commit late and reintroduce the very
 * re-derivation this replaces. It is safe under React's double-invocation
 * because `project` is idempotent: identical inputs return the identical
 * turns array without advancing any owned state.
 */
export function useTranscriptProjection(
  input: TranscriptProjectionInput,
): readonly TurnViewModel[] {
  const projection = useRef<TranscriptProjection>(undefined);
  projection.current ??= createTranscriptProjection();
  return projection.current.project(input);
}
