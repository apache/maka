package com.longbridge.nsh;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import java.lang.ref.WeakReference;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;

/**
 * Asks the user for runtime permissions ({@code Activity.requestPermissions}). Android gives the answer only to the
 * activity that asked ({@code onRequestPermissionsResult}), so a retained, headless {@link Asker} fragment of the
 * activity queues the requests and asks for one at a time, across configuration changes. NSH's own prompts
 * ({@link Notifications}, {@link WebBox}'s media) and Rust code ({@code nsh::permissions} of the {@code nsh-platform-android} crate) go through
 * it.
 *
 * <p>A permission's state ({@link #state}): {@code granted}; {@code undeclared}, not in the app's manifest, which
 * Android never grants; {@code denied}, the user refused and Android asks no more (no rationale to show after a
 * refusal), until the system's settings change it; {@code default} otherwise: asking shows the system's prompt.
 */
final class Permissions {
    /** The answer to {@link #ask}. UI thread. */
    interface Answer {
        /**
         * @param results as {@code onRequestPermissionsResult}'s, empty when the prompt was cancelled, or
         *     {@code null} when the activity finished before the system answered
         */
        void answered(int[] results);
    }

    private static final String PREFERENCES = "com.longbridge.nsh.permissions";
    /** The permissions the user refused for good, as the last answer for each said. */
    private static final String DENIED = "denied";
    private static final String TAG = "com.longbridge.nsh.Permissions";

    private static final Handler main = new Handler(Looper.getMainLooper());
    /** The application, once an {@code NshView} was made. */
    private static volatile Context application;
    /** The activity in front. UI thread. */
    private static WeakReference<Activity> front = new WeakReference<>(null);

    private Permissions() {}

    /** The application, or {@code null} before any {@code NshView} was made. Any thread. */
    static Context application() {
        return application;
    }

    /** The activity in front, or {@code null}. UI thread. */
    static Activity front() {
        return front.get();
    }

    /**
     * Follows the activity in front from now on ({@code context} being a view's), which Rust code's requests ask
     * through: the packaged app's or an embedding app's. UI thread.
     */
    static void track(Context context) {
        Activity activity = SystemUi.activity(context);
        if (activity != null && front.get() == null) front = new WeakReference<>(activity);
        if (application != null) return;
        Context app = context.getApplicationContext();
        application = app;
        if (!(app instanceof Application)) return;
        ((Application) app).registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            @Override
            public void onActivityResumed(Activity resumed) {
                front = new WeakReference<>(resumed);
            }

            @Override
            public void onActivityDestroyed(Activity destroyed) {
                if (front.get() == destroyed) front = new WeakReference<>(null);
            }

            @Override
            public void onActivityCreated(Activity created, Bundle state) {}

            @Override
            public void onActivityStarted(Activity started) {}

            @Override
            public void onActivityPaused(Activity paused) {}

            @Override
            public void onActivityStopped(Activity stopped) {}

            @Override
            public void onActivitySaveInstanceState(Activity saved, Bundle state) {}
        });
    }

    /**
     * Asks the user for {@code permissions} through {@code activity}, after the requests before it: {@code false},
     * and {@code answer} is never called, when the activity has saved its state (the app is in the background) and
     * cannot take the asking fragment. UI thread.
     */
    static boolean ask(Activity activity, String[] permissions, Answer answer) {
        Asker asker = asker(activity);
        if (asker == null) return false;
        asker.ask(permissions, answer);
        return true;
    }

    /** {@code permission}'s state; {@code activity} may be {@code null}. Any thread. */
    static String state(Context context, Activity activity, String permission) {
        if (context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) return "granted";
        if (!declared(context, permission)) return "undeclared";
        // A refusal Android still asks again after.
        if (activity != null && activity.shouldShowRequestPermissionRationale(permission)) return "default";
        return denied(context).contains(permission) ? "denied" : "default";
    }

    /** Whether the app's manifest declares {@code permission}. Any thread. */
    static boolean declared(Context context, String permission) {
        try {
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS);
            if (info.requestedPermissions == null) return false;
            for (String p : info.requestedPermissions) {
                if (p.equals(permission)) return true;
            }
        } catch (PackageManager.NameNotFoundException e) {
            // Not installed as a package: nothing is declared.
        }
        return false;
    }

    /**
     * {@code nsh::permissions::states}: the state of each of {@code permissions}, or {@code null}
     * before any {@code NshView} was made. Any thread.
     */
    static String[] states(String[] permissions) {
        Context context = application;
        if (context == null) return null;
        Activity activity = front.get();
        String[] states = new String[permissions.length];
        for (int i = 0; i < permissions.length; i++) states[i] = state(context, activity, permissions[i]);
        return states;
    }

    /**
     * {@code nsh::permissions::request}: asks for {@code permissions} through the activity in front
     * and answers request {@code key} ({@link #nativeAnswer}) with their states, or with why it cannot. Any thread.
     */
    static void request(String[] permissions, long key) {
        main.post(() -> {
            Context context = application;
            if (context == null) {
                // No NshView yet: Rust's `NotStarted`.
                nativeAnswer(key, null, null);
                return;
            }
            Activity activity = front.get();
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                nativeAnswer(key, null, "no activity is in front to ask the user");
                return;
            }
            boolean asking = false;
            for (String p : permissions) {
                String state = state(context, activity, p);
                asking |= !state.equals("granted") && !state.equals("undeclared");
            }
            // Nothing the system would ask: answered without a prompt.
            if (!asking) {
                nativeAnswer(key, states(permissions), null);
                return;
            }
            boolean asked = ask(activity, permissions, results -> {
                if (results == null) nativeAnswer(key, null, "the activity finished before the user answered");
                else nativeAnswer(key, states(permissions), null);
            });
            if (!asked) nativeAnswer(key, null, "the app is in the background");
        });
    }

    /** Answers Rust's request {@code key}: the states, or {@code error}. */
    private static native void nativeAnswer(long key, String[] states, String error);

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static Set<String> denied(Context context) {
        return preferences(context).getStringSet(DENIED, new HashSet<>());
    }

    /** Keeps which of {@code permissions} the user refused for good, from {@code activity}'s answer. */
    private static void remember(Activity activity, String[] permissions, int[] results) {
        Set<String> denied = new HashSet<>(denied(activity));
        for (int i = 0; i < permissions.length && i < results.length; i++) {
            boolean refused = results[i] != PackageManager.PERMISSION_GRANTED
                    && !activity.shouldShowRequestPermissionRationale(permissions[i]);
            if (refused) denied.add(permissions[i]);
            else denied.remove(permissions[i]);
        }
        preferences(activity).edit().putStringSet(DENIED, denied).apply();
    }

    /**
     * {@code activity}'s asking fragment, added when missing; {@code null} once the activity has saved its state,
     * when adding a fragment would throw (as {@code Activities.results}).
     */
    @SuppressWarnings("deprecation")
    private static Asker asker(Activity activity) {
        android.app.FragmentManager fragments = activity.getFragmentManager();
        if (fragments.isStateSaved()) return null;
        Asker asker = (Asker) fragments.findFragmentByTag(TAG);
        if (asker == null) {
            asker = new Asker();
            try {
                fragments.beginTransaction().add(asker, TAG).commitNow();
            } catch (IllegalStateException e) {
                return null;
            }
        }
        return asker;
    }

    /** Asks for the requests of an activity one at a time and answers each, across configuration changes. */
    @SuppressWarnings("deprecation")
    public static final class Asker extends android.app.Fragment {
        private static final int CODE = 0x4f02;
        /** Each request: its permissions and its answer; the first is being asked. */
        private final ArrayDeque<Object[]> waiting = new ArrayDeque<>();
        private boolean asking;

        @Override
        public void onCreate(Bundle state) {
            super.onCreate(state);
            setRetainInstance(true);
        }

        void ask(String[] permissions, Answer answer) {
            waiting.add(new Object[] {permissions, answer});
            next();
        }

        private void next() {
            if (asking || waiting.isEmpty()) return;
            asking = true;
            requestPermissions((String[]) waiting.peek()[0], CODE);
        }

        @Override
        public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
            if (code != CODE) {
                super.onRequestPermissionsResult(code, permissions, results);
                return;
            }
            asking = false;
            Object[] request = waiting.poll();
            Activity activity = getActivity();
            if (activity != null) remember(activity, permissions, results);
            if (request != null) ((Answer) request[1]).answered(results);
            next();
        }

        /** The activity finished for good (a retained fragment outlives configuration changes): no answer comes. */
        @Override
        public void onDestroy() {
            super.onDestroy();
            Object[][] left = waiting.toArray(new Object[0][]);
            waiting.clear();
            for (Object[] request : left) ((Answer) request[1]).answered(null);
        }
    }
}
