package com.longbridge.nsh;

import android.app.Activity;
import android.app.Application;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

/**
 * Web sign-in sessions ({@code nsh_core::auth_session}): the sign-in page in a Custom Tab (the default browser where
 * it has none). The page's redirect to the app's callback scheme comes back as a link ({@code onNewIntent}, the
 * root's {@code UrlScheme} event), which ends the session in the core. The user coming back to the app without one
 * (closing the tab, the back button, switching back) answers the root's {@code AuthSession} event as cancelled:
 * Android delivers a link's {@code onNewIntent} before {@code onResume}, and the answer waits for the turn after the
 * resume, so a callback always reaches the core first and the late cancellation is ignored. The app closing the session
 * ({@link #close}) brings its activity back over the tab.
 */
final class AuthSession {
    /** The code of a session nothing brings the callback of back. */
    private static final String UNAVAILABLE = "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM";
    /** Makes an {@code ACTION_VIEW} intent a Custom Tab (the Custom Tabs protocol; no session binder). */
    private static final String EXTRA_SESSION = "android.support.customtabs.extra.SESSION";
    /** Asks a browser for ephemeral browsing in the tab, where it offers it. */
    private static final String EXTRA_EPHEMERAL = "androidx.browser.customtabs.extra.ENABLE_EPHEMERAL_BROWSING";

    /** The session waiting for the user to come back, if any. */
    private static Watch current;

    private AuthSession() {}

    /**
     * Opens session {@code id}'s sign-in page {@code url}, ending with a link of {@code scheme}; answers through
     * {@code mounter}.
     */
    static void open(Context context, Mounter mounter, int id, String url, String scheme, boolean ephemeral) {
        Activity activity = SystemUi.activity(context);
        if (activity == null || activity.isFinishing()) {
            fail(mounter, id, "openAuthSession: a sign-in page needs an activity", null);
            return;
        }
        // Only a scheme the app claims (nsh.json `schemes`) brings the callback back.
        Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse(scheme + "://callback"))
                .setPackage(activity.getPackageName());
        if (activity.getPackageManager().queryIntentActivities(probe, 0).isEmpty()) {
            fail(mounter, id, "openAuthSession: `" + scheme
                    + ":` is not a scheme the app claims (nsh.json `schemes`)", UNAVAILABLE);
            return;
        }
        Intent tab = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE);
        Bundle extras = new Bundle();
        extras.putBinder(EXTRA_SESSION, null);
        tab.putExtras(extras);
        if (ephemeral) tab.putExtra(EXTRA_EPHEMERAL, true);
        // The core answered the earlier session as cancelled already; a tab still open stays until the user closes it.
        if (current != null) current.stop();
        Watch watch = new Watch(activity, mounter, id);
        try {
            activity.startActivity(tab);
        } catch (ActivityNotFoundException e) {
            watch.stop();
            fail(mounter, id, "openAuthSession: no browser shows the sign-in page", UNAVAILABLE);
            return;
        }
        current = watch;
    }

    /**
     * Closes session {@code id} if it still waits: the app closed it, and the core answered it already. The activity
     * that opened the tab comes back to the front: started again with {@code CLEAR_TOP | SINGLE_TOP}, it finishes the
     * tab above it in its task and gets the intent in {@code onNewIntent}, not recreated (an intent with no data nor
     * extras, which the app ignores). A browser that showed the page in a task of its own stays there, behind the app.
     */
    static void close(int id) {
        Watch watch = current;
        if (watch == null || watch.id != id) return;
        watch.stop();
        Activity activity = watch.activity;
        if (activity.isFinishing() || activity.isDestroyed()) return;
        Intent back = new Intent(activity, activity.getClass())
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            activity.startActivity(back);
        } catch (ActivityNotFoundException | SecurityException e) {
            // Not an activity the system starts by its class: the tab stays until the user closes it.
        }
    }

    private static void fail(Mounter mounter, int id, String message, String code) {
        if (code == null) {
            mounter.eventMap(1, Native.AUTH_SESSION, new String[] {"id", "error"}, new Object[] {(double) id, message});
        } else {
            mounter.eventMap(1, Native.AUTH_SESSION, new String[] {"id", "error", "code"},
                    new Object[] {(double) id, message, code});
        }
    }

    /** Waits for the activity to come back after the tab covered it, then answers the session as cancelled. */
    private static final class Watch implements Application.ActivityLifecycleCallbacks {
        private final Activity activity;
        private final Mounter mounter;
        private final int id;
        private final Handler main = new Handler(Looper.getMainLooper());
        private boolean left;
        private boolean stopped;

        Watch(Activity activity, Mounter mounter, int id) {
            this.activity = activity;
            this.mounter = mounter;
            this.id = id;
            activity.getApplication().registerActivityLifecycleCallbacks(this);
        }

        void stop() {
            if (stopped) return;
            stopped = true;
            activity.getApplication().unregisterActivityLifecycleCallbacks(this);
            if (current == this) current = null;
        }

        @Override public void onActivityPaused(Activity a) {
            if (a == activity) left = true;
        }

        @Override public void onActivityResumed(Activity a) {
            if (a != activity || !left) return;
            stop();
            // After this resume: a callback link's `onNewIntent` came before it and ended the session already.
            main.post(() -> mounter.eventMap(1, Native.AUTH_SESSION, new String[] {"id", "action"},
                    new Object[] {(double) id, "cancelled"}));
        }

        @Override public void onActivityDestroyed(Activity a) {
            if (a == activity) stop();
        }

        @Override public void onActivityCreated(Activity a, Bundle state) {}
        @Override public void onActivityStarted(Activity a) {}
        @Override public void onActivityStopped(Activity a) {}
        @Override public void onActivitySaveInstanceState(Activity a, Bundle state) {}
    }
}
