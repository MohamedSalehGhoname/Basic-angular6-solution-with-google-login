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

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keySpec, new GCMParameterSpec(TAG_BYTES * 8, iv(prefix, index)));
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

    /**
     * Decrypts a CSF1 stream. A chunk is held back until more data proves it
     * is not the last one, so a truncated file fails instead of decrypting
     * short.
     */
    public static void decrypt(InputStream in, OutputStream out, byte[] key, Progress progress)
        throws IOException, GeneralSecurityException {
        if (key.length != 32) {
            throw new IllegalArgumentException("File key must be 32 bytes");
        }
        byte[] header = new byte[HEADER_BYTES];
        if (fill(in, header) != HEADER_BYTES) {
            throw new IOException("Encrypted file is truncated");
        }
        for (int i = 0; i < MAGIC.length; i++) {
            if (header[i] != MAGIC[i]) {
                throw new IOException("Not an encrypted clipboard file");
            }
        }
        ByteBuffer head = ByteBuffer.wrap(header);
        head.position(4);
        int chunkBytes = head.getInt();
        if (chunkBytes < 1 || chunkBytes > 64 * 1024 * 1024) {
            throw new IOException("Encrypted file has an invalid header");
        }
        byte[] prefix = new byte[8];
        System.arraycopy(header, 8, prefix, 0, 8);

        SecretKeySpec keySpec = new SecretKeySpec(key, "AES");
        int pieceBytes = chunkBytes + TAG_BYTES;
        byte[] current = new byte[pieceBytes];
        byte[] next = new byte[pieceBytes];
        int currentLen = fill(in, current);
        long written = 0;
        for (int index = 0; ; index++) {
            int nextLen = fill(in, next);
            boolean last = nextLen == 0;
            if (currentLen < TAG_BYTES) {
                throw new IOException("Encrypted file is truncated");
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keySpec, new GCMParameterSpec(TAG_BYTES * 8, iv(prefix, index)));
            cipher.updateAAD(new byte[] { (byte) (last ? 1 : 0) });
            byte[] plain;
            try {
                plain = cipher.doFinal(current, 0, currentLen);
            } catch (GeneralSecurityException e) {
                throw new IOException("Could not decrypt the file: wrong key or damaged data");
            }
            out.write(plain);
            written += plain.length;
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

    private static byte[] iv(byte[] prefix, int index) {
        return ByteBuffer.allocate(12).put(prefix).putInt(index).array();
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
