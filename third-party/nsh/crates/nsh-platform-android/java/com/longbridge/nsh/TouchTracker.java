package com.longbridge.nsh;

import android.graphics.Matrix;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;

import java.util.ArrayList;

/**
 * Reports touches to the JS responder system (`onTouch`): one per root view
 * (the surface and each modal), fed by its {@code dispatchTouchEvent}. It
 * also shows the pressed style and ripple of views that have one but no
 * press handler, so they never take the click from the view around them
 * that handles it. A finger is tracked when the view under it, or one
 * around it, listens to touches.
 */
final class TouchTracker {
    private static int nextId;

    private final Mounter mounter;
    private final View root;
    private final ArrayList<Tracked> tracked = new ArrayList<>();
    private final ArrayList<Feedback> feedback = new ArrayList<>();
    // Reused for every event that maps a touch into a feedback view.
    private final Matrix toView = new Matrix();
    private final float[] point = new float[2];

    private static final class Feedback {
        View view;
        Pressable press;
    }

    // The pan gate of the gesture (`panActivation`): the view around the
    // first finger that has one, its offsets (points), where the finger
    // went down (px) and its state: 0 waiting, 1 activated, 2 none or failed.
    private View gate;
    private int gateId, gatePointer, gateState = 2;
    private float[] gateOffsets;
    private float gateX, gateY;

    private static final class Tracked {
        int pointer, id, target;
        View view;
        int[] path;
        float x, y;
        /** Pressure (0 to 1), pen tilt in degrees (the DOM's tiltX / tiltY), pointer kind (0 touch, 1 pen, 2 mouse). */
        float pressure = 0.5f, tiltX, tiltY, kind;
    }

    TouchTracker(Mounter mounter, View root) {
        this.mounter = mounter;
        this.root = root;
    }

    /**
     * A touch event reached the root; returns true when it tracks a finger
     * that went down, or shows press feedback for it (the root then claims
     * the gesture so it hears the rest, the release that ends the feedback
     * included, even if no view takes it).
     */
    boolean onTouch(MotionEvent e) {
        int action = e.getActionMasked();
        boolean observing = observeFeedback(e);
        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_POINTER_DOWN: {
                if (action == MotionEvent.ACTION_DOWN) {
                    tracked.clear();
                    mounter.touchDown(e.getRawX(), e.getRawY());
                }
                if (mounter.touchListeners == 0) return observing;
                int i = e.getActionIndex();
                Tracked t = hit(e.getX(i), e.getY(i));
                if (t == null) return observing;
                t.pointer = e.getPointerId(i);
                t.id = nextId++;
                tracked.add(t);
                if (action == MotionEvent.ACTION_DOWN) findGate(t, e.getX(i), e.getY(i), e.getRawX(), e.getRawY());
                update(e);
                report(0, new int[] {t.id}, true, -1);
                return true;
            }
            case MotionEvent.ACTION_MOVE: {
                if (tracked.isEmpty()) return false;
                if (!update(e)) return false;
                int[] all = new int[tracked.size()];
                for (int i = 0; i < all.length; i++) all[i] = tracked.get(i).id;
                // Decided before the views below see the move, so the scroll
                // views around stop taking it at once.
                report(1, all, false, decideGate(e));
                return false;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP: {
                int pointer = e.getPointerId(e.getActionIndex());
                for (int i = 0; i < tracked.size(); i++) {
                    Tracked t = tracked.get(i);
                    if (t.pointer != pointer) continue;
                    update(e);
                    report(2, new int[] {t.id}, false, -1);
                    tracked.remove(i);
                    break;
                }
                if (tracked.isEmpty()) endGate();
                return false;
            }
            case MotionEvent.ACTION_CANCEL:
                cancelAll();
                return false;
            default:
                return false;
        }
    }

    /**
     * Feeds the views under the finger that show pressed style or a ripple
     * but handle no press. They stay unclickable, so the view around them
     * that handles the press gets the click; the root delivers their
     * feedback instead. Returns whether any is shown.
     */
    private boolean observeFeedback(MotionEvent e) {
        int action = e.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            cancelFeedback();
            View target = deepest(root, e.getX(), e.getY());
            for (View v = target; v != null; ) {
                if (v instanceof Node) {
                    int id = ((Node) v).nodeId();
                    // The first real handler owns its feedback, as a text's
                    // pressable span under the finger owns its press.
                    if (mounter.handlesPress(id) || onLink(v, e)) break;
                    if (mounter.hasPressFeedback(id) && !(v instanceof Box && ((Box) v).pointerEvents == 2)) {
                        Feedback f = new Feedback();
                        f.view = v;
                        f.press = new Pressable(v, mounter, id, true);
                        feedback.add(f);
                    }
                }
                if (v == root) break;
                ViewParent p = v.getParent();
                v = p instanceof View ? (View) p : null;
            }
        } else if (action == MotionEvent.ACTION_POINTER_DOWN || action == MotionEvent.ACTION_CANCEL) {
            cancelFeedback();
            return false;
        }
        boolean observing = !feedback.isEmpty();
        for (int i = feedback.size() - 1; i >= 0; i--) {
            Feedback f = feedback.get(i);
            MotionEvent local = MotionEvent.obtain(e);
            if (toView(f.view, local)) {
                f.press.onTouchEvent(local);
            } else {
                // Its view left the tree mid-press: end its feedback now, as
                // the release would no longer reach it.
                local.setAction(MotionEvent.ACTION_CANCEL);
                f.press.onTouchEvent(local);
                feedback.remove(i);
            }
            local.recycle();
        }
        if (action == MotionEvent.ACTION_UP) feedback.clear();
        return observing;
    }

    /** Whether the touch of {@code e} (root coordinates) is on a pressable span of the text {@code v}. */
    private boolean onLink(View v, MotionEvent e) {
        if (!(v instanceof TextBox) || !((TextBox) v).hasLinks()) return false;
        MotionEvent local = MotionEvent.obtain(e);
        boolean on = toView(v, local) && ((TextBox) v).linkAt(local.getX(), local.getY()) >= 0;
        local.recycle();
        return on;
    }

    /**
     * Maps {@code e} from this root's coordinates into {@code view}'s; false
     * when the view is no longer under this root.
     */
    private boolean toView(View view, MotionEvent e) {
        toView.reset();
        if (!toRoot(view, toView) || !toView.invert(toView)) return false;
        point[0] = e.getX();
        point[1] = e.getY();
        toView.mapPoints(point);
        e.offsetLocation(point[0] - e.getX(), point[1] - e.getY());
        return true;
    }

    /** Maps a descendant's coordinates to this root using APIs available on Android 9. */
    private boolean toRoot(View view, Matrix transform) {
        if (view == root) return true;
        ViewParent parent = view.getParent();
        if (!(parent instanceof View)) return false;
        View p = (View) parent;
        if (!toRoot(p, transform)) return false;
        transform.preTranslate(view.getLeft() - p.getScrollX(), view.getTop() - p.getScrollY());
        if (!view.getMatrix().isIdentity()) transform.preConcat(view.getMatrix());
        return true;
    }

    void cancelFeedback() {
        if (feedback.isEmpty()) return;
        MotionEvent cancel = MotionEvent.obtain(0, android.os.SystemClock.uptimeMillis(),
                MotionEvent.ACTION_CANCEL, 0, 0, 0);
        for (Feedback f : feedback) f.press.onTouchEvent(cancel);
        cancel.recycle();
        feedback.clear();
    }

    /** A native gesture took the touches: JS gets a cancel and no more of them. */
    void cancelAll() {
        cancelFeedback();
        if (tracked.isEmpty()) return;
        int[] all = new int[tracked.size()];
        for (int i = 0; i < all.length; i++) all[i] = tracked.get(i).id;
        report(3, all, false, -1);
        tracked.clear();
        endGate();
    }

    /** The view with a `panActivation` around the first finger's target, if any, that a finger going down at the
     * screen point ({@code rawX}, {@code rawY}) may start. */
    private void findGate(Tracked t, float x, float y, float rawX, float rawY) {
        endGate();
        for (View v = t.view; v != null; ) {
            if (v instanceof Node) {
                float[] offsets = mounter.panActivation(((Node) v).nodeId());
                if (offsets != null && startsAt(offsets, v, rawX, rawY, mounter.density)) {
                    gate = v;
                    gateId = ((Node) v).nodeId();
                    gateOffsets = offsets;
                    gatePointer = t.pointer;
                    gateX = x;
                    gateY = y;
                    gateState = 0;
                    return;
                }
            }
            if (v == root) break;
            ViewParent p = v.getParent();
            v = p instanceof View ? (View) p : null;
        }
    }

    /**
     * Whether the gate's pan activates with this move (`PanActivation::decide`
     * in the core): its node id, else -1.
     */
    private int decideGate(MotionEvent e) {
        if (gateState != 0) return -1;
        int i = e.findPointerIndex(gatePointer);
        if (i < 0) return -1;
        float d = mounter.density;
        Boolean decision = decideActivation(gateOffsets, (e.getX(i) - gateX) / d, (e.getY(i) - gateY) / d);
        if (decision == null) return -1;
        if (!decision) {
            gateState = 2;
            return -1;
        }
        gateState = 1;
        mounter.gateBlock(gate);
        return gateId;
    }

    /**
     * `PanActivation::decide` on a drag by ({@code dx}, {@code dy}) points, for a `panActivation` as
     * {@link Mounter#panActivation} gives it: true activates, false fails, null waits.
     */
    static Boolean decideActivation(float[] a, float dx, float dy) {
        // NaN offsets never compare greater: no limit.
        if (Math.abs(dx) > a[2] || Math.abs(dy) > a[3]) return Boolean.FALSE;
        int way = (int) a[4];
        if (way >= 0) {
            boolean horizontal = way <= 1;
            float along = (way == 1 || way == 3 ? 1 : -1) * (horizontal ? dx : dy);
            float across = Math.abs(horizontal ? dy : dx);
            float active = horizontal ? a[0] : a[1];
            float limit = Float.isNaN(active) ? MIN_PAN_DISTANCE : active;
            if (along > limit && along >= across) return Boolean.TRUE;
            boolean acrossFails = Float.isNaN(horizontal ? a[3] : a[2]) && across > limit && across > along;
            return -along > limit || acrossFails ? Boolean.FALSE : null;
        }
        boolean active = Float.isNaN(a[0]) && Float.isNaN(a[1])
                ? Math.hypot(dx, dy) > MIN_PAN_DISTANCE
                : Math.abs(dx) > a[0] || Math.abs(dy) > a[1];
        return active ? Boolean.TRUE : null;
    }

    /**
     * Whether a pan with `panActivation` {@code a} could still activate for a drag by ({@code dx}, {@code dy})
     * points: it activated, or it waits and the drag heads its way (any way without one).
     */
    static boolean mayActivate(float[] a, float dx, float dy) {
        Boolean decision = decideActivation(a, dx, dy);
        if (decision != null) return decision;
        int way = (int) a[4];
        if (way < 0) return true;
        boolean horizontal = way <= 1;
        float along = (way == 1 || way == 3 ? 1 : -1) * (horizontal ? dx : dy);
        return along > 0 && along >= Math.abs(horizontal ? dy : dx);
    }

    /**
     * `PanActivation::starts_at`: whether a finger going down at the screen point ({@code rawX}, {@code rawY}) px
     * may start the pans of {@code view}, whose `panActivation` is {@code a}: anywhere without an edge, else within
     * `PanActivation::EDGE_WIDTH` of that edge of its window. The system's back gesture keeps the left and right
     * edges under gesture navigation: it takes the swipes it recognizes there, and the pan ends cancelled.
     */
    static boolean startsAt(float[] a, View view, float rawX, float rawY, float density) {
        int edge = (int) a[5];
        if (edge < 0) return true;
        View window = view.getRootView();
        int[] at = new int[2];
        window.getLocationOnScreen(at);
        float x = (rawX - at[0]) / density, y = (rawY - at[1]) / density;
        float w = window.getWidth() / density, h = window.getHeight() / density;
        switch (edge) {
            case 0: return x <= EDGE_WIDTH;
            case 1: return x >= w - EDGE_WIDTH;
            case 2: return y <= EDGE_WIDTH;
            default: return y >= h - EDGE_WIDTH;
        }
    }

    private void endGate() {
        if (gateState == 1) mounter.gateRelease();
        gate = null;
        gateOffsets = null;
        gateState = 2;
    }

    /** `PanActivation::MIN_DISTANCE`: how far a pan without active offsets moves before it activates (points). */
    private static final float MIN_PAN_DISTANCE = 10;

    /** `PanActivation::EDGE_WIDTH`: how far from its edge a finger goes down to start an edge pan (points). */
    private static final float EDGE_WIDTH = 20;

    /** The pressure, tilt and kind of pointer {@code i} of {@code e}. */
    private static void pointer(Tracked t, MotionEvent e, int i) {
        int tool = e.getToolType(i);
        boolean pen = tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER;
        t.kind = pen ? 1 : tool == MotionEvent.TOOL_TYPE_MOUSE ? 2 : 0;
        t.pressure = Math.max(0f, Math.min(1f, e.getPressure(i)));
        if (pen) {
            // AXIS_TILT: radians from the perpendicular; AXIS_ORIENTATION: radians clockwise from up.
            double tan = Math.tan(e.getAxisValue(MotionEvent.AXIS_TILT, i));
            double o = e.getAxisValue(MotionEvent.AXIS_ORIENTATION, i);
            t.tiltX = (float) Math.toDegrees(Math.atan(Math.sin(o) * tan));
            t.tiltY = (float) Math.toDegrees(Math.atan(-Math.cos(o) * tan));
        } else {
            t.tiltX = 0;
            t.tiltY = 0;
        }
    }

    /** Positions of the tracked fingers; false if none moved. */
    private boolean update(MotionEvent e) {
        boolean moved = false;
        for (Tracked t : tracked) {
            int i = e.findPointerIndex(t.pointer);
            if (i < 0) continue;
            float x = e.getX(i), y = e.getY(i);
            moved |= x != t.x || y != t.y;
            t.x = x;
            t.y = y;
            pointer(t, e, i);
        }
        return moved;
    }

    /**
     * phase: 0 start, 1 move, 2 end, 3 cancel. {@code paths}: send the changed fingers' paths;
     * {@code activated}: the node whose pan gate activated, or -1.
     */
    private void report(int phase, int[] changed, boolean paths, int activated) {
        int n = tracked.size();
        int[] ids = new int[n], targets = new int[n], pathLengths = new int[n];
        boolean[] isChanged = new boolean[n];
        float[] coords = new float[n * 8];
        int pathTotal = 0;
        float d = mounter.density;
        int[] rootAt = new int[2], at = new int[2];
        root.getLocationInWindow(rootAt);
        for (int i = 0; i < n; i++) {
            Tracked t = tracked.get(i);
            ids[i] = t.id;
            targets[i] = t.target;
            for (int c : changed) isChanged[i] |= c == t.id;
            if (paths && isChanged[i]) {
                pathLengths[i] = t.path.length;
                pathTotal += t.path.length;
            }
            t.view.getLocationInWindow(at);
            coords[i * 8] = t.x / d;
            coords[i * 8 + 1] = t.y / d;
            coords[i * 8 + 2] = (t.x + rootAt[0] - at[0]) / d;
            coords[i * 8 + 3] = (t.y + rootAt[1] - at[1]) / d;
            coords[i * 8 + 4] = t.pressure;
            coords[i * 8 + 5] = t.tiltX;
            coords[i * 8 + 6] = t.tiltY;
            coords[i * 8 + 7] = t.kind;
        }
        int[] flat = new int[pathTotal];
        for (int i = 0, k = 0; i < n; i++) {
            if (pathLengths[i] == 0) continue;
            System.arraycopy(tracked.get(i).path, 0, flat, k, pathLengths[i]);
            k += pathLengths[i];
        }
        mounter.touches(phase, ids, targets, pathLengths, flat, coords, isChanged, android.os.SystemClock.uptimeMillis(), activated);
    }

    /** The node view under ({@code x}, {@code y}) of the root and the nodes around it listening to touches. */
    private Tracked hit(float x, float y) {
        View target = deepest(root, x, y);
        if (target == null) return null;
        ArrayList<Integer> path = new ArrayList<>();
        View node = null;
        for (View v = target; v != null; ) {
            if (v instanceof Node) {
                int id = ((Node) v).nodeId();
                if (node == null) node = v;
                if (mounter.wants(id, Native.TOUCH)) path.add(id);
            }
            if (v == root) break;
            ViewParent p = v.getParent();
            v = p instanceof View ? (View) p : null;
        }
        if (node == null || path.isEmpty()) return null;
        Tracked t = new Tracked();
        t.view = node;
        t.target = ((Node) node).nodeId();
        t.path = new int[path.size()];
        for (int i = 0; i < t.path.length; i++) t.path[i] = path.get(i);
        return t;
    }

    /** The innermost node view that can take a touch at ({@code x}, {@code y}) of {@code v}. */
    static View deepest(View v, float x, float y) {
        int pointerEvents = v instanceof Box ? ((Box) v).pointerEvents
                : v instanceof InputBox ? ((InputBox) v).pointerEvents : 0;
        if (pointerEvents == 1 || v.getVisibility() != View.VISIBLE) return null;
        if (v instanceof ViewGroup && pointerEvents != 3) {
            ViewGroup g = (ViewGroup) v;
            float[] pt = new float[2];
            for (int i = g.getChildCount() - 1; i >= 0; i--) {
                View c = g.getChildAt(i);
                pt[0] = x + g.getScrollX() - c.getLeft();
                pt[1] = y + g.getScrollY() - c.getTop();
                Matrix m = c.getMatrix();
                if (!m.isIdentity()) {
                    Matrix inverse = new Matrix();
                    if (m.invert(inverse)) inverse.mapPoints(pt);
                }
                boolean inside = pt[0] >= 0 && pt[1] >= 0 && pt[0] < c.getWidth() && pt[1] < c.getHeight();
                // Outside the child, a descendant placed outside it may
                // still be there (`MountItem::Overflow`).
                if (!inside && !(c instanceof Box && ((Box) c).overflow != null && !((Box) c).clip
                        && ((Box) c).overflow.contains(pt[0], pt[1]))) continue;
                View hit = deepest(c, pt[0], pt[1]);
                if (hit != null) return hit;
            }
        }
        if (pointerEvents == 2) return null;
        // Reached through its overflow area: only its descendants count.
        if (x < 0 || y < 0 || x >= v.getWidth() || y >= v.getHeight()) return null;
        return v instanceof Node ? v : null;
    }
}
