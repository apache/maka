package com.longbridge.nsh;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/**
 * Mouse hovers follow a box's pointerEvents as touches do: an inert overlay passes them to the view under it (a
 * screen reader's touch exploration is hovers too), and a box that turns inert while hovered leaves the hover.
 */
public final class HoverRoutingRegression extends Instrumentation {
    private static final int AUTO = 0, NONE = 1, BOX_NONE = 2, BOX_ONLY = 3;
    private HostActivity host;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        int status = Activity.RESULT_OK;
        try {
            Intent intent = new Intent(getTargetContext(), HostActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            host = (HostActivity) startActivitySync(intent);
            await(() -> host.root.hasWindowFocus() && host.overlay.getWidth() > 0 && host.child.getWidth() > 0);
            waitForIdleSync();
            // P: the overlay's own area. Q: its child's.
            float px = host.overlay.getWidth() * 3 / 4f, py = host.overlay.getHeight() * 3 / 4f;
            float qx = host.child.getWidth() / 2f, qy = host.child.getHeight() / 2f;

            hover(AUTO, px, py);
            expect("auto takes the hover over its own area", true, false, false);
            hover(NONE, px, py);
            expect("none, turned so while hovered, leaves it to the view under it", false, false, true);
            hover(NONE, qx, qy);
            expect("none passes the hover over its child too", false, false, true);
            hover(AUTO, qx, qy);
            expect("auto gives the hover over its child to the child", false, true, false);
            hover(NONE, qx, qy);
            expect("none, turned so while its child is hovered, leaves the child", false, false, true);
            hover(BOX_ONLY, qx, qy);
            expect("box-only takes the hover over its child itself", true, false, false);
            hover(BOX_NONE, px, py);
            expect("box-none, turned so while hovered, passes its own area on", false, false, true);
            hover(BOX_NONE, qx, qy);
            expect("box-none gives the hover over its child to the child", false, true, false);
            hover(BOX_NONE, px, py);
            expect("box-none passes its own area on", false, false, true);
            hover(AUTO, px, py);
            expect("auto, turned so from box-none over its own area, takes the hover", true, false, false);
            result.putString("stream", "HoverRoutingRegression: PASS (auto, none, box-none, box-only)\n");
        } catch (Throwable error) {
            result.putString("stream", "HoverRoutingRegression: FAIL " + android.util.Log.getStackTraceString(error));
            status = Activity.RESULT_CANCELED;
        } finally {
            if (host != null) onMain(host::finish);
        }
        finish(status, result);
    }

    /** Sets the overlay's pointerEvents and moves a mouse to ({@code x}, {@code y}) in it. */
    private void hover(int pointerEvents, float x, float y) {
        int[] at = new int[2];
        onMain(() -> {
            host.overlay.pointerEvents = pointerEvents;
            host.overlay.getLocationOnScreen(at);
        });
        long now = SystemClock.uptimeMillis();
        MotionEvent move = MotionEvent.obtain(now, now, MotionEvent.ACTION_HOVER_MOVE, at[0] + x, at[1] + y, 0);
        move.setSource(InputDevice.SOURCE_MOUSE);
        require(getUiAutomation().injectInputEvent(move, true), "hover was not injected");
        move.recycle();
        waitForIdleSync();
    }

    private void expect(String what, boolean overlay, boolean child, boolean below) {
        AtomicReference<String> state = new AtomicReference<>();
        onMain(() -> state.set("overlay " + host.overlay.isHovered() + ", child " + host.child.isHovered()
                + ", below " + host.below.isHovered()));
        require(state.get().equals("overlay " + overlay + ", child " + child + ", below " + below),
                what + ": " + state.get());
    }

    private void await(BooleanSupplier condition) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 10000;
        AtomicBoolean done = new AtomicBoolean();
        do {
            onMain(() -> done.set(condition.getAsBoolean()));
            if (done.get()) return;
            Thread.sleep(20);
        } while (SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("native condition timed out");
    }

    private void onMain(Runnable action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    /** A clickable view, and over it a clickable full-window box with a clickable child box in its top-left corner. */
    public static final class HostActivity extends Activity {
        NshView owner;
        FrameLayout root;
        View below;
        Box overlay, child;

        @Override public void onCreate(Bundle state) {
            super.onCreate(state);
            owner = new NshView(this);
            root = new FrameLayout(this);
            below = new View(this);
            below.setClickable(true);
            root.addView(below, new FrameLayout.LayoutParams(-1, -1));
            overlay = new Box(this, owner.mounter(), 2);
            overlay.setClickable(true);
            root.addView(overlay, new FrameLayout.LayoutParams(-1, -1));
            child = new Box(this, owner.mounter(), 3);
            child.setClickable(true);
            int side = Math.round(160 * getResources().getDisplayMetrics().density);
            Box.Frame frame = Box.frame(child);
            frame.right = side;
            frame.bottom = side;
            overlay.addView(child);
            setContentView(root);
        }

        @Override protected void onDestroy() {
            if (owner != null) owner.destroy();
            super.onDestroy();
        }
    }
}
