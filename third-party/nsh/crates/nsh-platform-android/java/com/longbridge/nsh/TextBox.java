package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.text.Layout;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * Draws a StaticLayout made on the engine thread: no text layout here. A
 * group: the views of its attachments (views and images inside the text)
 * are its children, placed on their placeholders by the core.
 */
@SuppressLint("ViewConstructor")
final class TextBox extends android.view.ViewGroup implements Node {
    final Decor decor = new Decor();
    final int id;
    boolean clip;
    /** Accessibility from the app's properties, if any. */
    A11y a11y;
    private Layout layout;
    private float contentX, contentY, contentWidth, contentHeight;

    /** Press handling, once the view has press listeners. */
    Pressable press;

    private final Mounter mounter;

    TextBox(Context context, Mounter mounter, int id) {
        super(context);
        this.id = id;
        this.mounter = mounter;
        setWillNotDraw(false);
        setClipChildren(false);
        setBackground(decor);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
    }

    @Override
    public int nodeId() {
        return id;
    }

    /** Attachments are placed by the core (`Box.place`). */
    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {}

    @Override
    public boolean shouldDelayChildPressedState() {
        return false;
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        decor.applyPivot(this);
    }

    // Selection (`selectable`): a long press selects the word under the
    // finger and shows the floating toolbar (Copy, Select all, Share); the
    // handles (popups, like TextView's, so they are not clipped and take
    // their own touches) move its ends. Text that is not selectable pays
    // nothing: no state, no listener, one check in onDraw.

    /** `selectable`. */
    private boolean selectable;
    /** `selectable={false}`: out of selectable views too. */
    boolean excluded;
    /** The selectable view whose gesture this touch is ({@link SelectableView}), if any. */
    private SelectableView areaGesture;
    /** What a selectable view has selected here (UTF-16 offsets), or -1. */
    private int areaStart = -1, areaEnd = -1;
    /** `selectionColor`: the highlight and the handles' tint; null: the theme's. */
    private Integer selectionColor;
    /** The selection (UTF-16 offsets), or -1 when there is none. */
    private int selStart = -1, selEnd = -1;
    private android.view.ActionMode mode;
    private SelectionHandle startHandle, endHandle;
    private android.graphics.Paint highlightPaint;
    private final android.graphics.Path selectionPath = new android.graphics.Path();
    private float downX, downY;
    /** The long press selected: the rest of the gesture moves the selection's end. */
    private boolean extending;
    /** The word the long press selected. */
    private int anchorStart, anchorEnd;
    private final Runnable longPress = this::selectWordAtDown;
    private final android.view.ViewTreeObserver.OnPreDrawListener follow = () -> {
        placeHandles();
        return true;
    };

    void setSelectable(boolean selectable, boolean excluded, Integer selectionColor) {
        if (!selectable) clearSelection();
        boolean recolor = !java.util.Objects.equals(this.selectionColor, selectionColor);
        this.selectable = selectable;
        this.excluded = excluded;
        this.selectionColor = selectionColor;
        if (recolor) {
            highlightPaint = null;
            if (startHandle != null) startHandle.tint(selectionColor);
            if (endHandle != null) endHandle.tint(selectionColor);
            if (selStart >= 0 || areaStart >= 0) invalidate();
        }
    }

    Layout layout() {
        return layout;
    }

    float contentX() {
        return contentX;
    }

    float contentY() {
        return contentY;
    }

    float contentWidth() {
        return contentWidth;
    }

    float contentHeight() {
        return contentHeight;
    }

    Integer selectionColor() {
        return selectionColor;
    }

    /** What a selectable view selected here: [{@code start}, {@code end}), or -1, -1. */
    void setAreaSelection(int start, int end) {
        if (start == areaStart && end == areaEnd) return;
        areaStart = start;
        areaEnd = end;
        invalidate();
    }

    /** Hands the touch to the press listeners, or cancels their press once a selection took over. */
    private void forwardPress(android.view.MotionEvent e, boolean selecting) {
        if (press == null) return;
        if (selecting) {
            // The long press selected: the press is over.
            android.view.MotionEvent cancel = android.view.MotionEvent.obtain(e);
            cancel.setAction(android.view.MotionEvent.ACTION_CANCEL);
            press.onTouchEvent(cancel);
            cancel.recycle();
        } else {
            press.onTouchEvent(e);
        }
    }

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    @Override
    public boolean onTouchEvent(android.view.MotionEvent e) {
        // In a selectable view, the area selects (across its texts), not the text.
        if (e.getActionMasked() == android.view.MotionEvent.ACTION_DOWN) {
            areaGesture = excluded ? null : mounter.selectableViewOf(this);
        }
        if (areaGesture != null) {
            forwardPress(e, areaGesture.selecting());
            return areaGesture.onTextTouch(this, e);
        }
        if (!selectable) return press != null && press.onTouchEvent(e);
        forwardPress(e, extending);
        switch (e.getActionMasked()) {
            case android.view.MotionEvent.ACTION_DOWN:
                downX = e.getX();
                downY = e.getY();
                extending = false;
                // A tap on the text ends its selection (a long press makes a new one).
                clearSelection();
                postDelayed(longPress, android.view.ViewConfiguration.getLongPressTimeout());
                break;
            case android.view.MotionEvent.ACTION_MOVE: {
                if (extending) {
                    // From the word first selected to the finger, either way.
                    int offset = offsetAt(e.getX(), e.getY());
                    if (offset >= 0 && offset < anchorStart) setSelection(offset, anchorEnd, false);
                    else if (offset >= 0) setSelection(anchorStart, Math.max(offset, anchorEnd), false);
                    break;
                }
                float slop = android.view.ViewConfiguration.get(getContext()).getScaledTouchSlop();
                if (Math.hypot(e.getX() - downX, e.getY() - downY) > slop) removeCallbacks(longPress);
                break;
            }
            case android.view.MotionEvent.ACTION_UP:
            case android.view.MotionEvent.ACTION_CANCEL:
                removeCallbacks(longPress);
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
        if (layout == null || layout.getText().length() == 0) return;
        long hit = hitAt(downX, downY);
        // The character under the finger: the one before a caret at a wrapped line's end.
        int offset = TextLayouts.hitOffset(hit) - (TextLayouts.hitUpstream(hit) ? 1 : 0);
        if (offset < 0) return;
        CharSequence text = layout.getText();
        int length = text.length();
        int at = Math.min(offset, length - 1);
        java.text.BreakIterator words = java.text.BreakIterator.getWordInstance();
        words.setText(text.toString());
        int start = words.preceding(at + 1), end = words.following(at);
        if (start == java.text.BreakIterator.DONE) start = 0;
        if (end == java.text.BreakIterator.DONE) end = length;
        if (end <= start) end = Math.min(length, start + 1);
        performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS);
        // Scroll views around keep out of the rest of the gesture.
        if (getParent() != null) getParent().requestDisallowInterceptTouchEvent(true);
        extending = true;
        anchorStart = start;
        anchorEnd = end;
        setSelection(start, end, false);
    }

    /** The caret nearest to ({@code x}, {@code y}) (view pixels): see {@link TextLayouts#hitTest}. */
    private long hitAt(float x, float y) {
        return TextLayouts.hitTest(layout, x - contentX, y - contentY, 1f);
    }

    /** The character offset nearest to ({@code x}, {@code y}) (view pixels), -1 without text. */
    private int offsetAt(float x, float y) {
        if (layout == null) return -1;
        return TextLayouts.hitOffset(hitAt(x, y));
    }

    /** Selects [{@code start}, {@code end}); with {@code toolbar}, shows the toolbar too. */
    private void setSelection(int start, int end, boolean toolbar) {
        if (layout == null) return;
        int length = layout.getText().length();
        start = Math.max(0, Math.min(start, length));
        end = Math.max(start, Math.min(end, length));
        if (start == end) {
            clearSelection();
            return;
        }
        boolean was = selStart >= 0;
        selStart = start;
        selEnd = end;
        if (!was) {
            if (startHandle == null) {
                SelectionHandle.Owner owner = new SelectionHandle.Owner() {
                    @Override
                    public void handleDown() {
                        if (mode != null) mode.hide(android.view.ViewConfiguration.getDefaultActionModeHideDuration());
                    }

                    @Override
                    public void handleMoved(boolean start, float x, float y) {
                        dragHandle(start, x, y);
                    }

                    @Override
                    public void handleUp() {
                        showToolbar();
                    }
                };
                startHandle = new SelectionHandle(this, true, selectionColor, owner);
                endHandle = new SelectionHandle(this, false, selectionColor, owner);
            }
            getViewTreeObserver().addOnPreDrawListener(follow);
            // One selection per surface.
            if (mounter.selectedArea != null) mounter.selectedArea.clear();
            mounter.selectedText = this;
        }
        placeHandles();
        if (toolbar) showToolbar();
        else if (mode != null) mode.invalidateContentRect();
        invalidate();
    }

    /** Ends the selection, its handles and its toolbar. */
    void clearSelection() {
        removeCallbacks(longPress);
        if (selStart < 0) return;
        selStart = selEnd = -1;
        extending = false;
        startHandle.dismiss();
        endHandle.dismiss();
        getViewTreeObserver().removeOnPreDrawListener(follow);
        if (mounter.selectedText == this) mounter.selectedText = null;
        android.view.ActionMode m = mode;
        mode = null;
        if (m != null) m.finish();
        invalidate();
    }

    /** Whether the screen point is on this view or one of its handles. */
    boolean selectionContains(float rawX, float rawY) {
        if (startHandle != null && (startHandle.contains(rawX, rawY) || endHandle.contains(rawX, rawY))) return true;
        int[] at = new int[2];
        getLocationOnScreen(at);
        return rawX >= at[0] && rawX < at[0] + getWidth() && rawY >= at[1] && rawY < at[1] + getHeight();
    }

    @Override
    protected void onDetachedFromWindow() {
        clearSelection();
        if (mounter.selectedArea != null) mounter.selectedArea.textChanged(this);
        super.onDetachedFromWindow();
    }

    /** The selected text, without the placeholders of attachments. */
    private String selectedText() {
        return layout.getText().subSequence(selStart, selEnd).toString().replace("￼", "");
    }

    private void showToolbar() {
        if (selStart < 0) return;
        if (mode != null) {
            mode.invalidateContentRect();
            mode.hide(0);
            return;
        }
        mode = startActionMode(new android.view.ActionMode.Callback2() {
            @Override
            public boolean onCreateActionMode(android.view.ActionMode m, android.view.Menu menu) {
                menu.add(android.view.Menu.NONE, android.R.id.copy, 0, android.R.string.copy)
                        .setAlphabeticShortcut('c');
                menu.add(android.view.Menu.NONE, android.R.id.selectAll, 1, android.R.string.selectAll)
                        .setAlphabeticShortcut('a');
                // The system's own "Share" label (TextView's), not in the public resources;
                // without it there is no item (labels are never NSH's own words).
                android.content.res.Resources system = android.content.res.Resources.getSystem();
                int share = system.getIdentifier("share", "string", "android");
                if (share != 0) menu.add(android.view.Menu.NONE, android.R.id.shareText, 2, system.getString(share));
                return true;
            }

            @Override
            public boolean onPrepareActionMode(android.view.ActionMode m, android.view.Menu menu) {
                boolean all = layout != null && selStart == 0 && selEnd == layout.getText().length();
                menu.findItem(android.R.id.selectAll).setVisible(!all);
                return true;
            }

            @Override
            public boolean onActionItemClicked(android.view.ActionMode m, android.view.MenuItem item) {
                if (selStart < 0) return false;
                int itemId = item.getItemId();
                if (itemId == android.R.id.copy) {
                    SystemUi.setClipboard(getContext(), selectedText());
                    clearSelection();
                    return true;
                }
                if (itemId == android.R.id.selectAll) {
                    setSelection(0, layout.getText().length(), false);
                    m.invalidate();
                    return true;
                }
                if (itemId == android.R.id.shareText) {
                    android.content.Intent send = new android.content.Intent(android.content.Intent.ACTION_SEND)
                            .setType("text/plain")
                            .putExtra(android.content.Intent.EXTRA_TEXT, selectedText());
                    android.content.Intent chooser = android.content.Intent.createChooser(send, null);
                    if (!(getContext() instanceof android.app.Activity)) {
                        chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    }
                    try {
                        getContext().startActivity(chooser);
                    } catch (android.content.ActivityNotFoundException ignored) {
                        // Nothing can share text.
                    }
                    clearSelection();
                    return true;
                }
                return false;
            }

            @Override
            public void onDestroyActionMode(android.view.ActionMode m) {
                // Closed by the system (back, a tap elsewhere): the selection goes too.
                if (mode == m) {
                    mode = null;
                    clearSelection();
                }
            }

            @Override
            public void onGetContentRect(android.view.ActionMode m, View view, android.graphics.Rect out) {
                if (layout == null || selStart < 0) {
                    out.set(0, 0, getWidth(), getHeight());
                    return;
                }
                android.graphics.RectF bounds = new android.graphics.RectF();
                layout.getSelectionPath(selStart, selEnd, selectionPath);
                selectionPath.computeBounds(bounds, true);
                out.set(Math.round(contentX + bounds.left), Math.round(contentY + bounds.top),
                        Math.round(contentX + bounds.right), Math.round(contentY + bounds.bottom));
            }
        }, android.view.ActionMode.TYPE_FLOATING);
    }

    /** Puts the handles at the selection's ends (or hides them while the text is off screen). */
    private void placeHandles() {
        if (selStart < 0 || layout == null || !isAttachedToWindow()) return;
        if (!isShown()) {
            startHandle.dismiss();
            endHandle.dismiss();
            return;
        }
        int[] at = new int[2];
        getLocationInWindow(at);
        int startLine = layout.getLineForOffset(selStart);
        startHandle.place(at[0] + contentX + layout.getPrimaryHorizontal(selStart),
                at[1] + contentY + layout.getLineBottom(startLine));
        int endLine = layout.getLineForOffset(selEnd);
        float endX;
        if (endLine > 0 && selEnd == layout.getLineStart(endLine)) {
            // The selection ends at a line break: its handle stays on the line it covers.
            endLine--;
            endX = layout.getLineRight(endLine);
        } else {
            endX = layout.getPrimaryHorizontal(selEnd);
        }
        endHandle.place(at[0] + contentX + endX, at[1] + contentY + layout.getLineBottom(endLine));
    }

    /** A handle moved to the window point ({@code x}, {@code y}): its line bottom. */
    private void dragHandle(boolean start, float x, float y) {
        int[] at = new int[2];
        getLocationInWindow(at);
        // Just above the line's bottom: the line the handle hangs from.
        int offset = offsetAt(x - at[0], y - at[1] - 2 * getResources().getDisplayMetrics().density);
        if (offset < 0 || selStart < 0) return;
        if (start) setSelection(Math.min(offset, selEnd - 1), selEnd, false);
        else setSelection(selStart, Math.max(offset, selStart + 1), false);
    }

    @Override
    public boolean performClick() {
        super.performClick();
        if (press != null) press.click();
        return true;
    }

    /** Screen readers read the text (unless a label replaces it). */
    @Override
    public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        if (layout != null && getContentDescription() == null) info.setText(layout.getText());
        if (info.getClassName() == null || info.getClassName().equals(View.class.getName())) {
            info.setClassName("android.widget.TextView");
        }
    }

    /** Pressable spans: (start, end, node) triples in UTF-16 offsets, and their events. */
    private int[] links = new int[0];
    private long[] linkEvents = new long[0];

    void setLinks(int[] links, long[] events) {
        this.links = links;
        this.linkEvents = events;
    }

    boolean hasLinks() {
        return linkEvents.length > 0;
    }

    /**
     * The pressable span under ({@code x}, {@code y}) (view pixels): its
     * index, or -1.
     */
    int linkAt(float x, float y) {
        if (layout == null || linkEvents.length == 0) return -1;
        float lx = x - contentX, ly = y - contentY;
        float slack = 4 * getResources().getDisplayMetrics().density;
        if (ly < -slack || ly > layout.getHeight() + slack) return -1;
        int line = layout.getLineForVertical((int) ly);
        if (lx < layout.getLineLeft(line) - slack || lx > layout.getLineRight(line) + slack) return -1;
        long hit = TextLayouts.hitTest(layout, lx, ly, 1f);
        int offset = TextLayouts.hitOffset(hit);
        // The nearest caret: the character is the one before it when the
        // point is left of the caret, and when it ends a wrapped line.
        boolean before = TextLayouts.hitUpstream(hit);
        if (!before && offset > layout.getLineStart(line)) {
            before = lx < TextLayouts.caretRect(layout, offset, false, 1f)[0];
        }
        if (before) offset--;
        int best = -1;
        for (int i = 0; i < linkEvents.length; i++) {
            int start = links[i * 3], end = links[i * 3 + 1];
            if (offset < start || offset >= end) continue;
            if (best < 0 || end - start < links[best * 3 + 1] - links[best * 3]) best = i;
        }
        return best;
    }

    int linkNode(int link) {
        return links[link * 3 + 2];
    }

    long linkEvents(int link) {
        return linkEvents[link];
    }

    void setLayout(Layout layout, float x, float y, float width, float height) {
        boolean changed = this.layout == null || !android.text.TextUtils.equals(this.layout.getText(), layout.getText());
        // New text: the selection's offsets mean nothing in it.
        if (selStart >= 0 && changed) clearSelection();
        if (changed && mounter.selectedArea != null) mounter.selectedArea.textChanged(this);
        this.layout = layout;
        this.contentX = x;
        this.contentY = y;
        this.contentWidth = width;
        this.contentHeight = height;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        if (layout == null) return;
        canvas.save();
        canvas.translate(contentX, contentY);
        // Lines past `numberOfLines` (clip mode) stay outside the box.
        canvas.clipRect(0, 0, Math.max(contentWidth, layout.getWidth()), contentHeight);
        drawBackgrounds(canvas);
        if (selStart >= 0) highlight(canvas, selStart, selEnd);
        else if (areaStart >= 0) highlight(canvas, Math.min(areaStart, layout.getText().length()),
                Math.min(areaEnd, layout.getText().length()));
        if (colored) {
            // An animated `color`: the text drawn as is into a layer, then
            // painted over in the color where it drew (antialiasing kept).
            int saved = canvas.saveLayer(null, null);
            layout.draw(canvas);
            drawDecorations(canvas);
            canvas.drawColor(color, android.graphics.PorterDuff.Mode.SRC_IN);
            canvas.restoreToCount(saved);
        } else {
            layout.draw(canvas);
            drawDecorations(canvas);
        }
        canvas.restore();
    }

    /** Draws the selection's highlight over [{@code start}, {@code end}). */
    private void highlight(Canvas canvas, int start, int end) {
        if (start >= end) return;
        if (highlightPaint == null) {
            highlightPaint = new android.graphics.Paint();
            int color;
            if (selectionColor != null) {
                color = (selectionColor & 0x00ffffff) | 0x55000000;
            } else {
                android.content.res.TypedArray a =
                        getContext().obtainStyledAttributes(new int[] {android.R.attr.textColorHighlight});
                color = a.getColor(0, 0x553b82f6);
                a.recycle();
            }
            highlightPaint.setColor(color);
        }
        layout.getSelectionPath(start, end, selectionPath);
        canvas.drawPath(selectionPath, highlightPaint);
    }

    /** An animated `color` (ARGB) the whole text is drawn in. */
    private boolean colored;
    private int color;

    /** Draws the whole text in {@code color} ({@code on}), or in its own colors. */
    void setColor(boolean on, int color) {
        if (colored == on && this.color == color) return;
        colored = on;
        this.color = color;
        invalidate();
    }

    private final android.graphics.Paint decorationPaint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);

    private final android.graphics.Path decorationPath = new android.graphics.Path();

    private final android.graphics.Paint backgroundPaint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);

    private final android.graphics.RectF backgroundRect = new android.graphics.RectF();

    /** Span backgrounds: a rounded box on each line a span reaches, its
     * fonts' ascent to descent around the baseline. */
    private void drawBackgrounds(Canvas canvas) {
        CharSequence text = layout.getText();
        if (!(text instanceof android.text.Spanned)) return;
        android.text.Spanned spanned = (android.text.Spanned) text;
        TextLayouts.Background[] backgrounds = spanned.getSpans(0, text.length(), TextLayouts.Background.class);
        if (backgrounds.length == 0) return;
        int lines = layout.getLineCount();
        for (TextLayouts.Background bg : backgrounds) {
            int start = spanned.getSpanStart(bg), end = spanned.getSpanEnd(bg);
            backgroundPaint.setColor(bg.color);
            for (int line = layout.getLineForOffset(start); line < lines; line++) {
                int lineStart = layout.getLineStart(line), lineEnd = layout.getLineVisibleEnd(line);
                if (lineStart >= end) break;
                int a = Math.max(start, lineStart), b = Math.min(end, lineEnd);
                if (a >= b) continue;
                float x1 = layout.getPrimaryHorizontal(a);
                float x2 = b < layout.getLineEnd(line) ? layout.getPrimaryHorizontal(b) : layout.getLineRight(line);
                if (layout.getParagraphDirection(line) < 0 && b >= lineEnd) x2 = layout.getLineLeft(line);
                float baseline = layout.getLineBaseline(line);
                backgroundRect.set(Math.min(x1, x2), baseline - bg.ascentPx, Math.max(x1, x2), baseline + bg.descentPx);
                float r = Math.min(bg.radiusPx, Math.min(backgroundRect.width(), backgroundRect.height()) / 2);
                canvas.drawRoundRect(backgroundRect, r, r, backgroundPaint);
            }
        }
    }

    /** Underlines and strikethroughs, across the lines each run covers. */
    private void drawDecorations(Canvas canvas) {
        CharSequence text = layout.getText();
        if (!(text instanceof android.text.Spanned)) return;
        android.text.Spanned spanned = (android.text.Spanned) text;
        TextLayouts.Decoration[] decorations = spanned.getSpans(0, text.length(), TextLayouts.Decoration.class);
        if (decorations.length == 0) return;
        int lines = layout.getLineCount();
        for (TextLayouts.Decoration d : decorations) {
            int start = spanned.getSpanStart(d), end = spanned.getSpanEnd(d);
            decorationPaint.setColor(d.color);
            float thickness = d.thicknessPx > 0 ? d.thicknessPx : Math.max(1, d.sizePx / 16);
            decorationPaint.setStrokeWidth(thickness);
            decorationPaint.setStyle(android.graphics.Paint.Style.STROKE);
            switch (d.style) {
                case 2:
                    decorationPaint.setPathEffect(new android.graphics.DashPathEffect(new float[] {0, thickness * 2}, 0));
                    decorationPaint.setStrokeCap(android.graphics.Paint.Cap.ROUND);
                    break;
                case 3:
                    decorationPaint.setPathEffect(new android.graphics.DashPathEffect(new float[] {thickness * 3, thickness * 2}, 0));
                    decorationPaint.setStrokeCap(android.graphics.Paint.Cap.BUTT);
                    break;
                default:
                    decorationPaint.setPathEffect(null);
                    decorationPaint.setStrokeCap(android.graphics.Paint.Cap.BUTT);
            }
            for (int line = layout.getLineForOffset(start); line < lines; line++) {
                int lineStart = layout.getLineStart(line), lineEnd = layout.getLineVisibleEnd(line);
                if (lineStart >= end) break;
                int a = Math.max(start, lineStart), b = Math.min(end, lineEnd);
                if (a >= b) continue;
                float x1 = layout.getPrimaryHorizontal(a);
                float x2 = b < layout.getLineEnd(line) ? layout.getPrimaryHorizontal(b) : layout.getLineRight(line);
                if (layout.getParagraphDirection(line) < 0 && b >= lineEnd) x2 = layout.getLineLeft(line);
                float baseline = layout.getLineBaseline(line);
                if (d.underline) {
                    float y = baseline + (Float.isNaN(d.offsetPx) ? d.sizePx * 0.11f : d.offsetPx + thickness / 2);
                    line(canvas, d.style, x1, x2, y, thickness);
                }
                if (d.strike) line(canvas, d.style, x1, x2, baseline - d.sizePx * 0.27f, thickness);
            }
        }
    }

    /** One decoration line centered on {@code y}. */
    private void line(Canvas canvas, int style, float x1, float x2, float y, float thickness) {
        if (x2 < x1) {
            float t = x1;
            x1 = x2;
            x2 = t;
        }
        switch (style) {
            case 1:
                canvas.drawLine(x1, y - thickness, x2, y - thickness, decorationPaint);
                canvas.drawLine(x1, y + thickness, x2, y + thickness, decorationPaint);
                break;
            case 4: {
                float amplitude = thickness * 1.5f, period = Math.max(4, thickness * 4);
                decorationPath.reset();
                decorationPath.moveTo(x1, y);
                int steps = Math.max(2, (int) Math.ceil((x2 - x1) / period * 8));
                for (int i = 1; i <= steps; i++) {
                    float t = (x2 - x1) * i / steps;
                    decorationPath.lineTo(x1 + t, y + amplitude * (float) Math.sin(t / period * Math.PI * 2));
                }
                canvas.drawPath(decorationPath, decorationPaint);
                break;
            }
            default:
                canvas.drawLine(x1, y, x2, y, decorationPaint);
        }
    }
}
