package com.longbridge.nsh;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.io.File;

/**
 * Starts activities for a result for Rust code ({@code nsh::activity} of the {@code nsh-platform-android} crate): an
 * app's crate or an nshm showing another app (a camera) and hearing its answer. Android gives a result only to the
 * activity that started it ({@code onActivityResult}), so a retained, headless {@link Results} fragment of the
 * activity in front ({@link Permissions#front}) starts each one and answers Rust's request by its key.
 */
final class Activities {
    private static final String TAG = "com.longbridge.nsh.Activities";
    private static final Handler main = new Handler(Looper.getMainLooper());

    private Activities() {}

    /**
     * {@code nsh::activity::start_for_result}: starts {@code intent} from the activity in front and answers request
     * {@code key} ({@link #nativeResult}) with its result, or with why it cannot. Any thread.
     */
    static void start(Intent intent, long key) {
        main.post(() -> {
            if (Permissions.application() == null) {
                nativeResult(key, 0, null, "not-started", "no NshView was made yet");
                return;
            }
            Activity activity = Permissions.front();
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                nativeResult(key, 0, null, "no-activity", "no activity is in front to start it from");
                return;
            }
            Results results = results(activity);
            if (results == null) {
                nativeResult(key, 0, null, "no-activity", "the app is in the background");
                return;
            }
            results.start(intent, key);
        });
    }

    /** {@code nsh::activity::can_start}: whether an installed activity handles {@code intent}. Any thread. */
    static boolean canStart(Intent intent) {
        Context context = Permissions.application();
        return context != null && intent.resolveActivity(context.getPackageManager()) != null;
    }

    /**
     * {@code nsh::activity::output_file}: a new, empty file of the app's cache that another app may write ({@link
     * FilesProvider#outputUri}), as {@code [path, uri]}; {@code null} before any {@code NshView} was made or when it
     * cannot be made. Any thread.
     */
    static Object[] outputFile(String name) {
        Context context = Permissions.application();
        if (context == null) return null;
        try {
            File directory = FilesProvider.outputs(context);
            if (!directory.isDirectory() && !directory.mkdirs()) return null;
            forgetStale(directory);
            File file = File.createTempFile("nsh-", "-" + name, directory);
            android.net.Uri uri = FilesProvider.uriFor(context, file);
            if (uri == null) return null;
            return new Object[] {file.getAbsolutePath(), uri};
        } catch (java.io.IOException e) {
            Log.w(TAG, "cannot make an output file", e);
            return null;
        }
    }

    /** How long an output file is kept: one left by a request that never finished (the app ended meanwhile). */
    private static final long OUTPUT_LIFETIME_MS = 24L * 60 * 60 * 1000;

    /** Deletes the output files older than {@link #OUTPUT_LIFETIME_MS}. */
    private static void forgetStale(File directory) {
        File[] files = directory.listFiles();
        if (files == null) return;
        long before = System.currentTimeMillis() - OUTPUT_LIFETIME_MS;
        for (File file : files) {
            if (file.isFile() && file.lastModified() < before && !file.delete()) {
                Log.w(TAG, "cannot delete the stale output file " + file);
            }
        }
    }

    /** Answers Rust's request {@code key}: the result's code and data, or an error ({@code reason}, {@code message}). */
    private static native void nativeResult(long key, int code, Intent data, String reason, String message);

    /**
     * {@code activity}'s {@link Results}, added when it has none; {@code null} once the activity saved its state (the
     * app went to the background), when no fragment may be added and Android would not start another app anyway.
     */
    @SuppressWarnings("deprecation")
    private static Results results(Activity activity) {
        android.app.FragmentManager fragments = activity.getFragmentManager();
        if (fragments.isStateSaved()) return null;
        Results results = (Results) fragments.findFragmentByTag(TAG);
        if (results == null) {
            results = new Results();
            try {
                fragments.beginTransaction().add(results, TAG).commitNow();
            } catch (IllegalStateException e) {
                Log.w(TAG, "cannot add the results fragment", e);
                return null;
            }
        }
        return results;
    }

    /** Starts the activities and hears their results: headless, kept across configuration changes. */
    @SuppressWarnings("deprecation")
    public static final class Results extends android.app.Fragment {
        private final android.util.SparseArray<Long> keys = new android.util.SparseArray<>();
        private int next = 0x4f00;

        @Override
        public void onCreate(Bundle state) {
            super.onCreate(state);
            setRetainInstance(true);
        }

        @Override
        public void onDestroy() {
            super.onDestroy();
            // The activity is gone for good: nothing will answer what is waiting.
            for (int i = 0; i < keys.size(); i++) {
                nativeResult(keys.valueAt(i), 0, null, "no-activity", "the activity finished before the result came");
            }
            keys.clear();
        }

        void start(Intent intent, long key) {
            int code = next++;
            if (next > 0x4fff) next = 0x4f00;
            keys.put(code, key);
            try {
                startActivityForResult(intent, code);
            } catch (ActivityNotFoundException e) {
                keys.remove(code);
                nativeResult(key, 0, null, "not-found", "no installed activity handles the intent");
            } catch (RuntimeException e) {
                Log.w(TAG, "cannot start the activity", e);
                keys.remove(code);
                nativeResult(key, 0, null, "failed", String.valueOf(e.getMessage()));
            }
        }

        @Override
        public void onActivityResult(int code, int result, Intent data) {
            Long key = keys.get(code);
            if (key == null) {
                super.onActivityResult(code, result, data);
                return;
            }
            keys.remove(code);
            nativeResult(key, result, data, null, null);
        }
    }
}
