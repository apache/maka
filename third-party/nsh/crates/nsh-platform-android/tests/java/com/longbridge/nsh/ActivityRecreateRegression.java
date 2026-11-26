package com.longbridge.nsh;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Instrumentation;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.MutableContextWrapper;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/**
 * Native instrumentation: the activity of packaged apps, made again for a configuration change
 * ({@code Activity.recreate}, as an overlay changing its resources does), keeps the running app's view and engine,
 * moves its alerts to the new activity unanswered, closes its menus at once, and keeps no reference to the old one;
 * finishing it stops the engine.
 */
public final class ActivityRecreateRegression extends Instrumentation {
    private static final int DIALOG = 7;

    /** Starts the native regression on the instrumentation thread. */
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        int status = Activity.RESULT_OK;
        AtomicReference<Activity> current = new AtomicReference<>();
        try {
            Recreated r = startAndRecreate(current);
            NshView view = r.view;
            Activity second = current.get();
            // Nothing keeps the old activity: its views, windows and alert went with it.
            long deadline = android.os.SystemClock.uptimeMillis() + 10000;
            while (r.old.get() != null && android.os.SystemClock.uptimeMillis() < deadline) {
                Runtime.getRuntime().gc();
                Runtime.getRuntime().runFinalization();
                Thread.sleep(100);
            }
            require(r.old.get() == null, "the old activity is still referenced");

            // Finished for good, the activity stops the engine.
            onMain(() -> {
                SystemUi.closeDialog(view.mounter(), DIALOG);
                second.finish();
            });
            await(second::isDestroyed);
            onMain(() -> require(view.handle == 0, "finishing the activity left the engine running"));
            current.set(null);
            result.putString("stream", "ActivityRecreateRegression: PASS (view, engine, alert, menu, no leak, finish)\n");
        } catch (Throwable error) {
            result.putString("stream", "ActivityRecreateRegression: FAIL " + android.util.Log.getStackTraceString(error));
            status = Activity.RESULT_CANCELED;
        } finally {
            Activity activity = current.get();
            if (activity != null) onMain(activity::finish);
        }
        finish(status, result);
    }

    /** The view the app runs in, and the activity made again took it from. */
    private static final class Recreated {
        final NshView view;
        final WeakReference<Activity> old;

        Recreated(NshView view, Activity old) {
            this.view = view;
            this.old = new WeakReference<>(old);
        }
    }

    /**
     * Starts the activity, shows an alert with text typed in it, and has the activity made again: the new one, in
     * {@code current}, shows the same view, engine and alert.
     */
    private Recreated startAndRecreate(AtomicReference<Activity> current) throws Exception {
        Intent intent = new Intent(getTargetContext(), AppActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity first = startActivitySync(intent);
        current.set(first);
        NshView view = viewOf(first);
        await(() -> view.isAttachedToWindow() && view.getHeight() > 0);
        long handle = view.handle;
        AtomicReference<AlertDialog> shown = new AtomicReference<>();
        AtomicReference<SystemMenus.Popup> menu = new AtomicReference<>();
        onMain(() -> {
            require(handle != 0, "the engine is not running");
            require(view.getContext() instanceof MutableContextWrapper, "the view's context cannot move");
            // A menu, as a menu button shows it.
            java.util.Map<String, Object> item = new java.util.HashMap<>();
            item.put("id", "share");
            item.put("label", "Share");
            SystemMenus.Popup popup = SystemMenus.popup(view.getContext(), false, view, android.view.Gravity.START,
                    "Menu", SystemMenus.parse(java.util.Collections.singletonList(item)), id -> {});
            popup.show();
            menu.set(popup);
            // An alert with a text field, as `AlertDialog.show` with an `input` makes it.
            SystemUi.dialog(view.mounter(), DIALOG, "Title", "Message", true, false,
                    new String[] {"Cancel", "OK"}, new int[] {1, 0}, "", "Name", false, false);
            AlertDialog alert = view.mounter().dialogs.get(DIALOG);
            require(alert != null && alert.isShowing(), "the alert did not show");
            field(alert).setText("kept");
            shown.set(alert);
        });
        await(() -> menu.get().windowRoot().isAttachedToWindow());

        ActivityMonitor monitor = addMonitor(AppActivity.class.getName(), null, false);
        onMain(first::recreate);
        Activity second = waitForMonitorWithTimeout(monitor, 5000);
        removeMonitor(monitor);
        require(second != null && second != first, "the activity was not made again");
        current.set(second);
        await(() -> view.isAttachedToWindow() && alertFocused(view));
        waitForIdleSync();
        onMain(() -> {
            require(viewOf(second) == view, "the new activity made a new view");
            require(view.handle == handle, "the engine was replaced");
            require(((ContextWrapper) view.getContext()).getBaseContext() == second,
                    "the view's context is not the new activity");
            require(view.getRootView() == second.getWindow().getDecorView(), "the view is not in the new window");
            require(first.isDestroyed(), "the old activity was not destroyed");
            require(!shown.get().isShowing(), "the old activity's alert is still shown");
            require(!menu.get().windowRoot().isAttachedToWindow() && SystemMenus.open == null,
                    "the old activity's menu is still shown");
            AlertDialog again = view.mounter().dialogs.get(DIALOG);
            require(again != null && again != shown.get() && again.isShowing(), "the alert did not show again");
            require(SystemUi.activity(again.getContext()) == second, "the alert is not the new activity's");
            require("kept".equals(field(again).getText().toString()), "the alert lost what was typed");
        });
        return new Recreated(view, first);
    }

    /** The running app's view of {@code activity}: its content. */
    private static NshView viewOf(Activity activity) {
        ViewGroup content = activity.findViewById(android.R.id.content);
        View child = content == null || content.getChildCount() == 0 ? null : content.getChildAt(0);
        require(child instanceof NshView, "the activity shows no NshView");
        return (NshView) child;
    }

    private static boolean alertFocused(NshView view) {
        AlertDialog alert = view.mounter().dialogs.get(DIALOG);
        return alert != null && alert.isShowing() && alert.getWindow().getDecorView().hasWindowFocus();
    }

    private static EditText field(AlertDialog alert) {
        EditText field = find(alert.getWindow().getDecorView());
        require(field != null, "the alert has no text field");
        return field;
    }

    private static EditText find(View view) {
        if (view instanceof EditText) return (EditText) view;
        if (!(view instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) view;
        for (int i = 0; i < group.getChildCount(); i++) {
            EditText found = find(group.getChildAt(i));
            if (found != null) return found;
        }
        return null;
    }

    private void onMain(Runnable action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        runOnMainSync(() -> {
            try { action.run(); }
            catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private void await(BooleanSupplier condition) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        AtomicBoolean done = new AtomicBoolean();
        do {
            onMain(() -> done.set(condition.getAsBoolean()));
            if (done.get()) return;
            Thread.sleep(20);
        } while (android.os.SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("native condition timed out");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
