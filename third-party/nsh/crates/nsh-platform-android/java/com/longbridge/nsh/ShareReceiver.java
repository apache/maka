package com.longbridge.nsh;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Takes the files other apps share to this one (the share sheet: {@code ACTION_SEND} and {@code ACTION_SEND_MULTIPLE}
 * intents, which the manifest declares for the MIME types of nsh.json {@code fileTypes}). The app cannot read a
 * {@code content://} stream as a path, so each is copied into the app's cache and the copy reaches the app as a
 * {@code file://} URL, as an opened file does ({@code Application.on("openFiles")}).
 *
 * <p>The intent comes from any app (the activity is exported): only {@code content://} streams of an accepted MIME
 * type are copied, to a name this class makes, never a path the sender chose, within {@link #MAX_FILES} files and
 * {@link #MAX_FILE_BYTES} bytes each.
 */
final class ShareReceiver {
    /** Manifest meta-data: the accepted MIME types, separated by spaces ({@code nsh package} writes it). */
    private static final String MIME_TYPES = "com.longbridge.nsh.SHARE_MIME_TYPES";

    /** Fits in the native host's pre-launch URL queue, even before the engine has started. */
    private static final int MAX_FILES = 16;

    /** The largest file taken (bytes); a larger one is skipped. */
    private static final long MAX_FILE_BYTES = 256L << 20;

    /** The most bytes read from one share and the most bytes stored across shares. */
    private static final long MAX_TOTAL_BYTES = 512L << 20;
    private static final long MAX_CACHE_BYTES = 1024L << 20;

    /** Copies older than this are deleted as a share comes (milliseconds). */
    private static final long KEEP_MILLIS = 7L * 24 * 60 * 60 * 1000;

    private static final int MAX_NAME = 60; // Even four-byte UTF-8 characters fit in a filesystem name.

    // Do not let repeated intents start unbounded copies or queue unbounded work.
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(0, 1, 30, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(1), new ThreadPoolExecutor.DiscardPolicy());

    void destroy() {
        worker.shutdownNow();
    }

    static boolean isShare(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        return Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
    }

    /**
     * Copies the files {@code intent} shares in the background and hands each copy's URL to {@code opened} on the UI
     * thread. Does nothing for another intent, for an app that declared no MIME types and for a launch from the
     * recent apps list (its intent was handled when it first came).
     */
    void handle(Activity activity, Intent intent, java.util.function.Consumer<String> opened) {
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        List<String> accepted = accepted(activity);
        if (accepted.isEmpty()) return;
        List<Uri> uris = streams(intent);
        if (uris.isEmpty()) return;
        // The URI permission lasts while the activity does. Check it on the
        // worker so provider resolution does not delay the activity.
        ContentResolver resolver = activity.getContentResolver();
        File root = new File(activity.getCacheDir(), "nsh-shared-files");
        worker.execute(() -> {
            Set<String> ownAuthorities = ownAuthorities(activity);
            if (ownAuthorities == null) return;
            uris.removeIf(uri -> !canRead(activity, uri, ownAuthorities));
            if (uris.isEmpty()) return;
            List<String> urls = copy(resolver, root, uris, accepted);
            if (!urls.isEmpty()) activity.runOnUiThread(() -> {
                if (!activity.isDestroyed()) urls.forEach(opened);
            });
        });
    }

    @SuppressWarnings("deprecation")
    private static Set<String> ownAuthorities(Activity activity) {
        try {
            ProviderInfo[] providers = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), PackageManager.GET_PROVIDERS).providers;
            Set<String> authorities = new HashSet<>();
            if (providers != null) {
                for (ProviderInfo provider : providers) {
                    for (String authority : provider.authority.split(";")) authorities.add(authority);
                }
            }
            return authorities;
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
    }

    private static boolean canRead(Activity activity, Uri uri, Set<String> ownAuthorities) {
        if (!"content".equals(uri.getScheme())) return false;
        String authority = uri.getAuthority();
        if (authority == null) return false;
        // A content URI may be qualified by a profile/user id.
        authority = authority.substring(authority.lastIndexOf('@') + 1);
        // Other providers may be hidden by Android package visibility.
        if (ownAuthorities.contains(authority)) return false;
        try {
            int uid = android.os.Process.myUid();
            return activity.checkUriPermission(uri, android.os.Process.myPid(), uid,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED;
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static List<String> accepted(Activity activity) {
        List<String> list = new ArrayList<>();
        try {
            android.content.pm.ApplicationInfo info = activity.getPackageManager()
                    .getApplicationInfo(activity.getPackageName(), android.content.pm.PackageManager.GET_META_DATA);
            String value = info.metaData == null ? null : info.metaData.getString(MIME_TYPES);
            if (value != null) {
                for (String type : value.split(" ")) {
                    if (!type.isEmpty()) list.add(type.toLowerCase(Locale.ROOT));
                }
            }
        } catch (android.content.pm.PackageManager.NameNotFoundException e) {
            // No manifest entry of its own: nothing is accepted.
        }
        return list;
    }

    /** The streams of a share: {@code EXTRA_STREAM}, else the clip's items; each once, at most {@link #MAX_FILES}. */
    @SuppressWarnings("deprecation")
    private static List<Uri> streams(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        try {
            if (Intent.ACTION_SEND.equals(intent.getAction())) {
                Uri uri = Build.VERSION.SDK_INT >= 34
                        ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                        : (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (uri != null) uris.add(uri);
            } else {
                ArrayList<?> list = Build.VERSION.SDK_INT >= 34
                        ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
                        : intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                for (int i = 0; list != null && i < Math.min(list.size(), MAX_FILES); i++) {
                    if (list.get(i) instanceof Uri) {
                        Uri uri = (Uri) list.get(i);
                        if (!uris.contains(uri)) uris.add(uri);
                    }
                }
            }
        } catch (RuntimeException e) {
            // A stream of another type, or one the sender's classes made: nothing to take.
            uris.clear();
        }
        if (uris.isEmpty()) {
            ClipData clip = intent.getClipData();
            for (int i = 0; clip != null && i < Math.min(clip.getItemCount(), MAX_FILES); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null && !uris.contains(uri)) uris.add(uri);
            }
        }
        return uris;
    }

    private static List<String> copy(ContentResolver resolver, File root, List<Uri> uris, List<String> accepted) {
        List<String> urls = new ArrayList<>();
        long cached = cachedBytes(root);
        long remaining = MAX_TOTAL_BYTES;
        byte[] buffer = new byte[64 * 1024];
        for (Uri uri : uris) {
            if (remaining <= 0 || cached >= MAX_CACHE_BYTES || Thread.currentThread().isInterrupted()) break;
            String type;
            try {
                type = resolver.getType(uri);
            } catch (RuntimeException e) {
                continue; // The provider rejected the URI or the grant was revoked.
            }
            if (!matches(accepted, type)) continue;
            File dir = new File(root, UUID.randomUUID().toString());
            if (!dir.mkdirs()) continue;
            File file = new File(dir, safeName(displayName(resolver, uri), type));
            long size = 0;
            try (InputStream in = resolver.openInputStream(uri); OutputStream out = new java.io.FileOutputStream(file)) {
                if (in == null) throw new IOException("no stream");
                // Read at most one byte beyond the limit to tell a full file from a partial copy.
                long limit = Math.min(MAX_FILE_BYTES, Math.min(remaining, MAX_CACHE_BYTES - cached));
                int read;
                while ((read = in.read(buffer, 0, (int) Math.min(buffer.length, limit - size + 1))) != -1) {
                    size += read;
                    remaining -= read;
                    if (size > limit || Thread.currentThread().isInterrupted()) throw new IOException("copy stopped");
                    out.write(buffer, 0, read);
                }
            } catch (IOException | RuntimeException e) {
                // Unreadable, revoked or too large: the file is not taken.
                android.util.Log.w("nsh", "shared file skipped: " + e.getMessage());
                file.delete();
                dir.delete();
                continue;
            }
            cached += cacheCost(size);
            urls.add(Uri.fromFile(file).toString());
        }
        return urls;
    }

    /** Whether {@code type} is one of {@code accepted}: exact, {@code type/*} or {@code *}{@code /*}. */
    private static boolean matches(List<String> accepted, String type) {
        if (type == null) return false;
        String lower = type.toLowerCase(Locale.ROOT);
        int slash = lower.indexOf('/');
        if (slash <= 0 || slash == lower.length() - 1 || lower.indexOf('*') >= 0) return false;
        String group = lower.substring(0, slash) + "/*";
        for (String candidate : accepted) {
            if (candidate.equals(lower) || candidate.equals(group) || candidate.equals("*/*")) return true;
        }
        return false;
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (RuntimeException e) {
            // A provider without a name: one is made.
        }
        return null;
    }

    /**
     * A name safe to create under the share's own directory: the last path segment only, letters, digits and
     * {@code ._- } kept, no leading dot, bounded; the extension of {@code type} when the name has none.
     */
    private static String safeName(String name, String type) {
        String base = name == null ? "" : name;
        int cut = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        base = base.substring(cut + 1);
        StringBuilder clean = new StringBuilder();
        for (int i = 0; i < base.length(); ) {
            int c = base.codePointAt(i);
            i += Character.charCount(c);
            if (Character.isLetterOrDigit(c) || c == '.' || c == '_' || c == '-' || c == ' ') clean.appendCodePoint(c);
            else clean.append('_');
        }
        String result = clean.toString().trim().replaceFirst("^\\.+", "");
        if (result.codePointCount(0, result.length()) > MAX_NAME) {
            int dot = result.lastIndexOf('.');
            String extension = dot > 0 && result.length() - dot <= 16 ? result.substring(dot) : "";
            result = result.substring(0, result.offsetByCodePoints(0, MAX_NAME - extension.length())) + extension;
        }
        if (result.isEmpty()) result = "shared";
        if (result.indexOf('.') < 0 && type != null) {
            String extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(type.toLowerCase(Locale.ROOT));
            if (extension != null) result += "." + extension;
        }
        return result;
    }

    // Tiny files still consume an inode and a directory. Count them toward the quota too.
    private static long cacheCost(long bytes) {
        return Math.max(1L << 20, bytes);
    }

    private static long cachedBytes(File root) {
        File[] dirs = root.listFiles();
        if (dirs == null) return 0;
        long limit = System.currentTimeMillis() - KEEP_MILLIS;
        long bytes = 0;
        for (File dir : dirs) {
            File[] files = dir.listFiles();
            if (files == null) continue;
            boolean expired = dir.lastModified() < limit;
            for (File file : files) {
                if (!expired || !file.delete()) bytes += cacheCost(file.length());
            }
            if (expired) dir.delete();
        }
        return bytes;
    }
}
