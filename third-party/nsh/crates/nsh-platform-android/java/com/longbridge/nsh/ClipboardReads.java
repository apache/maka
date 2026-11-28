package com.longbridge.nsh;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.graphics.BitmapFactory;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * {@code Clipboard.readImage} / {@code readFiles}: what the clip's content
 * URIs hold. Android's clipboard has no image or file list of its own: apps
 * put {@code content:} URIs on it, which only the focused app may read.
 */
final class ClipboardReads {
    /** `nsh_core::platform::clipboard::MAX_IMAGE_BYTES`. */
    static final int MAX_IMAGE_BYTES = 48 << 20;

    private ClipboardReads() {}

    /** The clip's URIs, in order; empty when it holds none or may not be read. */
    private static List<Uri> uris(Context context) {
        List<Uri> out = new ArrayList<>();
        ClipboardManager board = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (board == null || !board.hasPrimaryClip()) return out;
        ClipData clip = board.getPrimaryClip();
        if (clip == null) return out;
        for (int i = 0; i < clip.getItemCount(); i++) {
            Uri uri = clip.getItemAt(i).getUri();
            if (uri != null) out.add(uri);
        }
        return out;
    }

    /** Whether the clip says it holds an image, without reading it. */
    static boolean hasImage(Context context) {
        ClipboardManager board = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (board == null || !board.hasPrimaryClip()) return false;
        ClipDescription d = board.getPrimaryClipDescription();
        return d != null && d.hasMimeType("image/*");
    }

    /**
     * The clip's first image: {@code {mime, bytes, width, height}}; {@code
     * {mime, null, size}} when it is over the limit; null when there is none.
     */
    static Object[] readImage(Context context) {
        ContentResolver resolver = context.getContentResolver();
        for (Uri uri : uris(context)) {
            String mime = resolver.getType(uri);
            if (mime == null || !mime.startsWith("image/")) continue;
            try (InputStream in = resolver.openInputStream(uri)) {
                if (in == null) continue;
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[64 << 10];
                int total = 0;
                for (int n; (n = in.read(buffer)) != -1; ) {
                    total += n;
                    if (total <= MAX_IMAGE_BYTES) out.write(buffer, 0, n);
                }
                if (total > MAX_IMAGE_BYTES) return new Object[] {mime, null, total};
                byte[] bytes = out.toByteArray();
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
                // Not an image Android can decode: no image.
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) continue;
                return new Object[] {mime, bytes, bounds.outWidth, bounds.outHeight};
            } catch (Exception e) {
                // A provider that went away or refuses: the next item.
            }
        }
        return null;
    }

    /**
     * The clip's files, copied into the app's cache (one folder per read, as
     * picked files are): their paths, in the clip's order.
     */
    static List<String> readFiles(Context context) {
        List<String> paths = new ArrayList<>();
        List<Uri> uris = uris(context);
        if (uris.isEmpty()) return paths;
        ContentResolver resolver = context.getContentResolver();
        File dir = new File(new File(context.getCacheDir(), "nsh-clipboard"), Long.toString(System.nanoTime()));
        for (Uri uri : uris) {
            String scheme = uri.getScheme();
            if ("file".equals(scheme)) {
                if (uri.getPath() != null) paths.add(uri.getPath());
                continue;
            }
            if (!"content".equals(scheme)) continue;
            String name = Picker.displayName(resolver, uri);
            // Provider names are untrusted path components.
            if (name.isEmpty() || name.equals(".") || name.equals("..") || name.indexOf('/') >= 0
                    || name.indexOf('\\') >= 0) continue;
            File file = new File(new File(dir, Integer.toString(paths.size())), name);
            try (InputStream in = resolver.openInputStream(uri)) {
                if (in == null) continue;
                if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) continue;
                PickedPaths.copy(in, file);
                paths.add(file.getPath());
            } catch (Exception e) {
                // Unreadable: left out.
            }
        }
        return paths;
    }

    /**
     * {@code Clipboard.writeImage}: the image of {@code dataUri} on the
     * clipboard, as a {@code content:} URI the app's {@link FilesProvider}
     * serves from its cache. False when it is no base64 image.
     */
    static boolean writeImage(Context context, String dataUri) {
        int comma = dataUri.indexOf(',');
        if (!dataUri.startsWith("data:image/") || comma < 0) return false;
        String head = dataUri.substring(5, comma);
        if (!head.endsWith(";base64")) return false;
        String mime = head.substring(0, head.length() - 7);
        String extension = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        byte[] bytes;
        try {
            bytes = android.util.Base64.decode(dataUri.substring(comma + 1), android.util.Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return false;
        }
        File dir = new File(new File(context.getCacheDir(), "nsh-clipboard"), "write");
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        if (!dir.isDirectory() && !dir.mkdirs()) return false;
        File file = new File(dir, "image" + System.nanoTime() + "." + (extension != null ? extension : "png"));
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(file)) {
            out.write(bytes);
        } catch (java.io.IOException e) {
            return false;
        }
        Uri uri = FilesProvider.uriFor(context, file);
        ClipboardManager board = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (uri == null || board == null) return false;
        board.setPrimaryClip(ClipData.newUri(context.getContentResolver(), "image", uri));
        return true;
    }
}
