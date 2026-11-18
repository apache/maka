package com.longbridge.nsh;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.util.Arrays;

/** Run with -Xmx32m: copying a 513 MiB provider stream must not require a file-sized buffer. */
public final class PickedPathsTest {
    public static void main(String[] args) throws Exception {
        File directory = Files.createTempDirectory("nsh-picked-paths-").toFile();
        File file = new File(directory, "large file.bin");
        long size = 513L * 1024 * 1024 + 17;
        try {
            InputStream generated = new InputStream() {
                long left = size;
                public int read() { if (left == 0) return -1; left--; return 90; }
                public int read(byte[] buffer, int offset, int length) {
                    if (left == 0) return -1;
                    int count = (int) Math.min(left, length);
                    Arrays.fill(buffer, offset, offset + count, (byte) 90);
                    left -= count;
                    return count;
                }
            };
            PickedPaths.copy(generated, file);
            if (file.length() != size) throw new AssertionError("large file truncated");
            try (RandomAccessFile read = new RandomAccessFile(file, "r")) {
                read.seek(size - 1);
                if (read.read() != 90) throw new AssertionError("last byte differs");
            }
            try {
                PickedPaths.copy(new ByteArrayInputStream(new byte[0]), file);
                throw new AssertionError("existing file overwritten");
            } catch (IOException expected) {}
            if (file.length() != size) throw new AssertionError("existing file changed");
            Files.delete(file.toPath());
            try {
                PickedPaths.copy(new InputStream() {
                    public int read() throws IOException { throw new IOException("provider disconnected"); }
                }, file);
                throw new AssertionError("failed stream accepted");
            } catch (IOException expected) {}
            if (file.exists()) throw new AssertionError("partial copy left behind");
            try {
                PickedPaths.copy(null, file);
                throw new AssertionError("missing stream accepted");
            } catch (IOException expected) {}
            System.out.println("PickedPathsTest: 513 MiB streamed with 32 MiB heap; failure cleanup passed");
        } finally {
            Files.deleteIfExists(file.toPath());
            Files.delete(directory.toPath());
        }
    }
}
