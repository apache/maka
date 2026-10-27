package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;

/** The box of a registered native component: laid out by the core, filled by the component's view. */
@SuppressLint("ViewConstructor")
final class ComponentBox extends Box {
    NshComponent component;
    /** The names of its animated prop slots ({@code MountItem::ComponentPropSlots}). */
    String[] slots;
    /** Slot -> the bits of the value last handed to the component. */
    private final android.util.SparseIntArray handed = new android.util.SparseIntArray();

    ComponentBox(Context context, Mounter mounter, int id) {
        super(context, mounter, id);
    }

    void attach(NshComponent component) {
        this.component = component;
        handed.clear();
        // Its own child, at the box's size (the core places no children here).
        addView(component.view());
    }

    /** Hands animated slot {@code slot} to the component when it changed (outputs come on every frame). */
    void setAnimated(int slot, boolean color, float value) {
        NshComponent c = component;
        if (c == null || slots == null || slot < 0 || slot >= slots.length) return;
        int bits = Float.floatToRawIntBits(value);
        int at = handed.indexOfKey(slot);
        if (at >= 0 && handed.valueAt(at) == bits) return;
        handed.put(slot, bits);
        if (color) c.setAnimatedColor(slots[slot], bits);
        else c.setAnimatedNumber(slots[slot], value);
    }

    /** Its bindings changed: what is bound is handed over again. */
    void forgetAnimated() {
        handed.clear();
    }

    /** The element is gone, or its app stopped: tells the component once. */
    void destroy() {
        NshComponent c = component;
        if (c == null) return;
        // Cleared first, so it is told once even if destroy() throws.
        component = null;
        try {
            c.destroy();
        } finally {
            removeAllViews();
        }
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        int w = MeasureSpec.getSize(widthSpec), h = MeasureSpec.getSize(heightSpec);
        setMeasuredDimension(w, h);
        int exactW = MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY);
        int exactH = MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY);
        for (int i = 0; i < getChildCount(); i++) getChildAt(i).measure(exactW, exactH);
    }

    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {
        for (int i = 0; i < getChildCount(); i++) getChildAt(i).layout(0, 0, r - l, b - t);
    }
}
