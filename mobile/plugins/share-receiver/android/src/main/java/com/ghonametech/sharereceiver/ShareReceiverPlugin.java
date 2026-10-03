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
    private final ExecutorService fetches = Executors.newFixedThreadPool(2);

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
        String title = "Sending " + file.getName();
        TransferService.begin(getContext(), title);
        uploads.execute(() -> {
            try {
                put(requestId, file, uploadUrl, key == null ? null : Base64.decode(key, Base64.DEFAULT));
                forgetFile(requestId);
                call.resolve();
            } catch (Exception e) {
                call.reject("Upload failed: " + e.getMessage());
            } finally {
                TransferService.end(getContext());
            }
        });
    }

    /**
     * Downloads a file straight from storage, decrypts it when a base64 key
     * is given, and writes it into the app's cache. Runs on a background
     * thread inside a foreground service, so it keeps going when the app is
     * in the background or the screen is off.
     */
    @PluginMethod
    public void download(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        String name = call.getString("name");
        String key = call.getString("key");
        if (id == null || url == null || name == null) {
            call.reject("Missing download details", "invalid");
            return;
        }
        String safeName = ShareReceiverActivity.safeName(name);
        String title = "Downloading " + safeName;
        TransferService.begin(getContext(), title);
        fetches.execute(() -> {
            Downloads.Target target = null;
            try {
                target = Downloads.create(getContext(), safeName);
                fetch(id, url, target, key == null ? null : Base64.decode(key, Base64.DEFAULT), title);
                Downloads.publish(getContext(), target);
                TransferService.notifySaved(getContext(), target);
                JSObject result = new JSObject();
                result.put("uri", target.uri.toString());
                result.put("path", target.displayPath);
                call.resolve(result);
            } catch (Exception e) {
                if (target != null) {
                    Downloads.discard(getContext(), target);
                }
                call.reject("Download failed: " + e.getMessage(), "failed");
            } finally {
                TransferService.end(getContext());
            }
        });
    }

    private void fetch(String id, String url, Downloads.Target target, byte[] key, String title) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setConnectTimeout(30_000);
            connection.setReadTimeout(120_000);
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new Exception("status " + status);
            }
            long total = connection.getContentLengthLong();
            final long[] lastReport = { 0 };
            Csf1.Progress progress = (written) -> {
                long now = System.currentTimeMillis();
                if (now - lastReport[0] > 400) {
                    lastReport[0] = now;
                    JSObject event = new JSObject();
                    event.put("id", id);
                    event.put("done", written);
                    event.put("total", total > 0 ? total : written);
                    notifyListeners("progress", event);
                    TransferService.update(getContext(), title, written, total);
                }
            };
            try (
                InputStream in = connection.getInputStream();
                OutputStream out = new BufferedOutputStream(Downloads.open(getContext(), target), 64 * 1024)
            ) {
                if (key != null) {
                    // Progress here counts plaintext bytes; close enough for a bar.
                    Csf1.decrypt(in, out, key, progress);
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
            JSObject done = new JSObject();
            done.put("id", id);
            done.put("done", total > 0 ? total : 1);
            done.put("total", total > 0 ? total : 1);
            notifyListeners("progress", done);
        } finally {
            connection.disconnect();
        }
    }

    /** Asks for the notification permission that shows transfer progress (Android 13+). */
    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            String permission = android.Manifest.permission.POST_NOTIFICATIONS;
            if (getContext().checkSelfPermission(permission) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                getActivity().requestPermissions(new String[] { permission }, 9911);
            }
        }
        call.resolve();
    }

    /** Opens a saved download in whichever app handles that kind of file. */
    @PluginMethod
    public void openDownload(PluginCall call) {
        String uri = call.getString("uri");
        String name = call.getString("name", "");
        if (uri == null) {
            call.reject("Missing file", "invalid");
            return;
        }
        android.content.Intent view = new android.content.Intent(android.content.Intent.ACTION_VIEW)
            .setDataAndType(android.net.Uri.parse(uri), Downloads.mimeType(name))
            .addFlags(
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_ACTIVITY_NEW_TASK
            );
        try {
            getContext().startActivity(view);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app can open this file", "no_app");
        }
    }

    /** Android 9 and older need permission to write into Downloads. */
    @PluginMethod
    public void requestStorage(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT <= 28) {
            String permission = android.Manifest.permission.WRITE_EXTERNAL_STORAGE;
            if (getContext().checkSelfPermission(permission) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                getActivity().requestPermissions(new String[] { permission }, 9912);
            }
        }
        call.resolve();
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

    private static void deleteTree(File root) {
        File[] children = root.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteTree(child);
            }
        }
        root.delete();
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
        deleteTree(new File(getContext().getCacheDir(), "downloads"));
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
