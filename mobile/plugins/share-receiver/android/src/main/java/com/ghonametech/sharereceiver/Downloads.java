package com.ghonametech.sharereceiver;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Writes a finished download into the phone's public Downloads folder, where
 * the user expects to find it. On Android 10+ that goes through MediaStore
 * (no storage permission needed); older versions write the file directly.
 */
final class Downloads {

    private Downloads() {}

    /** Where a download is being written, and how to point at it afterwards. */
    static class Target {
        Uri uri;
        /** Set only on the pre-Android-10 path. */
        File file;
        String name;
        String mimeType;
        String displayPath;
    }

    static Target create(Context context, String name) throws Exception {
        Target target = new Target();
        target.name = name;
        target.mimeType = mimeType(name);
        target.displayPath = "Download/" + name;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, target.mimeType);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            // Hidden from other apps until the download finishes.
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            ContentResolver resolver = context.getContentResolver();
            target.uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (target.uri == null) {
                throw new Exception("could not create the file in Downloads");
            }
            return target;
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new Exception("no Downloads folder");
        }
        target.file = unique(dir, name);
        target.displayPath = "Download/" + target.file.getName();
        return target;
    }

    static OutputStream open(Context context, Target target) throws Exception {
        if (target.file != null) {
            return new FileOutputStream(target.file);
        }
        OutputStream out = context.getContentResolver().openOutputStream(target.uri);
        if (out == null) {
            throw new Exception("could not write to Downloads");
        }
        return out;
    }

    /** Makes the finished file visible to other apps. */
    static void publish(Context context, Target target) {
        if (target.file != null) {
            target.uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", target.file);
            return;
        }
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        context.getContentResolver().update(target.uri, values, null, null);
    }

    /** Removes a partial file after a failed download. */
    static void discard(Context context, Target target) {
        try {
            if (target.file != null) {
                target.file.delete();
            } else if (target.uri != null) {
                context.getContentResolver().delete(target.uri, null, null);
            }
        } catch (Exception ignored) {
            // Nothing to clean up.
        }
    }

    /** "report.pdf", "report (2).pdf", … so an existing file is never replaced. */
    private static File unique(File dir, String name) {
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        File candidate = new File(dir, name);
        for (int n = 2; candidate.exists(); n++) {
            candidate = new File(dir, stem + " (" + n + ")" + ext);
        }
        return candidate;
    }

    private static String mimeType(String name) {
        int dot = name.lastIndexOf('.');
        String extension = dot > 0 ? name.substring(dot + 1).toLowerCase() : "";
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return type != null ? type : "application/octet-stream";
    }
}
