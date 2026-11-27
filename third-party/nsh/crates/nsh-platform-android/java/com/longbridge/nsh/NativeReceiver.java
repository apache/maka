package com.longbridge.nsh;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

/**
 * Broadcasts received in Rust ({@code nsh::receiver} of the {@code nsh-platform-android} crate): a receiver registered
 * on the application for one action whose {@link #onReceive} reaches the Rust handler {@code handle} names, so Rust
 * code (an nshm) hears a broadcast without shipping a {@link BroadcastReceiver} subclass of its own, which {@code
 * nsh::proxy} cannot make (it is a class, not an interface). Not exported ({@link #registerNotExported}): it hears
 * the app's own broadcasts (a {@code PendingIntent}'s) and the system's, not other apps'.
 */
final class NativeReceiver extends BroadcastReceiver {
    private static final String TAG = "com.longbridge.nsh.NativeReceiver";
    /**
     * The suffix of the signature permission that keeps a receiver to the app before Android 13, which the manifests
     * NSH writes declare and use: androidx's {@code ContextCompat} name, so an app with androidx gets one permission.
     */
    private static final String NOT_EXPORTED_PERMISSION = ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION";
    private final long handle;

    private NativeReceiver(long handle) {
        this.handle = handle;
    }

    /**
     * Registers a receiver of {@code action} whose broadcasts reach handler {@code handle} on the UI thread; {@code
     * null} before any {@code NshView} was made. Any thread.
     */
    static Object register(String action, long handle) {
        Context context = Permissions.application();
        if (context == null) return null;
        NativeReceiver receiver = new NativeReceiver(handle);
        registerNotExported(context, receiver, new IntentFilter(action));
        return receiver;
    }

    /**
     * Registers {@code receiver} on {@code context} for the app's own broadcasts and the system's, as androidx's {@code
     * ContextCompat.registerReceiver(..., RECEIVER_NOT_EXPORTED)} does: Android 13+ has the flag; before, a receiver
     * registered at run time is exported, so senders need the app's signature permission, which only the app (and
     * the system) holds. A broadcast another system app sends under its own uid does not reach it there. Throws
     * {@link IllegalStateException} when the app's manifest lacks the permission (Android 12 and below). Any thread.
     */
    static void registerNotExported(Context context, BroadcastReceiver receiver, IntentFilter filter) {
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
            return;
        }
        String permission = context.getPackageName() + NOT_EXPORTED_PERMISSION;
        // Without it the app's own broadcasts would not arrive either.
        if (context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            throw new IllegalStateException(
                    "the app's manifest does not declare and use the permission `" + permission + "`");
        }
        context.registerReceiver(receiver, filter, permission, null);
    }

    /** Unregisters {@code receiver} ({@link #register}'s). Any thread. */
    static void unregister(Object receiver) {
        Context context = Permissions.application();
        if (context == null) return;
        try {
            context.unregisterReceiver((BroadcastReceiver) receiver);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "the receiver was not registered", e);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        receive(handle, intent);
    }

    /** Hands {@code intent} to handler {@code handle}, while Rust keeps it. */
    private static native void receive(long handle, Intent intent);
}
