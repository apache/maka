package com.longbridge.nsh;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.io.File;
import java.util.ArrayList;

/**
 * {@code Share.show}: the system's share sheet, a chooser over {@code
 * Intent.ACTION_SEND} ({@code ACTION_SEND_MULTIPLE} for several files). The
 * text and the link go as {@code EXTRA_TEXT}, the title as {@code
 * EXTRA_SUBJECT} and the chooser's title, the files as {@code content:} URIs
 * the app's {@link FilesProvider} serves (only files of the app's own
 * storage). The chooser tells which app the user chose through an {@code
 * IntentSender} broadcast, which answers the root's {@code Share} event as
 * shared to that app's package; Android tells nothing of what the app then
 * does. The chooser's result without that broadcast answers dismissed.
 */
final class Share {
    private static final String TAG = "nsh";
    private static final String FRAGMENT = "com.longbridge.nsh.Share";
    /** The code of content this platform does not share. */
    private static final String UNAVAILABLE = "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM";

    /** What one share asks ({@code nsh_core::share::ShareSheet}). */
    static final class Request {
        int id;
        String title;
        String text;
        String[] files = new String[0];
        Mounter mounter;
        /** The package of the app the user chose, once the chooser said. */
        String chosen;
        boolean answered;
    }

    private Share() {}

    /** Shows the chooser for {@code request}; one that cannot be shown fails the request. */
    @SuppressWarnings("deprecation")
    static void show(Context context, Request request) {
        Activity activity = SystemUi.activity(context);
        if (activity == null || activity.isFinishing()) {
            fail(request, "the share sheet needs an activity");
            return;
        }
        Intent send;
        try {
            send = intent(activity, request);
        } catch (IllegalArgumentException e) {
            fail(request, e.getMessage(), UNAVAILABLE);
            return;
        }
        android.app.FragmentManager manager = activity.getFragmentManager();
        // After the activity saved its state, adding a fragment throws.
        if (manager.isStateSaved()) {
            fail(request, "the app is in the background");
            return;
        }
        Results results = (Results) manager.findFragmentByTag(FRAGMENT);
        if (results == null) {
            results = new Results();
            try {
                manager.beginTransaction().add(results, FRAGMENT).commitNow();
            } catch (IllegalStateException e) {
                fail(request, "the app is in the background");
                return;
            }
        }
        results.start(activity, send, request);
    }

    /** The {@code ACTION_SEND} intent of {@code request}. */
    private static Intent intent(Context context, Request request) {
        ArrayList<Uri> uris = new ArrayList<>();
        String type = null;
        for (String path : request.files) {
            File file = new File(path);
            Uri uri = FilesProvider.uriFor(context, file);
            if (uri == null) {
                throw new IllegalArgumentException(
                        "share: `" + path + "` is not in the app's own storage, which Android shares from");
            }
            uris.add(uri);
            String fileType = FilesProvider.typeOf(context, file);
            type = type == null || type.equals(fileType) ? fileType : commonType(type, fileType);
        }
        Intent intent = new Intent(uris.size() > 1 ? Intent.ACTION_SEND_MULTIPLE : Intent.ACTION_SEND);
        intent.setType(type != null ? type : "text/plain");
        if (request.text != null) intent.putExtra(Intent.EXTRA_TEXT, request.text);
        if (request.title != null) {
            intent.putExtra(Intent.EXTRA_SUBJECT, request.title);
            intent.putExtra(Intent.EXTRA_TITLE, request.title);
        }
        if (uris.size() == 1) {
            intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
        } else if (uris.size() > 1) {
            intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        }
        if (!uris.isEmpty()) {
            // The grant travels with the clip data through the chooser.
            ClipData clip = ClipData.newRawUri(null, uris.get(0));
            for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
            intent.setClipData(clip);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        return intent;
    }

    /** The type that covers two files' types: {@code image/*}, else any. */
    private static String commonType(String a, String b) {
        int slash = a.indexOf('/');
        if (slash > 0 && b.startsWith(a.substring(0, slash + 1))) return a.substring(0, slash) + "/*";
        return "*/*";
    }

    private static void fail(Request request, String error) {
        answer(request, new String[] {"id", "error"}, new Object[] {(double) request.id, error});
    }

    private static void fail(Request request, String error, String code) {
        answer(request, new String[] {"id", "error", "code"},
                new Object[] {(double) request.id, error, code});
    }

    private static void answer(Request request, String[] keys, Object[] values) {
        if (request.answered) return;
        request.answered = true;
        request.mounter.eventMap(1, Native.SHARE, keys, values);
    }

    /**
     * Starts the choosers and hears their results: headless, kept across the
     * activity's configuration changes, as the picker's.
     */
    @SuppressWarnings("deprecation")
    public static final class Results extends android.app.Fragment {
        private final android.util.SparseArray<Request> pending = new android.util.SparseArray<>();
        /** The receivers of the choosers' chosen apps, by request code. */
        private final android.util.SparseArray<BroadcastReceiver> receivers = new android.util.SparseArray<>();
        private int next = 0x5300;

        @Override
        public void onCreate(Bundle state) {
            super.onCreate(state);
            setRetainInstance(true);
        }

        void start(Activity activity, Intent send, Request request) {
            int code = next++;
            if (next > 0x53ff) next = 0x5300;
            String action = activity.getPackageName() + ".nsh.SHARE." + code;
            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    ComponentName chosen = intent.getParcelableExtra(Intent.EXTRA_CHOSEN_COMPONENT);
                    if (chosen == null) return;
                    // The choice is all Android tells: answer it now.
                    request.chosen = chosen.getPackageName();
                    answer(request, new String[] {"id", "action", "target"},
                            new Object[] {(double) request.id, "shared", request.chosen});
                }
            };
            Context app = activity.getApplicationContext();
            IntentFilter filter = new IntentFilter(action);
            if (Build.VERSION.SDK_INT >= 33) {
                app.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                app.registerReceiver(receiver, filter);
            }
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            // The chooser fills in the chosen component.
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            // On the foreground queue: the choice arrives before the
            // chooser's result as a rule, not seconds later.
            Intent broadcast = new Intent(action)
                    .setPackage(activity.getPackageName())
                    .addFlags(Intent.FLAG_RECEIVER_FOREGROUND);
            PendingIntent chosen = PendingIntent.getBroadcast(app, code, broadcast, flags);
            Intent chooser = Intent.createChooser(send, request.title, chosen.getIntentSender());
            pending.put(code, request);
            receivers.put(code, receiver);
            try {
                startActivityForResult(chooser, code);
            } catch (RuntimeException e) {
                Log.w(TAG, "cannot show the share sheet", e);
                pending.remove(code);
                unregister(app, code);
                fail(request, "cannot show the share sheet");
            }
        }

        private void unregister(Context app, int code) {
            BroadcastReceiver receiver = receivers.get(code);
            receivers.remove(code);
            if (receiver == null) return;
            try {
                app.unregisterReceiver(receiver);
            } catch (IllegalArgumentException ignored) {
                // Already gone.
            }
        }

        @Override
        public void onActivityResult(int code, int result, Intent data) {
            Request request = pending.get(code);
            if (request == null) {
                super.onActivityResult(code, result, data);
                return;
            }
            pending.remove(code);
            Context app = getActivity().getApplicationContext();
            // The result tells only that the chooser closed; a choice
            // answered the request already. Give a broadcast still in the
            // queue its turn before taking the close as a dismissal.
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                unregister(app, code);
                answer(request, new String[] {"id", "action"},
                        new Object[] {(double) request.id, "dismissed"});
            }, 100);
        }
    }
}
