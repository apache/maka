package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.view.View;

/** A box whose single native widget fills it (the core lays out no children): web views, videos. */
@SuppressLint("ViewConstructor")
class WidgetBox extends Box {
    View widget;

    WidgetBox(Context context, Mounter mounter, int id, View widget) {
        super(context, mounter, id);
        this.widget = widget;
        addView(widget);
    }

    /** Puts {@code next} in place of the widget, filling the box at its current size. */
    void replaceWidget(View next) {
        removeView(widget);
        widget = next;
        addView(next);
        fill(getWidth(), getHeight());
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        fill(w, h);
    }

    private void fill(int w, int h) {
        Box.Frame f = Box.frame(widget);
        f.left = 0;
        f.top = 0;
        f.right = w;
        f.bottom = h;
        Box.place(widget);
    }
}
