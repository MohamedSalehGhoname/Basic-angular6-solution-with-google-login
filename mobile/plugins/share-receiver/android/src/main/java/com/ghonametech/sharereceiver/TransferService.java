package com.ghonametech.sharereceiver;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * Keeps uploads and downloads running while the app is in the background or
 * the screen is off. Android only lets a process keep working like that as a
 * foreground service with a visible notification, which doubles as the
 * transfer's progress bar. A partial wake lock keeps the CPU awake for the
 * decrypting and writing between network reads.
 *
 * The transfers themselves run on the plugin's own threads; this service is
 * what stops the system from killing them.
 */
public class TransferService extends Service {

    private static final String CHANNEL = "transfers";
    private static final int NOTIFICATION_ID = 4711;
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_DONE = "done";
    static final String EXTRA_TOTAL = "total";

    private static final String SAVED_CHANNEL = "saved";
    private static int active;
    private static int savedId = 5000;
    private PowerManager.WakeLock wakeLock;

    /** Called when a transfer starts; safe to call for several at once. */
    static synchronized void begin(Context context, String title) {
        active += 1;
        update(context, title, 0, 0);
    }

    static void update(Context context, String title, long done, long total) {
        Intent intent = new Intent(context, TransferService.class)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_DONE, done)
            .putExtra(EXTRA_TOTAL, total);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    /** Called when a transfer ends; the service stops once none are left. */
    static synchronized void end(Context context) {
        active = Math.max(0, active - 1);
        if (active == 0) {
            context.stopService(new Intent(context, TransferService.class));
        }
    }

    /** Tells the user where a finished download went; tapping opens it. */
    static void notifySaved(Context context, Downloads.Target target) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(SAVED_CHANNEL) == null) {
            manager.createNotificationChannel(
                new NotificationChannel(SAVED_CHANNEL, "Downloads", NotificationManager.IMPORTANCE_DEFAULT)
            );
        }
        Intent view = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(target.uri, target.mimeType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(
            context,
            savedId,
            view,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        manager.notify(
            savedId++,
            new NotificationCompat.Builder(context, SAVED_CHANNEL)
                .setContentTitle(target.name)
                .setContentText("Saved to " + target.displayPath)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setAutoCancel(true)
                .setContentIntent(tap)
                .build()
        );
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent == null ? null : intent.getStringExtra(EXTRA_TITLE);
        long done = intent == null ? 0 : intent.getLongExtra(EXTRA_DONE, 0);
        long total = intent == null ? 0 : intent.getLongExtra(EXTRA_TOTAL, 0);
        startInForeground(title == null ? "Transferring…" : title, done, total);
        acquireWakeLock();
        return START_NOT_STICKY;
    }

    private void startInForeground(String title, long done, long total) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "File transfers", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = open == null
            ? null
            : PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle(title)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(tap);
        if (total > 0) {
            builder.setProgress(100, (int) Math.min(100, done * 100 / total), false);
        } else {
            builder.setProgress(0, 0, true);
        }
        Notification notification = builder.build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        PowerManager power = getSystemService(PowerManager.class);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clipsync:transfer");
        // Released in onDestroy; the timeout is a backstop against a leak.
        wakeLock.acquire(60 * 60 * 1000L);
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
