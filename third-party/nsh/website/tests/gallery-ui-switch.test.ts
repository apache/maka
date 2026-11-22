import { expect, test } from 'bun:test';
import { knobTravel, switchGeometries, switchSlop, TOUCH_TARGET } from '../../examples/nsh-gallery-ui/look/switch-geometry';

// The shared switch's knob sits as far from the track's edge on as off, at
// every size, and its hit slop makes a 44-point target on a touch screen.

for (const [name, g] of Object.entries(switchGeometries)) {
  test(`the ${name} switch's knob keeps one gap to the track's edge`, () => {
    const gap = g.border + g.inset;
    // Off: at the start of the content box.
    const off = gap;
    // On: moved by the travel; what is left after the knob to the far edge.
    const on = g.width - (gap + knobTravel(g) + g.knob);
    expect(knobTravel(g)).toBeGreaterThan(0);
    expect(on).toBe(off);
    // Across: the track is the knob and that gap above and below.
    expect(g.height).toBe(g.knob + 2 * gap);
  });

  test(`the ${name} switch's hit slop makes a ${TOUCH_TARGET}-point target`, () => {
    const s = switchSlop(g);
    expect(g.width + s.left + s.right).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(g.height + s.top + s.bottom).toBe(TOUCH_TARGET);
  });
}

test('the sizes are the reviewed ones', () => {
  expect([switchGeometries.pointer.width, switchGeometries.pointer.height, switchGeometries.pointer.knob]).toEqual([28, 16, 12]);
  expect([switchGeometries.regular.width, switchGeometries.regular.height, switchGeometries.regular.knob]).toEqual([42, 24, 20]);
  expect([switchGeometries.small.width, switchGeometries.small.height, switchGeometries.small.knob]).toEqual([34, 20, 16]);
});
