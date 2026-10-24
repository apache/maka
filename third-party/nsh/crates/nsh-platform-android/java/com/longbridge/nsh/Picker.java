package com.longbridge.nsh;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ext.SdkExtensions;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Log;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * {@code Picker.pickImages}: the system's Photo Picker ({@code
 * MediaStore.ACTION_PICK_IMAGES}, API 33+ or 30+ with the SDK extension), else
 * a document picker for images ({@code ACTION_GET_CONTENT}). It needs no
 * permission: the system hands over only what the user picks. The result
 * comes back to a headless fragment the picker adds to the view's activity,
 * so the embedding app forwards nothing. The picked images are read and
 * prepared (scaled down, HEIC as JPEG; {@code nsh_core::picker}) on a thread
 * of their own, then go to the engine at once ({@link Native#picked}).
 */
final class Picker {
    private static final String TAG = "nsh";
    private static final String FRAGMENT = "com.longbridge.nsh.Picker";

    /** What a pick asks ({@code nsh_core::picker::PickRequest}). */
    static final class Request {
        int id;
        int limit;
        /** 0: no limit. */
        int maxDimension;
        /** Negative: none given. */
        float quality;
        boolean current;
        /** The view's engine, when the pick ends. */
        NshView view;
    }

    private Picker() {}

    /** Shows the picker for {@code request}; one that cannot be shown answers with nothing. */
    @SuppressWarnings("deprecation")
    static void show(Context context, Request request) {
        Activity activity = SystemUi.activity(context);
        if (activity == null || activity.isFinishing()) {
            Log.w(TAG, "the photo picker needs an activity");
            answer(request, new ArrayList<>());
            return;
        }
        Intent intent;
        if (photoPicker()) {
            intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
            intent.setType("image/*");
            if (request.limit > 1) {
                int max = Math.min(request.limit, MediaStore.getPickImagesMaxLimit());
                if (max > 1) intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, max);
            }
        } else {
            intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.setType("image/*");
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, request.limit > 1);
        }
        android.app.FragmentManager manager = activity.getFragmentManager();
        Results results = (Results) manager.findFragmentByTag(FRAGMENT);
        if (results == null) {
            results = new Results();
            manager.beginTransaction().add(results, FRAGMENT).commitNow();
        }
        results.start(intent, request);
    }

    /** Whether the system's Photo Picker is there. */
    private static boolean photoPicker() {
        if (Build.VERSION.SDK_INT >= 33) return true;
        return Build.VERSION.SDK_INT >= 30 && SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) >= 2;
    }

    /**
     * Starts the pickers and hears their results: headless, kept across the
     * activity's configuration changes.
     */
    @SuppressWarnings("deprecation")
    public static final class Results extends android.app.Fragment {
        private final android.util.SparseArray<Request> pending = new android.util.SparseArray<>();
        private int next = 0x4e00;

        @Override
        public void onCreate(Bundle state) {
            super.onCreate(state);
            setRetainInstance(true);
        }

        void start(Intent intent, Request request) {
            int code = next++;
            if (next > 0x4eff) next = 0x4e00;
            pending.put(code, request);
            try {
                startActivityForResult(intent, code);
            } catch (RuntimeException e) {
                Log.w(TAG, "cannot show the photo picker", e);
                pending.remove(code);
                answer(request, new ArrayList<>());
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
            List<Uri> uris = new ArrayList<>();
            if (result == Activity.RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
                } else if (data.getData() != null) {
                    uris.add(data.getData());
                }
            }
            if (uris.size() > request.limit) uris = uris.subList(0, request.limit);
            ContentResolver resolver = getActivity().getContentResolver();
            List<Uri> picked = uris;
            Log.i(TAG, "picked " + uris.size() + " image(s)");
            new Thread(() -> answer(request, read(resolver, picked, request)), "nsh-picker").start();
        }
    }

    /** One prepared file. */
    private static final class Picked {
        String name;
        String type;
        byte[] bytes;
        int width;
        int height;
    }

    private static List<Picked> read(ContentResolver resolver, List<Uri> uris, Request request) {
        List<Picked> files = new ArrayList<>();
        for (Uri uri : uris) {
            try {
                Picked file = prepare(resolver, uri, request);
                if (file != null) files.add(file);
            } catch (Exception | OutOfMemoryError e) {
                Log.w(TAG, "cannot read a picked image", e);
            }
        }
        return files;
    }

    private static void answer(Request request, List<Picked> files) {
        int n = files.size();
        String[] names = new String[n];
        String[] types = new String[n];
        byte[][] data = new byte[n][];
        int[] sizes = new int[n * 2];
        for (int i = 0; i < n; i++) {
            Picked f = files.get(i);
            names[i] = f.name;
            types[i] = f.type;
            data[i] = f.bytes;
            sizes[i * 2] = f.width;
            sizes[i * 2 + 1] = f.height;
        }
        long handle = request.view.handle;
        if (handle != 0) Native.picked(handle, request.id, names, types, data, sizes);
    }

    private static Picked prepare(ContentResolver resolver, Uri uri, Request request) throws Exception {
        byte[] bytes = readAll(resolver, uri);
        if (bytes == null) return null;
        Picked file = new Picked();
        file.name = displayName(resolver, uri);
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        String type = bounds.outMimeType != null ? bounds.outMimeType : resolver.getType(uri);
        file.type = type != null ? type.toLowerCase(java.util.Locale.ROOT) : "";
        int orientation = orientation(bytes);
        boolean turned = orientation >= 5 && orientation <= 8;
        int width = turned ? bounds.outHeight : bounds.outWidth;
        int height = turned ? bounds.outWidth : bounds.outHeight;
        file.width = Math.max(0, width);
        file.height = Math.max(0, height);
        int encoding = encoding(file.type, width, height, request);
        if (encoding == KEEP || width <= 0 || height <= 0) {
            file.bytes = bytes;
            return file;
        }
        // The size to scale to, the aspect ratio kept.
        int longer = Math.max(width, height);
        float scale = request.maxDimension > 0 && longer > request.maxDimension ? (float) request.maxDimension / longer : 1f;
        int targetW = Math.max(1, Math.round(width * scale));
        int targetH = Math.max(1, Math.round(height * scale));
        BitmapFactory.Options decode = new BitmapFactory.Options();
        int sample = 1;
        while (longer / (sample * 2) >= Math.max(targetW, targetH)) sample *= 2;
        decode.inSampleSize = sample;
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, decode);
        if (bitmap == null) return null;
        Matrix matrix = orientationMatrix(orientation);
        int bw = turned ? bitmap.getHeight() : bitmap.getWidth();
        int bh = turned ? bitmap.getWidth() : bitmap.getHeight();
        matrix.postScale((float) targetW / bw, (float) targetH / bh);
        Bitmap scaled = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
        if (scaled != bitmap) bitmap.recycle();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        boolean png = encoding == PNG;
        float quality = request.quality >= 0 ? request.quality : 0.9f;
        scaled.compress(png ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG,
                Math.round(Math.max(0f, Math.min(1f, quality)) * 100), out);
        file.width = scaled.getWidth();
        file.height = scaled.getHeight();
        scaled.recycle();
        file.bytes = out.toByteArray();
        file.type = png ? "image/png" : "image/jpeg";
        return file;
    }

    /** The bytes at {@code uri}, read into one array of their length when the provider tells it. */
    private static byte[] readAll(ContentResolver resolver, Uri uri) throws Exception {
        long length = -1;
        try (android.content.res.AssetFileDescriptor fd = resolver.openAssetFileDescriptor(uri, "r")) {
            if (fd != null) length = fd.getLength();
        } catch (Exception e) {
            // Unknown length: read it in pieces.
        }
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) return null;
            if (length > 0 && length < Integer.MAX_VALUE) {
                byte[] bytes = new byte[(int) length];
                int read = 0;
                for (int n; read < bytes.length && (n = in.read(bytes, read, bytes.length - read)) > 0; ) read += n;
                if (read == bytes.length && in.read() < 0) return bytes;
                ByteArrayOutputStream out = new ByteArrayOutputStream(read + 64 * 1024);
                out.write(bytes, 0, read);
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                return out.toByteArray();
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toByteArray();
        }
    }

    private static final int KEEP = 0, PNG = 1, JPEG = 2;

    /** What {@code nsh_core::picker::PickRequest::needs_encoding} says. */
    private static int encoding(String type, int width, int height, Request request) {
        boolean png = type.equals("image/png");
        boolean scale = request.maxDimension > 0 && Math.max(width, height) > request.maxDimension;
        boolean foreign = !(type.equals("image/jpeg") || png || type.equals("image/gif") || type.equals("image/webp"));
        boolean convert = !request.current && foreign;
        boolean requality = request.quality >= 0 && type.equals("image/jpeg");
        if (png && scale) return PNG;
        if (scale || convert || requality) return JPEG;
        return KEEP;
    }

    private static int orientation(byte[] bytes) {
        try {
            return new ExifInterface(new ByteArrayInputStream(bytes))
                    .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Exception e) {
            return ExifInterface.ORIENTATION_NORMAL;
        }
    }

    /** What turns an image stored with EXIF {@code orientation} upright. */
    private static Matrix orientationMatrix(int orientation) {
        Matrix m = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: m.setScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_180: m.setRotate(180); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: m.setScale(1, -1); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: m.setRotate(90); m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_90: m.setRotate(90); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: m.setRotate(-90); m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_270: m.setRotate(-90); break;
            default: break;
        }
        return m;
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor c = resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null) return name;
            }
        } catch (Exception e) {
            // Some providers answer no queries.
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "image";
    }
}
