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

// Test-only reader for the model-facing observation text.
//
// Production has no parser for this format and should not grow one: the text
// exists to be read by a model, and the ids the model quotes back come from a
// tool call, not from re-parsing our own output. Tests are the exception —
// several of them drive a full model loop and need the `observation_id` and
// element ids that the loop just handed the model.
//
// Kept in one place because four suites need it and four copies of a parser is
// four chances to disagree about the format under test. One of those suites is
// in @maka/computer-use, which reaches it through the
// `@maka/runtime/test-only/observation-text-reader` entry point rather than by
// carrying its own copy — that suite went red on this PR precisely because it
// had its own `JSON.parse`.

export interface ParsedObservationElement {
  element_id: string;
  role: string;
  label?: string;
  value?: string;
}

export interface ParsedObservation {
  observation_id: string;
  elements: ParsedObservationElement[];
}

/** Parse one rendered observation, or undefined when the text is not one. */
export function parseObservationText(text: string): ParsedObservation | undefined {
  const lines = text.split('\n');
  const headerIndex = lines.findIndex((line) => line.startsWith('observation_id='));
  if (headerIndex < 0) return undefined;
  const observationId = /observation_id=(\S+)/.exec(lines[headerIndex] ?? '')?.[1];
  if (!observationId) return undefined;

  const elements: ParsedObservationElement[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const body = line.replace(/^\t+/, '');
    const match = /^(\S+) (\S+)(.*)$/.exec(body);
    if (!match) break;
    const [, elementId, role, rest = ''] = match;
    if (!elementId || !role) break;
    const label = /^ ("(?:[^"\\]|\\.)*")/.exec(rest)?.[1];
    const value = / =("(?:[^"\\]|\\.)*")/.exec(rest)?.[1];
    elements.push({
      element_id: elementId,
      role,
      ...(label ? { label: JSON.parse(label) as string } : {}),
      ...(value !== undefined ? { value: JSON.parse(value) as string } : {}),
    });
  }
  return { observation_id: observationId, elements };
}

/**
 * Find the most recent observation anywhere in a model prompt.
 *
 * An action result appends its fresh observation after a `Fresh observation:`
 * marker, so a single string can carry both the action outcome and the next
 * observation; the marker is where the second one starts.
 */
export function latestObservationIn(prompt: unknown): ParsedObservation | undefined {
  const found = stringsIn(prompt).flatMap((text) => {
    const marker = text.lastIndexOf('Fresh observation:\n');
    const candidates = marker >= 0 ? [text.slice(marker + 'Fresh observation:\n'.length)] : [text];
    return candidates.flatMap((candidate) => {
      const parsed = parseObservationText(candidate);
      return parsed ? [parsed] : [];
    });
  });
  return found.at(-1);
}

/**
 * Every string anywhere in a prompt structure, including the ones nested
 * inside serialized JSON.
 *
 * A tool result reaches the provider as a JSON string holding a content array,
 * so the observation arrives with its newlines escaped and is not a line-based
 * document until that layer is undone.
 */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return [value];
    try {
      return [value, ...stringsIn(JSON.parse(value))];
    } catch {
      return [value];
    }
  }
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(stringsIn);
}
