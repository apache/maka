package com.longbridge.nsh;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileNotFoundException;

/**
 * Hands the app's own files to other apps as {@code content:} URIs: the
 * system's viewer reads a file of the app's private storage through {@link
 * #openFile}, which no {@code file:} URI would let it. {@link
 * SystemUi#openPath} builds the URIs ({@link #uriFor}). The authority is the
 * app's package plus {@code .files}, which the packaged apps' manifests
 * declare. No androidx: the columns of {@link #query} are the standard
 * {@link OpenableColumns}, and the grant the viewer needs comes from the
 * manifest's {@code grantUriPermissions}. Only the app's own files/cache
 * directories are served, as androidx' FileProvider restricts its files to
 * configured roots; {@link #uriFor} and {@link #fileFor} share that check so
 * the caller never gets a URI the provider would refuse.
 */
public final class FilesProvider extends ContentProvider {
    /** The app's own directories: internal and external, files and cache. */
    private static File[] roots(Context context) {
        return new File[] {
                context.getFilesDir(),
                context.getCacheDir(),
                context.getNoBackupFilesDir(),
                context.getExternalFilesDir(null),
                context.getExternalCacheDir(),
        };
    }

    /** The file the provider would serve, or {@code null} when it is not
     * inside one of {@link #roots}. */
    static File servable(Context context, File file) {
        return context == null ? null : FileRoots.under(file, roots(context));
    }

    /** The {@code content:} URI the file at {@code path} opens as, or
     * {@code null} when the provider will not serve it. */
    public static Uri uriFor(Context context, File file) {
        File served = servable(context, file);
        if (served == null) return null;
        return new Uri.Builder()
                .scheme("content")
                .authority(context.getPackageName() + ".files")
                .appendPath(served.getAbsolutePath())
                .build();
    }

    /** The MIME type of the file at {@code path}, its extension's, else
     * {@code application/octet-stream}. */
    public static String typeOf(Context context, File file) {
        String name = file.getName();
        int dot = name.lastIndexOf('.');
        String extension = dot < 0 ? "" : name.substring(dot + 1);
        String mime = MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(extension.toLowerCase());
        return mime != null ? mime : "application/octet-stream";
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    /** The file the URI names, under the same roots {@link #uriFor} used. */
    private File fileFor(Uri uri) {
        String path = uri.getLastPathSegment();
        return path == null ? null : servable(getContext(), new File(path));
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
            String[] selectionArgs, String sortOrder) {
        File file = fileFor(uri);
        if (file == null) throw new SecurityException("not one of the app's files: " + uri);
        String[] columns = projection != null ? projection : new String[] {
                OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE,
        };
        MatrixCursor cursor = new MatrixCursor(columns);
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) {
                row[i] = file.getName();
            } else if (OpenableColumns.SIZE.equals(columns[i])) {
                row[i] = file.exists() ? file.length() : 0L;
            }
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        File file = fileFor(uri);
        return file == null ? "application/octet-stream" : typeOf(getContext(), file);
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode)
            throws FileNotFoundException {
        // The viewer only ever reads: never hand out a writable handle.
        if (!"r".equals(mode)) throw new FileNotFoundException(uri.toString());
        File file = fileFor(uri);
        if (file == null || !file.isFile()) throw new FileNotFoundException(uri.toString());
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection,
            String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }
}
