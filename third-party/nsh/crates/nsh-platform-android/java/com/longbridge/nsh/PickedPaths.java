package com.longbridge.nsh;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** App-owned copies of provider streams, independent of Android for large-file regression tests. */
final class PickedPaths {
    private PickedPaths() {}

    /** The caller owns the stream. Never replaces a file or leaves a partial copy on failure. */
    static void copy(InputStream in, File file) throws IOException {
        if (in == null) throw new IOException("no stream for picked file");
        if (!file.createNewFile()) throw new IOException("duplicate document name");
        boolean complete = false;
        try {
            try (FileOutputStream out = new FileOutputStream(file)) {
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) != -1; ) out.write(buffer, 0, n);
            }
            complete = true;
        } finally {
            if (!complete && !file.delete()) file.deleteOnExit();
        }
    }
}
