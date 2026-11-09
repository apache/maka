package com.longbridge.nsh;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * {@code Notifications} of {@code nsh}: the system's notifications. They show in one channel; a press opens the app's
 * launcher activity with the notification's id in an extra, which {@link #handleIntent} reports, so
 * {@link NshView#handleNotificationIntent} must get the activity's intents (the packaged and development activities do).
 *
 * <p>Android has no badge count to set: launchers mark an app that has notifications showing. The app's count goes with
 * the notifications shown after it ({@code Notification.Builder.setNumber}), which launchers that show numbers read.
 *
 * <p>Android 13 asks for {@code POST_NOTIFICATIONS}, which {@code nsh package} declares for apps granted
 * {@code notifications}. An embedding app that does not declare it gets {@code denied}, without a prompt.
 */
final class Notifications {
    private static final String TAG = "nsh";
    private static final String CHANNEL = "com.longbridge.nsh.notifications";
    private static final String EXTRA = "com.longbridge.nsh.NOTIFICATION";
    private static final String PREFERENCES = "com.longbridge.nsh.notifications";
    private static final String ASKED = "asked";
    /** The id of every notification, the app's id being its tag. */
    private static final int NOTIFICATION_ID = 1;
    /** The group of silent notifications, which has no summary to alert. */
    private static final String SILENT_GROUP = "com.longbridge.nsh.silent";

    /** The mounter that listens to presses, once the app does. UI thread. */
    private static Mounter listener;
    /** Presses before the app listens. UI thread. */
    private static final List<String> presses = new ArrayList<>();
    /** The count {@code setBadge} set. UI thread. */
    private static int badge;

    private Notifications() {}

    /** A command, as {@code encode.rs} wrote it. UI thread. */
    static void command(Mounter mounter, ByteBuffer b, Object[] objects) {
        Context context = mounter.context;
        switch (b.getInt()) {
            case 0: {
                int request = b.getInt();
                boolean ask = b.getInt() != 0;
                if (ask && permission(context).equals("default")) {
                    Activity activity = SystemUi.activity(context);
                    if (activity != null) {
                        results(activity).ask(mounter, request);
                        return;
                    }
                }
                answerPermission(mounter, request);
                return;
            }
            case 1: {
                int request = b.getInt();
                String id = (String) objects[b.getInt()];
                String title = (String) objects[b.getInt()];
                String body = (String) objects[b.getInt()];
                boolean silent = b.getInt() != 0;
                boolean shown = show(context, id, title, body, silent);
                mounter.eventMap(1, Native.NOTIFICATION, new String[] {"id", "shown"}, new Object[] {(double) request, shown});
                return;
            }
            case 2: {
                manager(context).cancel((String) objects[b.getInt()], NOTIFICATION_ID);
                return;
            }
            case 3: {
                listener = mounter;
                List<String> waiting = new ArrayList<>(presses);
                presses.clear();
                for (String id : waiting) pressed(id);
                return;
            }
            case 4: {
                badge = b.getInt();
                return;
            }
            default:
        }
    }

    /** The mounter went: nothing is reported to it any more. UI thread. */
    static void forget(Mounter mounter) {
        if (listener == mounter) listener = null;
    }

    /** Reports the press an activity's {@code intent} carries, if any. UI thread. */
    static void handleIntent(Intent intent) {
        if (intent == null) return;
        String id = intent.getStringExtra(EXTRA);
        if (id == null) return;
        // Once: an activity recreated with the same intent has not been pressed again.
        intent.removeExtra(EXTRA);
        pressed(id);
    }

    private static void pressed(String id) {
        if (listener == null) {
            presses.add(id);
            return;
        }
        listener.eventMap(1, Native.NOTIFICATION, new String[] {"pressed"}, new Object[] {id});
    }

    private static void answerPermission(Mounter mounter, int request) {
        mounter.eventMap(1, Native.NOTIFICATION, new String[] {"id", "permission"},
                new Object[] {(double) request, permission(mounter.context)});
    }

    private static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    /** {@code NotificationPermission}'s name: `default` until the user was asked on Android 13. */
    private static String permission(Context context) {
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            boolean asked = preferences(context).getBoolean(ASKED, false);
            return asked || !declared(context) ? "denied" : "default";
        }
        return manager(context).areNotificationsEnabled() ? "granted" : "denied";
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    /** Whether the app's manifest declares {@code POST_NOTIFICATIONS}. */
    private static boolean declared(Context context) {
        try {
            String[] permissions = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS).requestedPermissions;
            if (permissions != null) {
                for (String permission : permissions) {
                    if (Manifest.permission.POST_NOTIFICATIONS.equals(permission)) return true;
                }
            }
        } catch (PackageManager.NameNotFoundException e) {
            Log.w(TAG, "cannot read the app's permissions", e);
        }
        return false;
    }

    @SuppressWarnings("deprecation")
    private static boolean show(Context context, String id, String title, String body, boolean silent) {
        if (!permission(context).equals("granted")) return false;
        NotificationManager manager = manager(context);
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            if (manager.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel channel = new NotificationChannel(CHANNEL, "Notifications", NotificationManager.IMPORTANCE_HIGH);
                channel.setShowBadge(true);
                manager.createNotificationChannel(channel);
            }
            builder = new Notification.Builder(context, CHANNEL);
        } else {
            builder = new Notification.Builder(context);
            builder.setPriority(Notification.PRIORITY_HIGH);
            builder.setDefaults(silent ? Notification.DEFAULT_LIGHTS : Notification.DEFAULT_ALL);
        }
        if (silent && Build.VERSION.SDK_INT >= 26) {
            // The channel's sound and vibration are for every notification in it. A child of a group that alerts
            // only for its summary makes neither, as NotificationCompat's setSilent does it.
            builder.setGroup(SILENT_GROUP).setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY);
        }
        int icon = context.getApplicationInfo().icon;
        builder.setSmallIcon(icon != 0 ? icon : android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setAutoCancel(true)
                .setShowWhen(true);
        if (!body.isEmpty()) builder.setContentText(body);
        if (badge > 0) builder.setNumber(badge);
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            launch.putExtra(EXTRA, id);
            builder.setContentIntent(PendingIntent.getActivity(context, id.hashCode(), launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        try {
            manager.notify(id, NOTIFICATION_ID, builder.build());
            return true;
        } catch (RuntimeException e) {
            Log.w(TAG, "cannot show a notification", e);
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    private static Results results(Activity activity) {
        android.app.FragmentManager fragments = activity.getFragmentManager();
        Results results = (Results) fragments.findFragmentByTag(TAG_RESULTS);
        if (results == null) {
            results = new Results();
            fragments.beginTransaction().add(results, TAG_RESULTS).commitNow();
        }
        return results;
    }

    private static final String TAG_RESULTS = "com.longbridge.nsh.Notifications";

    /** Gets the system's answer to the permission prompt, across configuration changes. */
    @SuppressWarnings("deprecation")
    public static final class Results extends android.app.Fragment {
        private static final int CODE = 0x4f00;
        private final List<Object[]> waiting = new ArrayList<>();

        @Override
        public void onCreate(Bundle state) {
            super.onCreate(state);
            setRetainInstance(true);
        }

        void ask(Mounter mounter, int request) {
            waiting.add(new Object[] {mounter, request});
            if (waiting.size() == 1) requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, CODE);
        }

        @Override
        public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
            if (code != CODE) {
                super.onRequestPermissionsResult(code, permissions, results);
                return;
            }
            // Empty: the prompt was cancelled, so the user can still be asked.
            if (results.length > 0) preferences(getActivity()).edit().putBoolean(ASKED, true).apply();
            List<Object[]> answered = new ArrayList<>(waiting);
            waiting.clear();
            for (Object[] w : answered) answerPermission((Mounter) w[0], (Integer) w[1]);
        }
    }
}
