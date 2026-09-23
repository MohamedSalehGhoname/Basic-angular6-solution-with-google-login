package com.ghonametech.sharereceiver;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.UUID;

/**
 * The "Clipboard Sync" entry in Android's share sheet. Takes the shared text
 * or files, copies files into the app's cache (content:// grants do not
 * outlive this activity), queues them for the web app through
 * {@link ShareReceiverPlugin}, then brings the app to the front.
 */
public class ShareReceiverActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            receive(getIntent());
        } catch (Exception ignored) {
            // Nothing usable was shared.
        }
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            startActivity(launch);
        }
        finish();
    }

    private void receive(Intent intent) throws Exception {
        if (intent == null) {
            return;
        }
        ArrayList<Uri> streams = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri stream = streamExtra(intent);
            if (stream != null) {
                streams.add(stream);
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> many = streamsExtra(intent);
            if (many != null) {
                streams.addAll(many);
            }
        } else {
            return;
        }

        if (streams.isEmpty()) {
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text != null && text.toString().trim().length() > 0) {
                ShareReceiverPlugin.enqueueText(text.toString());
            }
            return;
        }
        for (Uri uri : streams) {
            copyToCache(uri);
        }
    }

    private void copyToCache(Uri uri) throws Exception {
        String requestId = UUID.randomUUID().toString();
        String name = safeName(displayName(uri));
        File dir = new File(ShareReceiverPlugin.sharesDir(this), requestId);
        if (!dir.mkdirs()) {
            return;
        }
        File target = new File(dir, name);
        ContentResolver resolver = getContentResolver();
        long size = 0;
        try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(target)) {
            if (in == null) {
                return;
            }
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
                size += read;
            }
        }
        ShareReceiverPlugin.enqueueFile(requestId, name, size, target);
    }

    private String displayName(Uri uri) {
        if ("content".equals(uri.getScheme())) {
            try (Cursor cursor = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    String name = cursor.getString(0);
                    if (name != null) {
                        return name;
                    }
                }
            } catch (Exception ignored) {
                // Fall back to the path.
            }
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "file";
    }

    /** Strips path separators and control characters; shared with the plugin. */
    static String safeName(String name) {
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        return cleaned.isEmpty() ? "file" : cleaned;
    }

    @SuppressWarnings("deprecation")
    private static Uri streamExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    @SuppressWarnings("deprecation")
    private static ArrayList<Uri> streamsExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) {
            return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }
}
