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

export interface CursorCandidatePair {
  departureWeight: number;
  arcWeight: number;
}

function symmetricWeights(count: number): number[] {
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) => index / (count - 1) * 2 - 1);
}

/** Internal normalized candidate pairs consumed by the Maka cubic planner. */
export function cursorCandidatePairs(
  candidateCount: number,
  departureFan: number,
  interrupted: boolean,
): CursorCandidatePair[] {
  if (!interrupted) {
    return symmetricWeights(candidateCount).map((arcWeight) => ({
      departureWeight: 0,
      arcWeight,
    }));
  }

  const departureCount = Math.min(departureFan, candidateCount);
  const directArcCount = candidateCount - (departureCount - 1);
  const directPairs = symmetricWeights(directArcCount).map((arcWeight) => ({
    departureWeight: 0,
    arcWeight,
  }));
  const otherDepartures = Array.from(
    { length: departureCount - 1 },
    (_, index): CursorCandidatePair => ({
      departureWeight: (index + 1) / (departureCount - 1),
      arcWeight: 0,
    }),
  );
  return [...directPairs, ...otherDepartures];
}
