package com.ghonametech.sharereceiver;

import android.content.Context;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hands content shared into the app to the web app, and uploads shared files
 * (encrypted with a key the web app generates, or as-is) to the storage URL
 * the sync server issued. The web app only ever sees ids, names and sizes;
 * the bytes stay in native code, like the desktop app's main process.
 *
 * Events: "share" ({kind: "text", text} | {kind: "file", requestId, name,
 * sizeBytes}) and "progress" ({id, done, total}).
 */
@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {

    // Shares can arrive before the bridge (and this plugin) exists on a cold
    // start, so they are queued statically and drained by takePending().
    private static final List<JSObject> pending = new ArrayList<>();
    private static final Map<String, File> files = new ConcurrentHashMap<>();
    private static ShareReceiverPlugin instance;
    private static boolean listening;

    private final ExecutorService uploads = Executors.newSingleThreadExecutor();

    static File sharesDir(Context context) {
        return new File(context.getCacheDir(), "shares");
    }

    static synchronized void enqueueText(String text) {
        JSObject item = new JSObject();
        item.put("kind", "text");
        item.put("text", text);
        deliver(item);
    }

    static synchronized void enqueueFile(String requestId, String name, long size, File file) {
        files.put(requestId, file);
        JSObject item = new JSObject();
        item.put("kind", "file");
        item.put("requestId", requestId);
        item.put("name", name);
        item.put("sizeBytes", size);
        deliver(item);
    }

    private static void deliver(JSObject item) {
        if (instance != null && listening) {
            instance.notifyListeners("share", item);
        } else {
            pending.add(item);
        }
    }

    @Override
    public void load() {
        synchronized (ShareReceiverPlugin.class) {
            instance = this;
            listening = false;
        }
        cleanUpOrphans();
    }

    /** Returns shares received before the web app was listening; later ones arrive as events. */
    @PluginMethod
    public void takePending(PluginCall call) {
        JSArray items = new JSArray();
        synchronized (ShareReceiverPlugin.class) {
            for (JSObject item : pending) {
                items.put(item);
            }
            pending.clear();
            listening = true;
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    /** PUTs a shared file to a presigned URL, encrypting it when a base64 key is given. */
    @PluginMethod
    public void upload(PluginCall call) {
        String requestId = call.getString("requestId");
        String uploadUrl = call.getString("uploadUrl");
        String key = call.getString("key");
        File file = requestId == null ? null : files.get(requestId);
        if (file == null || uploadUrl == null) {
            call.reject("Unknown file");
            return;
        }
        uploads.execute(() -> {
            try {
                put(requestId, file, uploadUrl, key == null ? null : Base64.decode(key, Base64.DEFAULT));
                forgetFile(requestId);
                call.resolve();
            } catch (Exception e) {
                call.reject("Upload failed: " + e.getMessage());
            }
        });
    }

    /** Drops a shared file the web app will not upload. */
    @PluginMethod
    public void forget(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId != null) {
            forgetFile(requestId);
        }
        call.resolve();
    }

    private void put(String requestId, File file, String uploadUrl, byte[] key) throws Exception {
        long plainBytes = file.length();
        long bodyBytes = key != null ? Csf1.encryptedSize(plainBytes) : plainBytes;
        HttpURLConnection connection = (HttpURLConnection) new URL(uploadUrl).openConnection();
        try {
            connection.setRequestMethod("PUT");
            connection.setDoOutput(true);
            // Storage needs the exact length up front: no chunked encoding.
            connection.setFixedLengthStreamingMode(bodyBytes);
            connection.setConnectTimeout(30_000);
            connection.setReadTimeout(120_000);
            final long[] lastReport = { 0 };
            Csf1.Progress progress = (written) -> {
                long now = System.currentTimeMillis();
                if (now - lastReport[0] > 250 || written == bodyBytes) {
                    lastReport[0] = now;
                    JSObject event = new JSObject();
                    event.put("id", requestId);
                    event.put("done", written);
                    event.put("total", bodyBytes);
                    notifyListeners("progress", event);
                }
            };
            try (InputStream in = new FileInputStream(file); OutputStream out = new BufferedOutputStream(connection.getOutputStream(), 64 * 1024)) {
                if (key != null) {
                    Csf1.encrypt(in, out, key, progress);
                } else {
                    byte[] buffer = new byte[64 * 1024];
                    long written = 0;
                    int read;
                    while ((read = in.read(buffer)) > 0) {
                        out.write(buffer, 0, read);
                        written += read;
                        progress.onBytes(written);
                    }
                }
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new Exception("status " + status);
            }
        } finally {
            connection.disconnect();
        }
    }

    private static void forgetFile(String requestId) {
        File file = files.remove(requestId);
        if (file != null) {
            File dir = file.getParentFile();
            file.delete();
            if (dir != null) {
                dir.delete();
            }
        }
    }

    /** Removes copies left behind by shares a previous run never finished. */
    private void cleanUpOrphans() {
        File[] dirs = sharesDir(getContext()).listFiles();
        if (dirs == null) {
            return;
        }
        for (File dir : dirs) {
            if (files.containsKey(dir.getName())) {
                continue;
            }
            File[] children = dir.listFiles();
            if (children != null) {
                for (File child : children) {
                    child.delete();
                }
            }
            dir.delete();
        }
    }
}
