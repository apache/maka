package com.longbridge.nsh;

import android.text.Layout;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;

/**
 * A selectable view (`ViewProps.selectable_view`): one selection across the
 * texts of the view's subtree that are not `selectable={false}`, in
 * document order (an area inside another is part of the outer one).
 *
 * <p>The selection itself (which text, which offset, words, handles, what a
 * copy gives) is nsh-core's model, run in Rust on this thread through JNI
 * (`selectable_view.rs`), so every backend selects alike; this class finds
 * the texts, turns touches into its gestures and draws what it selected.
 * The texts' content goes over when it changes, their frames (area
 * coordinates, dp) with every gesture; the model hit-tests through
 * {@link #offsetAt}. A long press on a text of the area selects the word
 * there and the rest of the gesture extends the selection; the handles
 * ({@link SelectionHandle}) move its ends; the floating toolbar copies,
 * selects all or shares; a touch elsewhere ends it. One selection per
 * surface: a text's own ({@link TextBox}) or an area's.
 */
final class SelectableView implements SelectionHandle.Owner {
    // `nativeGesture`'s kinds (`selectable_view.rs`).
    private static final int SELECT_WORD = 0;
    private static final int DRAG = 1;
    private static final int MOVE_START = 2;
    private static final int MOVE_END = 3;
    private static final int SELECT_ALL = 4;

    private static native long nativeCreate();

    private static native void nativeDestroy(long handle);

    private static native boolean nativeSetTexts(long handle, SelectableView area, String[] contents, int[] keys, float[] frames);

    private static native boolean nativeGesture(long handle, SelectableView area, float[] frames, int kind, float x, float y);

    private static native int[] nativeRanges(long handle, SelectableView area);

    private static native int[] nativeBounds(long handle);

    private static native String nativeText(long handle, SelectableView area);

    private final Mounter mounter;
    /** The area's view. */
    final View view;
    /** The native model while there is a selection, else 0. */
    private long handle;
    /** The texts taking part, in document order (while there is a selection). */
    private final java.util.ArrayList<TextBox> texts = new java.util.ArrayList<>();
    /** Each text's content origin in the area (px, x and y), as of the last frames. */
    private float[] origins = new float[0];
    /** The texts drawing a highlight. */
    private final java.util.ArrayList<TextBox> highlighted = new java.util.ArrayList<>();
    private SelectionHandle startHandle, endHandle;
    /** A dragged handle passed the other: each marks the other end until the finger lifts. */
    private boolean swapped;
    private android.view.ActionMode mode;
    /** The text the touch went down on, and where (screen). */
    private TextBox touched;
    private float downX, downY;
    /** The long press selected: the rest of the gesture extends the selection. */
    private boolean extending;
    private boolean recollectPosted;
    private android.view.ViewTreeObserver observer;
    private final int[] at = new int[2], at2 = new int[2];
    private final android.graphics.Path path = new android.graphics.Path();
    private final Runnable longPress = this::selectWordAtDown;
    private final Runnable recollect = this::recollect;
    private final android.view.ViewTreeObserver.OnPreDrawListener follow = () -> {
        placeHandles();
        return true;
    };

    SelectableView(Mounter mounter, View view) {
        this.mounter = mounter;
        this.view = view;
    }

    /** Whether the long press selected and the gesture goes on (presses are cancelled). */
    boolean selecting() {
        return extending;
    }

    /** A touch on {@code text}, one of the area's: the area's gestures. */
    boolean onTextTouch(TextBox text, MotionEvent e) {
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                touched = text;
                downX = e.getRawX();
                downY = e.getRawY();
                // A tap ends the selection (a long press makes a new one).
                clear();
                view.postDelayed(longPress, android.view.ViewConfiguration.getLongPressTimeout());
                break;
            case MotionEvent.ACTION_MOVE: {
                if (extending) {
                    float[] p = toArea(e.getRawX(), e.getRawY());
                    gesture(DRAG, p[0], p[1]);
                    break;
                }
                float slop = android.view.ViewConfiguration.get(view.getContext()).getScaledTouchSlop();
                if (Math.hypot(e.getRawX() - downX, e.getRawY() - downY) > slop) view.removeCallbacks(longPress);
                break;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                view.removeCallbacks(longPress);
                if (extending) {
                    extending = false;
                    showToolbar();
                }
                break;
            default:
                break;
        }
        return true;
    }

    /** The long press: selects the word under the finger. */
    private void selectWordAtDown() {
        if (!view.isAttachedToWindow() || !begin()) return;
        float[] p = toArea(downX, downY);
        gesture(SELECT_WORD, p[0], p[1]);
        if (empty()) {
            clear();
            return;
        }
        if (touched != null) {
            touched.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS);
            // Scroll views around keep out of the rest of the gesture.
            if (touched.getParent() != null) touched.getParent().requestDisallowInterceptTouchEvent(true);
        }
        extending = true;
    }

    /** Starts a selection: the texts, the model, this surface's only selection. */
    private boolean begin() {
        collect();
        if (texts.isEmpty()) return false;
        if (handle == 0) handle = nativeCreate();
        nativeSetTexts(handle, this, contents(), keys(), frames());
        if (mounter.selectedText != null) mounter.selectedText.clearSelection();
        if (mounter.selectedArea != null && mounter.selectedArea != this) mounter.selectedArea.clear();
        mounter.selectedArea = this;
        observer = view.getViewTreeObserver();
        observer.addOnPreDrawListener(follow);
        return true;
    }

    /** Ends the selection, its highlight, handles and toolbar. */
    void clear() {
        view.removeCallbacks(longPress);
        extending = false;
        if (handle == 0) return;
        long h = handle;
        handle = 0;
        for (TextBox t : highlighted) t.setAreaSelection(-1, -1);
        highlighted.clear();
        texts.clear();
        swapped = false;
        if (startHandle != null) {
            startHandle.dismiss();
            endHandle.dismiss();
        }
        if (observer != null && observer.isAlive()) observer.removeOnPreDrawListener(follow);
        observer = null;
        if (mounter.selectedArea == this) mounter.selectedArea = null;
        android.view.ActionMode m = mode;
        mode = null;
        if (m != null) m.finish();
        nativeDestroy(h);
    }

    /** Whether the screen point is on one of the handles (a touch there keeps the selection). */
    boolean selectionContains(float rawX, float rawY) {
        return startHandle != null && (startHandle.contains(rawX, rawY) || endHandle.contains(rawX, rawY));
    }

    /** A text got new content or left the window: the selection follows the area's texts. */
    void textChanged(TextBox text) {
        if (handle == 0 || recollectPosted) return;
        if (!texts.contains(text) && !inside(text)) return;
        // After the batch: the views it inserts are in place by then.
        recollectPosted = true;
        view.post(recollect);
    }

    private boolean inside(View v) {
        for (Object p = v; p instanceof View; p = ((View) p).getParent()) {
            if (p == view) return true;
        }
        return false;
    }

    private void recollect() {
        recollectPosted = false;
        if (handle == 0) return;
        if (!view.isAttachedToWindow()) {
            clear();
            return;
        }
        collect();
        if (texts.isEmpty()) {
            clear();
            return;
        }
        nativeSetTexts(handle, this, contents(), keys(), frames());
        update();
        if (empty() && !extending) clear();
    }

    /** The texts of the subtree that take part, depth first. */
    private void collect() {
        texts.clear();
        collect(view);
    }

    private void collect(View v) {
        if (v instanceof TextBox) {
            TextBox t = (TextBox) v;
            if (!t.excluded && t.layout() != null) texts.add(t);
        }
        if (v instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) v;
            for (int i = 0, n = group.getChildCount(); i < n; i++) collect(group.getChildAt(i));
        }
    }

    /** The texts' view ids: the model keeps a selection on its texts as others come and go. */
    private int[] keys() {
        int[] out = new int[texts.size()];
        for (int i = 0; i < out.length; i++) out[i] = texts.get(i).id;
        return out;
    }

    private String[] contents() {
        String[] out = new String[texts.size()];
        for (int i = 0; i < out.length; i++) out[i] = texts.get(i).layout().getText().toString();
        return out;
    }

    /** The texts' content boxes in the area (dp: x, y, width, height each); updates {@link #origins}. */
    private float[] frames() {
        int n = texts.size();
        if (origins.length != n * 2) origins = new float[n * 2];
        float[] out = new float[n * 4];
        float d = mounter.density;
        view.getLocationOnScreen(at);
        for (int i = 0; i < n; i++) {
            TextBox t = texts.get(i);
            t.getLocationOnScreen(at2);
            float x = at2[0] - at[0] + t.contentX(), y = at2[1] - at[1] + t.contentY();
            origins[i * 2] = x;
            origins[i * 2 + 1] = y;
            out[i * 4] = x / d;
            out[i * 4 + 1] = y / d;
            out[i * 4 + 2] = t.contentWidth() / d;
            out[i * 4 + 3] = t.contentHeight() / d;
        }
        return out;
    }

    /** A screen point in the area (dp). */
    private float[] toArea(float rawX, float rawY) {
        view.getLocationOnScreen(at);
        float d = mounter.density;
        return new float[] {(rawX - at[0]) / d, (rawY - at[1]) / d};
    }

    /**
     * The model's hit test (called from Rust within a native call): the
     * UTF-16 offset of text {@code i} nearest the area point ({@code x},
     * {@code y}) in dp.
     */
    int offsetAt(int i, float x, float y) {
        if (i < 0 || i >= texts.size() || i * 2 + 1 >= origins.length) return 0;
        Layout layout = texts.get(i).layout();
        if (layout == null) return 0;
        float d = mounter.density;
        // The area's dp to the text's content box in px, where the layout is.
        return TextLayouts.hitOffset(
                TextLayouts.hitTest(layout, x * d - origins[i * 2], y * d - origins[i * 2 + 1], 1f));
    }

    /** Runs a gesture of the model at the area point ({@code x}, {@code y}); redraws when it changed. */
    private boolean gesture(int kind, float x, float y) {
        if (handle == 0) return false;
        boolean changed = nativeGesture(handle, this, frames(), kind, x, y);
        if (changed) update();
        return changed;
    }

    private int[] bounds() {
        if (handle == 0) return null;
        int[] b = nativeBounds(handle);
        return b != null && b.length == 4 ? b : null;
    }

    private boolean empty() {
        return bounds() == null;
    }

    /** Draws what the model selected: each text's highlight, the handles, the toolbar's place. */
    private void update() {
        if (handle == 0) return;
        int[] ranges = nativeRanges(handle, this);
        java.util.ArrayList<TextBox> now = new java.util.ArrayList<>();
        if (ranges != null) {
            for (int i = 0; i + 2 < ranges.length; i += 3) {
                if (ranges[i] < 0 || ranges[i] >= texts.size()) continue;
                TextBox t = texts.get(ranges[i]);
                t.setAreaSelection(ranges[i + 1], ranges[i + 2]);
                now.add(t);
            }
        }
        for (TextBox t : highlighted) {
            if (!now.contains(t)) t.setAreaSelection(-1, -1);
        }
        highlighted.clear();
        highlighted.addAll(now);
        placeHandles();
        if (mode != null) mode.invalidateContentRect();
    }

    /** Puts the handles at the selection's ends (hiding those off screen). */
    private void placeHandles() {
        if (handle == 0 || !view.isAttachedToWindow()) return;
        int[] b = bounds();
        if (b == null || !view.isShown() || b[0] >= texts.size() || b[2] >= texts.size()) {
            if (startHandle != null) {
                startHandle.dismiss();
                endHandle.dismiss();
            }
            return;
        }
        TextBox start = texts.get(b[0]), end = texts.get(b[2]);
        if (startHandle == null) {
            Integer color = start.selectionColor();
            startHandle = new SelectionHandle(view, true, color, this);
            endHandle = new SelectionHandle(view, false, color, this);
        }
        // While a dragged handle has passed the other, each marks the other end.
        SelectionHandle forStart = swapped ? endHandle : startHandle, forEnd = swapped ? startHandle : endHandle;
        Layout layout = start.layout();
        if (layout == null || !start.isShown()) {
            forStart.dismiss();
        } else {
            int offset = Math.min(b[1], layout.getText().length());
            start.getLocationInWindow(at);
            forStart.place(at[0] + start.contentX() + layout.getPrimaryHorizontal(offset),
                    at[1] + start.contentY() + layout.getLineBottom(layout.getLineForOffset(offset)));
        }
        layout = end.layout();
        if (layout == null || !end.isShown()) {
            forEnd.dismiss();
        } else {
            int offset = Math.min(b[3], layout.getText().length());
            int line = layout.getLineForOffset(offset);
            float x;
            if (line > 0 && offset == layout.getLineStart(line)) {
                // The selection ends at a line break: its handle stays on the line it covers.
                line--;
                x = layout.getLineRight(line);
            } else {
                x = layout.getPrimaryHorizontal(offset);
            }
            end.getLocationInWindow(at);
            forEnd.place(at[0] + end.contentX() + x, at[1] + end.contentY() + layout.getLineBottom(line));
        }
    }

    @Override
    public void handleDown() {
        if (mode != null) mode.hide(android.view.ViewConfiguration.getDefaultActionModeHideDuration());
    }

    @Override
    public void handleMoved(boolean start, float x, float y) {
        int[] before = bounds();
        if (before == null) return;
        boolean moveStart = start != swapped;
        view.getLocationInWindow(at);
        float d = mounter.density;
        // Just above the line's bottom: the line the handle hangs from.
        gesture(moveStart ? MOVE_START : MOVE_END, (x - at[0]) / d, (y - at[1]) / d - 2);
        int[] after = bounds();
        if (after == null) return;
        // The end that stayed is now on the other side: the handles passed.
        boolean passed = moveStart
                ? after[0] == before[2] && after[1] == before[3] && !(after[2] == before[2] && after[3] == before[3])
                : after[2] == before[0] && after[3] == before[1] && !(after[0] == before[0] && after[1] == before[1]);
        if (passed) {
            swapped = !swapped;
            placeHandles();
        }
    }

    @Override
    public void handleUp() {
        if (swapped) {
            swapped = false;
            placeHandles();
        }
        if (empty()) clear();
        else showToolbar();
    }

    private boolean selectsAll(int[] b) {
        int last = texts.size() - 1;
        if (b == null || last < 0) return false;
        Layout layout = texts.get(last).layout();
        return b[0] == 0 && b[1] == 0 && b[2] == last && layout != null && b[3] >= layout.getText().length();
    }

    private void showToolbar() {
        if (handle == 0 || empty()) return;
        if (mode != null) {
            mode.invalidateContentRect();
            mode.hide(0);
            return;
        }
        mode = view.startActionMode(new android.view.ActionMode.Callback2() {
            @Override
            public boolean onCreateActionMode(android.view.ActionMode m, android.view.Menu menu) {
                menu.add(android.view.Menu.NONE, android.R.id.copy, 0, android.R.string.copy)
                        .setAlphabeticShortcut('c');
                menu.add(android.view.Menu.NONE, android.R.id.selectAll, 1, android.R.string.selectAll)
                        .setAlphabeticShortcut('a');
                // The system's own "Share" label (TextView's), as TextBox's toolbar.
                android.content.res.Resources system = android.content.res.Resources.getSystem();
                int share = system.getIdentifier("share", "string", "android");
                if (share != 0) menu.add(android.view.Menu.NONE, android.R.id.shareText, 2, system.getString(share));
                return true;
            }

            @Override
            public boolean onPrepareActionMode(android.view.ActionMode m, android.view.Menu menu) {
                menu.findItem(android.R.id.selectAll).setVisible(!selectsAll(bounds()));
                return true;
            }

            @Override
            public boolean onActionItemClicked(android.view.ActionMode m, android.view.MenuItem item) {
                if (handle == 0) return false;
                int itemId = item.getItemId();
                if (itemId == android.R.id.copy) {
                    SystemUi.setClipboard(view.getContext(), nativeText(handle, SelectableView.this));
                    clear();
                    return true;
                }
                if (itemId == android.R.id.selectAll) {
                    gesture(SELECT_ALL, 0, 0);
                    m.invalidate();
                    return true;
                }
                if (itemId == android.R.id.shareText) {
                    android.content.Context context = view.getContext();
                    android.content.Intent send = new android.content.Intent(android.content.Intent.ACTION_SEND)
                            .setType("text/plain")
                            .putExtra(android.content.Intent.EXTRA_TEXT, nativeText(handle, SelectableView.this));
                    android.content.Intent chooser = android.content.Intent.createChooser(send, null);
                    if (!(context instanceof android.app.Activity)) {
                        chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    }
                    try {
                        context.startActivity(chooser);
                    } catch (android.content.ActivityNotFoundException ignored) {
                        // Nothing can share text.
                    }
                    clear();
                    return true;
                }
                return false;
            }

            @Override
            public void onDestroyActionMode(android.view.ActionMode m) {
                // Closed by the system (back, a tap elsewhere): the selection goes too.
                if (mode == m) {
                    mode = null;
                    clear();
                }
            }

            @Override
            public void onGetContentRect(android.view.ActionMode m, View v, android.graphics.Rect out) {
                // The highlighted parts, in the area's coordinates.
                android.graphics.RectF all = null, part = new android.graphics.RectF();
                view.getLocationInWindow(at);
                int ax = at[0], ay = at[1];
                if (handle != 0) {
                    int[] ranges = nativeRanges(handle, SelectableView.this);
                    for (int i = 0; ranges != null && i + 2 < ranges.length; i += 3) {
                        if (ranges[i] < 0 || ranges[i] >= texts.size()) continue;
                        TextBox t = texts.get(ranges[i]);
                        Layout layout = t.layout();
                        if (layout == null || !t.isShown()) continue;
                        int length = layout.getText().length();
                        layout.getSelectionPath(Math.min(ranges[i + 1], length), Math.min(ranges[i + 2], length), path);
                        path.computeBounds(part, true);
                        t.getLocationInWindow(at2);
                        part.offset(at2[0] - ax + t.contentX(), at2[1] - ay + t.contentY());
                        if (all == null) all = new android.graphics.RectF(part);
                        else all.union(part);
                    }
                }
                if (all == null) out.set(0, 0, view.getWidth(), view.getHeight());
                else out.set(Math.round(all.left), Math.round(all.top), Math.round(all.right), Math.round(all.bottom));
            }
        }, android.view.ActionMode.TYPE_FLOATING);
    }
}
