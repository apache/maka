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
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

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
    /** The permission requests waiting for the prompt showing: their mounters and ids. UI thread. */
    private static final List<Object[]> waiting = new ArrayList<>();
    /** The intents {@link #foreign} looked at, by identity, for as long as their activities keep them. UI thread. */
    private static final Set<Intent> foreignHandled = Collections.newSetFromMap(new WeakHashMap<>());

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
                        ask(activity, mounter, request);
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
                String sound = (String) objects[b.getInt()];
                boolean shown = show(context, id, title, body, silent, sound);
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
            case 5: {
                // NSH's own, those an earlier run left included; an embedding app's notifications stay.
                NotificationManager manager = manager(context);
                for (StatusBarNotification n : manager.getActiveNotifications()) {
                    if (n.getId() == NOTIFICATION_ID && n.getTag() != null
                            && CHANNEL.equals(n.getNotification().getChannelId())) {
                        manager.cancel(n.getTag(), NOTIFICATION_ID);
                    }
                }
                return;
            }
            default:
        }
    }

    /** The mounter went: nothing is reported to it any more. UI thread. */
    static void forget(Mounter mounter) {
        if (listener == mounter) listener = null;
    }

    /**
     * Reports the press an activity's {@code intent} carries, if any: one of NSH's notifications to the app, one that
     * other code showed (an intent {@link ForeignIntents#isPress} takes for one) to the handler Rust code set
     * ({@code notifications.rs}). UI thread.
     */
    static void handleIntent(Intent intent) {
        if (intent == null) return;
        String id = intent.getStringExtra(EXTRA);
        if (id == null) {
            foreign(intent);
            return;
        }
        // Once: an activity recreated with the same intent has not been pressed again.
        intent.removeExtra(EXTRA);
        pressed(id);
    }

    /**
     * Hands {@code intent} to the handler of the notifications NSH did not show if it may be a press of one, once:
     * an activity recreated with the same intent object has not been pressed again. Its extras stay as they are for
     * the app's other code, such as the SDK that showed the notification. UI thread.
     */
    private static void foreign(Intent intent) {
        if (!foreignHandled.add(intent)) return;
        Bundle extras;
        Set<String> keys;
        try {
            extras = intent.getExtras();
            keys = extras == null ? null : extras.keySet();
        } catch (RuntimeException e) {
            // A value of a class this process cannot load fails the whole bundle on older Android versions.
            Log.w(TAG, "cannot read the extras of the activity's intent", e);
            return;
        }
        if (!ForeignIntents.isPress(intent.getAction(), intent.getFlags(), keys)) return;
        String action = intent.getAction();
        String data = intent.getDataString();
        nativeForeignPressed(ForeignIntents.json(plain(extras)), action == null ? "" : action, data == null ? "" : data);
    }

    /**
     * {@code extras} as plain Java values for {@link ForeignIntents#json}, without NSH's own: bundles as maps,
     * parcelable arrays and lists as lists. A value that cannot be read is {@code null}.
     */
    @SuppressWarnings("deprecation")
    private static Map<String, Object> plain(Bundle extras) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (String key : extras.keySet()) {
            if (key == null || ForeignIntents.own(key)) continue;
            Object value;
            try {
                value = extras.get(key);
            } catch (RuntimeException e) {
                Log.w(TAG, "cannot read the extra " + key + " of the activity's intent", e);
                value = null;
            }
            map.put(key, plainValue(value));
        }
        return map;
    }

    private static Object plainValue(Object value) {
        if (value instanceof Bundle) return plain((Bundle) value);
        if (value instanceof Object[]) {
            List<Object> list = new ArrayList<>();
            for (Object item : (Object[]) value) list.add(plainValue(item));
            return list;
        }
        if (value instanceof List) {
            List<Object> list = new ArrayList<>();
            for (Object item : (List<?>) value) list.add(plainValue(item));
            return list;
        }
        return value;
    }

    /** The extras ({@code extras}, JSON), action and data URI ({@code ""} for none) of a press. UI thread. */
    private static native void nativeForeignPressed(String extras, String action, String data);

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
            return asked || !Permissions.declared(context, Manifest.permission.POST_NOTIFICATIONS) ? "denied" : "default";
        }
        return manager(context).areNotificationsEnabled() ? "granted" : "denied";
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    @SuppressWarnings("deprecation")
    private static boolean show(Context context, String id, String title, String body, boolean silent, String sound) {
        if (!permission(context).equals("granted")) return false;
        NotificationManager manager = manager(context);
        // The app's sound, a raw resource `nsh package` added; none found plays the default.
        Uri soundUri = null;
        if (!silent && !sound.isEmpty()) {
            int res = context.getResources().getIdentifier(sound, "raw", context.getPackageName());
            if (res != 0) {
                soundUri = Uri.parse("android.resource://" + context.getPackageName() + "/" + res);
            } else {
                Log.w(TAG, "no raw resource for the notification sound " + sound);
            }
        }
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            // A channel's sound is fixed once made, so each sound has its own channel.
            String channelId = soundUri == null ? CHANNEL : CHANNEL + ".sound." + sound;
            if (manager.getNotificationChannel(channelId) == null) {
                String name = soundUri == null ? "Notifications" : "Notifications (" + sound + ")";
                NotificationChannel channel = new NotificationChannel(channelId, name, NotificationManager.IMPORTANCE_HIGH);
                channel.setShowBadge(true);
                if (soundUri != null) {
                    channel.setSound(soundUri, new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build());
                }
                manager.createNotificationChannel(channel);
            }
            builder = new Notification.Builder(context, channelId);
        } else {
            builder = new Notification.Builder(context);
            builder.setPriority(Notification.PRIORITY_HIGH);
            if (soundUri != null) {
                builder.setDefaults(Notification.DEFAULT_LIGHTS | Notification.DEFAULT_VIBRATE);
                builder.setSound(soundUri);
            } else {
                builder.setDefaults(silent ? Notification.DEFAULT_LIGHTS : Notification.DEFAULT_ALL);
            }
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

    /**
     * Shows the system's prompt for request {@code request}, or joins the prompt already showing: each request waiting
     * gets the one answer. UI thread.
     */
    private static void ask(Activity activity, Mounter mounter, int request) {
        waiting.add(new Object[] {mounter, request});
        if (waiting.size() > 1) return;
        boolean asked = Permissions.ask(activity, new String[] {Manifest.permission.POST_NOTIFICATIONS}, results -> {
            // Empty: the prompt was cancelled, so the user can still be asked.
            if (results != null && results.length > 0) preferences(activity).edit().putBoolean(ASKED, true).apply();
            answerWaiting();
        });
        // In the background: answered with the state as it is, the user still to be asked.
        if (!asked) answerWaiting();
    }

    /** Answers every request waiting for the prompt with the permission's state now. UI thread. */
    private static void answerWaiting() {
        List<Object[]> answered = new ArrayList<>(waiting);
        waiting.clear();
        for (Object[] w : answered) answerPermission((Mounter) w[0], (Integer) w[1]);
    }
}
