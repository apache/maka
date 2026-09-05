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

import {
  matchWorkHubSessionName,
  type WorkHubSessionNameMatch,
} from './workhub-creation-intent.js';

/**
 * The shared Session Resolver port.
 *
 * Every WorkHub action that may refer to existing work asks this one capability
 * which visible Sessions a trusted user reference recalls. It answers with
 * ranked candidates, nothing, or ambiguity, and nothing else: it never chooses
 * the action, never returns creation, and never grants execution authority.
 * The action-specific policy decides whether a resolution is sufficient, and
 * the Action Gate revalidates every identity immediately before an effect.
 */
export interface WorkHubSessionResolver {
  resolve(input: WorkHubSessionResolverInput): WorkHubSessionResolution;
}

export interface WorkHubSessionResolverInput {
  readonly reference: WorkHubSessionReference;
  /** The bounded, visible candidate set the caller is permitted to resolve over. */
  readonly sessions: readonly WorkHubResolverSession[];
}

/**
 * A trusted user reference to existing work, carried by Action Intent. It is
 * retrieval evidence only; display text never becomes execution authority.
 */
export interface WorkHubSessionReference {
  readonly text: string;
}

/** One visible existing Session offered to the Resolver as a bounded candidate. */
export interface WorkHubResolverSession {
  /**
   * Opaque Runtime-issued identity. Resolvers select among these references
   * and never invent one from user or model text.
   */
  readonly ref: string;
  readonly sessionName: string;
  readonly projectName: string;
  readonly updatedAt: number;
}

/**
 * Why a candidate was recalled. Evidence explains a recall and authorizes
 * nothing, but it must be rich enough for an action's policy to apply its own
 * rules — so exact naming reports the reference text left over after the name,
 * which stop and correction are each entitled to judge differently.
 */
export type WorkHubSessionResolutionEvidence = Exclude<
  WorkHubSessionNameMatch,
  { readonly kind: 'none' }
>;

export interface WorkHubSessionCandidate {
  readonly ref: string;
  readonly evidence: WorkHubSessionResolutionEvidence;
}

/**
 * Resolution is total: nothing recalled, one ranked list a policy may act on,
 * or an ambiguity a policy must clarify. `create_new` is deliberately absent —
 * creation is a policy decision, never a retrieval result.
 */
export type WorkHubSessionResolution =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'ranked';
      readonly candidates: readonly [WorkHubSessionCandidate, ...WorkHubSessionCandidate[]];
    }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly WorkHubSessionCandidate[] };

/**
 * The temporary deterministic baseline: a reference resolves only when it names
 * one visible Session exactly. Exact display names are conservative retrieval
 * evidence, not the long-term product boundary, and this implementation exists
 * to keep the port real while a ranked resolver is built behind it.
 *
 * It can be removed once every target-bearing WorkHub action resolves through
 * this port, the replacement resolver passes the common routing evaluation, and
 * its rollout retains a tested rollback path.
 */
export function createExactNameSessionResolver(): WorkHubSessionResolver {
  return {
    resolve({ reference, sessions }) {
      const candidates: WorkHubSessionCandidate[] = [];
      for (const session of sessions) {
        const match = matchWorkHubSessionName(reference.text, session.sessionName);
        if (match.kind === 'none') continue;
        candidates.push({ ref: session.ref, evidence: match });
      }
      const [first, ...rest] = candidates;
      if (!first) return { kind: 'none' };
      // Exact naming has no score to separate equals by, so more than one match
      // is ambiguity rather than a ranking a policy could safely act on.
      if (rest.length > 0) return { kind: 'ambiguous', candidates };
      return { kind: 'ranked', candidates: [first] };
    },
  };
}
