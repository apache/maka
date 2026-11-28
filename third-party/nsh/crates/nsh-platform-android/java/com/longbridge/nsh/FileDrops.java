package com.longbridge.nsh;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ContentResolver;
import android.content.Context;
import android.content.ContextWrapper;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import android.view.DragAndDropPermissions;
import android.view.DragEvent;
import android.view.View;
import android.view.ViewParent;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Files dragged in from other apps (`onFileDragEnter`, `onFileDragLeave`,
 * `onFileDrop`), as another app in split screen or a freeform window drags
 * them (`View.DRAG_FLAG_GLOBAL`).
 *
 * <p>Android sends a drag's events to the views under it that took interest
 * when it started; the surface's view takes drags that offer content rather
 * than text, and its inputs leave them to it ({@link #offersFiles}). The
 * destination is the closest view under the drag, by the touch hit testing
 * ({@link TouchTracker#deepest}), that listens to `onFileDrop` and is enabled;
 * modals are windows of their own, outside this view. Moving between
 * destinations leaves one and enters the other; leaving the view, ending the
 * drag and dropping clear it.
 *
 * <p>Android opens a drag's data only at the drop, and only as content URIs
 * readable while the drop's permissions are held: the enter carries no URLs,
 * and the drop is delivered once each file is copied into the app's cache
 * (as the picker's paths are), as {@code file:} URLs with the provider's
 * names, so the names' MIME types hold. The destination hears its leave after
 * its drop, as on the other platforms.
 */
final class FileDrops implements View.OnDragListener {
    private static final String TAG = "nsh";

    private final Mounter mounter;
    private final View root;
    /** The destination under the drag, 0 when none. */
    private int target;
    /** The drag in progress offers files. */
    private boolean files;

    FileDrops(Mounter mounter, View root) {
        this.mounter = mounter;
        this.root = root;
    }

    /** Whether a drag offers content rather than text: text drags stay the inputs'. */
    static boolean offersFiles(ClipDescription description) {
        if (description == null) return false;
        for (int i = 0; i < description.getMimeTypeCount(); i++) {
            if (!description.getMimeType(i).startsWith("text/")) return true;
        }
        return false;
    }

    @Override
    public boolean onDrag(View v, DragEvent e) {
        switch (e.getAction()) {
            case DragEvent.ACTION_DRAG_STARTED:
                files = offersFiles(e.getClipDescription());
                return files;
            case DragEvent.ACTION_DRAG_ENTERED:
                return true;
            case DragEvent.ACTION_DRAG_LOCATION:
                setTarget(files ? targetAt(e.getX(), e.getY()) : 0, true);
                return true;
            case DragEvent.ACTION_DRAG_EXITED:
                setTarget(0, true);
                return true;
            case DragEvent.ACTION_DROP:
                return drop(e);
            case DragEvent.ACTION_DRAG_ENDED:
                setTarget(0, true);
                files = false;
                return true;
            default:
                return false;
        }
    }

    /** The destination at ({@code x}, {@code y}) of the root, 0 when none. */
    private int targetAt(float x, float y) {
        return targetAt(mounter, root, x, y);
    }

    /** The destination at ({@code x}, {@code y}) of {@code root}, 0 when none. */
    static int targetAt(Mounter mounter, View root, float x, float y) {
        for (View v = TouchTracker.deepest(root, x, y); v != null; ) {
            if (v instanceof Node) {
                int id = ((Node) v).nodeId();
                if (mounter.takesFileDrops(id)) return id;
            }
            if (v == root) break;
            ViewParent p = v.getParent();
            v = p instanceof View ? (View) p : null;
        }
        return 0;
    }

    /** Makes {@code id} the destination; {@code leave}: the previous one hears it left. */
    private void setTarget(int id, boolean leave) {
        if (id == target) return;
        int previous = target;
        target = id;
        if (leave && previous != 0 && mounter.wants(previous, Native.FILE_DRAG_LEAVE)) {
            mounter.event(previous, Native.FILE_DRAG_LEAVE);
        }
        if (id != 0 && mounter.wants(id, Native.FILE_DRAG_ENTER)) {
            mounter.fileDrop(id, Native.FILE_DRAG_ENTER, new String[0], 0, 0);
        }
    }

    /**
     * The drop: whether a destination takes it. The files are copied away
     * from the main thread while the drop's permissions are held; the
     * destination then hears the drop and its leave.
     */
    private boolean drop(DragEvent e) {
        float x = e.getX(), y = e.getY();
        int id = files ? targetAt(x, y) : 0;
        ClipData clip = e.getClipData();
        List<Uri> uris = new ArrayList<>();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        }
        if (id == 0 || uris.isEmpty()) {
            setTarget(0, true);
            return false;
        }
        setTarget(id, true);
        // The drop's leave follows its delivery.
        target = 0;
        Context context = root.getContext();
        Activity activity = activity(context);
        DragAndDropPermissions permissions = activity != null ? activity.requestDragAndDropPermissions(e) : null;
        ContentResolver resolver = context.getContentResolver();
        File cache = context.getCacheDir();
        new Thread(() -> {
            String[] copied;
            try {
                copied = copy(resolver, uris, cache);
            } finally {
                if (permissions != null) permissions.release();
            }
            root.post(() -> deliver(id, copied, x, y));
        }, "nsh-file-drop").start();
        return true;
    }

    /** The drop of {@code uris} at ({@code x}, {@code y}) of the root reaches {@code id}, then its leave. */
    private void deliver(int id, String[] uris, float x, float y) {
        // Removed or disabled meanwhile: no drop.
        if (uris.length > 0 && mounter.takesFileDrops(id)) mounter.fileDrop(id, Native.FILE_DROP, uris, x, y);
        if (mounter.wants(id, Native.FILE_DRAG_LEAVE)) mounter.event(id, Native.FILE_DRAG_LEAVE);
    }

    /** App-owned copies of {@code uris}' contents, as {@code file:} URLs; those that cannot be read are left out. */
    private static String[] copy(ContentResolver resolver, List<Uri> uris, File cache) {
        List<String> copied = new ArrayList<>();
        File directory = new File(cache, "nsh-dropped-" + java.util.UUID.randomUUID());
        if (!directory.mkdir()) {
            Log.w(TAG, "cannot create the dropped files' cache");
            return new String[0];
        }
        for (int i = 0; i < uris.size(); i++) {
            Uri uri = uris.get(i);
            if ("file".equals(uri.getScheme())) {
                copied.add(uri.toString());
                continue;
            }
            // Separate roots keep identical names from different providers.
            File parent = new File(directory, Integer.toString(i));
            File file = new File(parent, name(resolver, uri));
            try (InputStream in = resolver.openInputStream(uri)) {
                if (!parent.mkdir()) throw new java.io.IOException("cannot create the dropped file's folder");
                PickedPaths.copy(in, file);
                copied.add(Uri.fromFile(file).toString());
            } catch (Exception e) {
                Log.w(TAG, "cannot copy a dropped file", e);
            }
        }
        if (copied.isEmpty() && !directory.delete()) directory.deleteOnExit();
        return copied.toArray(new String[0]);
    }

    /**
     * The file name for {@code uri}'s copy: the provider's, with the extension
     * of its type when it has none, so that the URL's MIME type holds.
     * Provider names are untrusted path components.
     */
    private static String name(ContentResolver resolver, Uri uri) {
        String name = null;
        try (Cursor c = resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception e) {
            // Some providers answer no queries.
        }
        if (name == null || name.isEmpty() || name.equals(".") || name.equals("..") || name.indexOf('/') >= 0
                || name.indexOf('\\') >= 0) {
            name = "file";
        }
        if (name.lastIndexOf('.') <= 0) {
            String type = resolver.getType(uri);
            String extension = type != null ? MimeTypeMap.getSingleton().getExtensionFromMimeType(type) : null;
            if (extension != null) name = name + "." + extension;
        }
        return name;
    }

    private static Activity activity(Context context) {
        while (context instanceof ContextWrapper) {
            if (context instanceof Activity) return (Activity) context;
            context = ((ContextWrapper) context).getBaseContext();
        }
        return null;
    }
}
