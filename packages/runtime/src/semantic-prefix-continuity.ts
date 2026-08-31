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

import type {
  PreparedRequestObservation,
  PreparedRequestObservationSegment,
} from '@maka/core/model-call-attempt';

export type SemanticPrefixContinuity =
  | {
      status: 'no_predecessor' | 'unavailable';
      previousSegmentCount: 0;
      preservedSegmentCount: 0;
    }
  | {
      status: 'preserved' | 'unknown';
      previousSegmentCount: number;
      preservedSegmentCount: number;
    }
  | {
      status: 'diverged';
      previousSegmentCount: number;
      preservedSegmentCount: number;
      firstDivergentSegment: SemanticPrefixSegmentRef;
    };

export type SemanticPrefixSegmentRef = Pick<
  PreparedRequestObservationSegment,
  'kind' | 'index' | 'role' | 'label'
>;

export function deriveSemanticPrefixContinuity(
  currentObservation: PreparedRequestObservation,
  previousObservation: PreparedRequestObservation,
): SemanticPrefixContinuity {
  const current = currentObservation.segments.filter((segment) => segment.cacheable);
  const previous = previousObservation.segments.filter((segment) => segment.cacheable);
  const previousSegmentCount = representedCount(previous);

  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index]!;
    const after = current[index];
    if (!after || !sameIdentity(before, after)) {
      return {
        status: 'diverged',
        previousSegmentCount,
        preservedSegmentCount: representedCount(previous.slice(0, index)),
        firstDivergentSegment: segmentRef(after ?? before),
      };
    }
    if (before.comparison === 'opaque' || after.comparison === 'opaque') {
      return {
        status: 'unknown',
        previousSegmentCount,
        preservedSegmentCount: representedCount(previous.slice(0, index)),
      };
    }
    if (before.digest !== after.digest) {
      return {
        status: 'diverged',
        previousSegmentCount,
        preservedSegmentCount: representedCount(previous.slice(0, index)),
        firstDivergentSegment: segmentRef(after),
      };
    }
  }

  return {
    status: 'preserved',
    previousSegmentCount,
    preservedSegmentCount: previousSegmentCount,
  };
}

function sameIdentity(
  left: PreparedRequestObservationSegment,
  right: PreparedRequestObservationSegment,
): boolean {
  return (
    left.kind === right.kind &&
    left.index === right.index &&
    left.role === right.role &&
    left.label === right.label
  );
}

function representedCount(segments: readonly PreparedRequestObservationSegment[]): number {
  return segments.reduce((count, segment) => count + (segment.representedSegments ?? 1), 0);
}

function segmentRef(segment: PreparedRequestObservationSegment): SemanticPrefixSegmentRef {
  return {
    kind: segment.kind,
    index: segment.index,
    ...(segment.role === undefined ? {} : { role: segment.role }),
    ...(segment.label === undefined ? {} : { label: segment.label }),
  };
}
