import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  computerUseApprovalSummary,
  COMPUTER_USE_SEMANTIC_ACTIONS,
  CU_ACTION_TYPES,
} from '@maka/core/computer-use';
import { computerParams } from '../computer-use-codec.js';
import { computerWireParams } from '../computer-use-tools.js';

/**
 * The tool takes arguments through two schemas, and they are written by hand.
 *
 * `computerWireParams` is the flat object the SDK validates a model's call
 * against — one shape covering every action, most fields optional.
 * `computerParams` is the strict discriminated union the tool narrows to before
 * it does anything. A field has to exist in both: the first to be accepted off
 * the wire, the second to survive narrowing.
 *
 * `window_action` existed in the union and not on the wire, and was therefore
 * unreachable from the day it shipped. Nothing failed — the SDK rejected those
 * calls above the layer the debug journal records, the unit tests exercised the
 * union directly, and the real-machine probe went around the tool entirely. It
 * took a model saying it had tried the action, and a trace showing no such call
 * had ever been made, to find it.
 *
 * A sample-driven test cannot catch the next one, because the next one will be
 * an action nobody thought to sample. Everything here walks a schema.
 */
type ZodShape = Record<string, unknown>;

function shapeOf(schema: unknown): ZodShape {
  const shape = (schema as { shape?: ZodShape }).shape;
  assert.ok(shape, 'the schema must expose its shape for this check to mean anything');
  return shape;
}

function literalValue(node: unknown): string {
  const literal = node as { value?: unknown; _def?: { value?: unknown } };
  return String(literal?.value ?? literal?._def?.value);
}

function enumValues(node: unknown): string[] {
  const enumerated = node as {
    options?: unknown[];
    _def?: { values?: unknown[]; entries?: Record<string, unknown> };
  };
  const values =
    enumerated.options ?? enumerated._def?.values ?? Object.values(enumerated._def?.entries ?? {});
  assert.ok(Array.isArray(values) && values.length > 0, 'the action field must be an enum');
  return values.map(String);
}

function wireFields(): Set<string> {
  return new Set(Object.keys(shapeOf(computerWireParams)));
}

function wireActions(): string[] {
  return enumValues(shapeOf(computerWireParams).action);
}

function unionArms(): Array<{ action: string; fields: string[] }> {
  return computerParams.options.map((option) => {
    const shape = shapeOf(option);
    return { action: literalValue(shape.action), fields: Object.keys(shape) };
  });
}

/**
 * The same comparison the real checks run, so a negative control exercises the
 * introspection too. A zod upgrade that made `unionArms` return nothing would
 * otherwise pass a hand-built control while the real check quietly stopped
 * looking at anything.
 */
function unreachableFields(
  wire: Set<string>,
  arms: Array<{ action: string; fields: string[] }>,
): Array<{ action: string; missing: string[] }> {
  return arms
    .map(({ action, fields }) => ({ action, missing: fields.filter((f) => !wire.has(f)) }))
    .filter(({ missing }) => missing.length > 0);
}

/**
 * The same comparison the catalog check runs, so its negative control exercises
 * the real comparator rather than a hand-built copy of it.
 */
function catalogNotOnWire(catalog: ReadonlySet<string>, wire: ReadonlySet<string>): string[] {
  return [...catalog].filter((action) => !wire.has(action));
}

describe('the two argument schemas describe the same tool', () => {
  test('every field an action accepts can reach it through the wire', () => {
    assert.deepEqual(
      unreachableFields(wireFields(), unionArms()),
      [],
      'these fields exist in the union and not on the wire, so a model cannot send them',
    );
  });

  test('the action names match in both directions', () => {
    // Both directions, because each is a different failure. An arm the wire
    // cannot name is unreachable — the `window_action` case. A wire name with
    // no arm is accepted off the wire and then falls through narrowing, which
    // reaches the model as a validation error naming nothing it did wrong.
    const wire = new Set(wireActions());
    const arms = new Set(unionArms().map(({ action }) => action));

    assert.deepEqual(
      [...arms].filter((action) => !wire.has(action)),
      [],
      'the union names actions the wire cannot carry',
    );
    assert.deepEqual(
      [...wire].filter((action) => !arms.has(action)),
      [],
      'the wire accepts actions the union cannot narrow',
    );
  });

  test('every action survives the approval summary as itself', () => {
    // A third handwritten catalog. `computerUseApprovalSummary` downgrades an
    // action it does not know to `unknown`, and that value is what lands in the
    // persisted audit record and what turn-level remember is keyed on. An
    // action added to both schemas passes the checks above while silently
    // degrading those consumers, which is the same class of gap one layer over.
    const degraded = unionArms()
      .map(({ action }) => ({ action, summarized: computerUseApprovalSummary({ action }).action }))
      .filter(({ action, summarized }) => summarized !== action);

    assert.deepEqual(
      degraded,
      [],
      'these actions are recorded as "unknown" in the audit trail and cannot be remembered',
    );
  });

  test('the approval catalog names exactly the actions the wire carries', () => {
    // The check above walks from the schemas to the catalog and catches a name
    // the catalog is missing. This walks the other way, and catches a name the
    // catalog has that the schemas do not.
    //
    // That direction is quieter and costs more. `COMPUTER_USE_SEMANTIC_ACTIONS`
    // feeds `APPROVAL_ACTIONS`, which is what decides `knownAction`. A name
    // listed there and absent from the wire enum makes the approval summary and
    // the model-facing record of the call report an action the SDK rejects
    // before the tool ever runs, as though it were a call that had been taken —
    // and makes `rememberForTurnAllowed` true for it. Nothing fails; a person
    // reads an approval for an action that did not happen, and the model reads
    // its own history as proof that the name works.
    const wire = new Set(wireActions());
    const catalog = new Set<string>([...COMPUTER_USE_SEMANTIC_ACTIONS, ...CU_ACTION_TYPES]);

    assert.deepEqual(
      catalogNotOnWire(catalog, wire),
      [],
      'the approval catalog names actions the tool will reject',
    );
    assert.deepEqual(
      [...wire].filter((action) => !catalog.has(action)),
      [],
      'the wire carries actions the approval catalog records as "unknown"',
    );
  });
});
