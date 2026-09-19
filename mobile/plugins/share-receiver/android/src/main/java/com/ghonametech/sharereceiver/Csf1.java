package com.ghonametech.sharereceiver;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The "CSF1" chunked AES-256-GCM file format, encrypt side, for files shared
 * into the app. Must stay byte-compatible with desktop/src/file-crypto.ts
 * (where the format is documented) and web/src/app/core/file-crypto.ts.
 *
 * Plain Java (no Android APIs) so it can be checked against the shared test
 * vector on a desktop JDK.
 */
public final class Csf1 {

    public static final int HEADER_BYTES = 16;
    public static final int TAG_BYTES = 16;
    public static final int DEFAULT_CHUNK_BYTES = 1024 * 1024;
    private static final byte[] MAGIC = { 'C', 'S', 'F', '1' };

    private Csf1() {}

    /** Size of the encrypted form of a file of {@code plainBytes} bytes. */
    public static long encryptedSize(long plainBytes, int chunkBytes) {
        long chunks = Math.max(1, (plainBytes + chunkBytes - 1) / chunkBytes);
        return HEADER_BYTES + plainBytes + TAG_BYTES * chunks;
    }

    public static long encryptedSize(long plainBytes) {
        return encryptedSize(plainBytes, DEFAULT_CHUNK_BYTES);
    }

    /** Callback for bytes written so far. */
    public interface Progress {
        void onBytes(long written);
    }

    public static void encrypt(InputStream in, OutputStream out, byte[] key, Progress progress)
        throws IOException, GeneralSecurityException {
        byte[] prefix = new byte[8];
        new SecureRandom().nextBytes(prefix);
        encrypt(in, out, key, DEFAULT_CHUNK_BYTES, prefix, progress);
    }

    /** Streams {@code in} to {@code out} encrypted; chunk size and prefix are fixed only by tests. */
    public static void encrypt(InputStream in, OutputStream out, byte[] key, int chunkBytes, byte[] prefix, Progress progress)
        throws IOException, GeneralSecurityException {
        if (key.length != 32) {
            throw new IllegalArgumentException("File key must be 32 bytes");
        }
        SecretKeySpec keySpec = new SecretKeySpec(key, "AES");
        ByteBuffer header = ByteBuffer.allocate(HEADER_BYTES);
        header.put(MAGIC).putInt(chunkBytes).put(prefix);
        out.write(header.array());
        long written = HEADER_BYTES;

        byte[] current = new byte[chunkBytes];
        byte[] next = new byte[chunkBytes];
        int currentLen = fill(in, current);
        for (int index = 0; ; index++) {
            // Read ahead: a chunk is the last one only if nothing follows it.
            int nextLen = fill(in, next);
            boolean last = nextLen == 0;

            byte[] iv = ByteBuffer.allocate(12).put(prefix).putInt(index).array();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keySpec, new GCMParameterSpec(TAG_BYTES * 8, iv));
            cipher.updateAAD(new byte[] { (byte) (last ? 1 : 0) });
            byte[] sealed = cipher.doFinal(current, 0, currentLen);
            out.write(sealed);
            written += sealed.length;
            if (progress != null) {
                progress.onBytes(written);
            }
            if (last) {
                return;
            }
            byte[] swap = current;
            current = next;
            next = swap;
            currentLen = nextLen;
        }
    }

    /** Reads until {@code buffer} is full or the stream ends; returns bytes read. */
    private static int fill(InputStream in, byte[] buffer) throws IOException {
        int total = 0;
        while (total < buffer.length) {
            int read = in.read(buffer, total, buffer.length - total);
            if (read < 0) {
                break;
            }
            total += read;
        }
        return total;
    }
}
