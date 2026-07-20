package app.flextext.audio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps a recording alive when the app is not in the foreground.
 *
 * WHY THIS EXISTS — two problems, one fix:
 *  1. Cheap OEM ROMs (Oppo / Vivo / Huawei / Xiaomi and friends) aggressively kill background
 *     processes to save battery. Without a foreground service a recording is simply truncated the
 *     moment the screen locks or the user switches away — silently, and in the field, irreversibly.
 *  2. Android 14 (API 34) REQUIRES a declared foregroundServiceType to hold the microphone while
 *     backgrounded, and Google Play requires the matching permission be declared and justified.
 *
 * The service does NOT record. AudioRecord stays in FlextextAudioPlugin; this only holds the
 * process up and carries the microphone FGS type, so the plugin stays a dumb capture pipe.
 *
 * The notification text is passed in from the web layer so it follows the app's language —
 * native code has no access to the JS i18n table.
 */
public class RecordingService extends Service {

    private static final String CHANNEL_ID = "flextext_recording";
    private static final int NOTIFICATION_ID = 4711;
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";

    static void start(Context ctx, String title, String text) {
        Intent i = new Intent(ctx, RecordingService.class);
        i.putExtra(EXTRA_TITLE, title);
        i.putExtra(EXTRA_TEXT, text);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    static void stop(Context ctx) {
        try { ctx.stopService(new Intent(ctx, RecordingService.class)); } catch (Throwable ignored) { }
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        if (title == null || title.isEmpty()) title = "Recording";
        if (text == null || text.isEmpty()) text = "Flextext is recording audio.";

        createChannel();
        Notification n = buildNotification(title, text);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Throwable t) {
            // Never let a notification problem take the recording down — the capture itself is
            // already running in the plugin. Worst case we lose background protection.
            stopSelf();
            return START_NOT_STICKY;
        }
        // Do not restart on its own if the OS kills us: a resurrected service with no live
        // AudioRecord would show a misleading "recording" notification.
        return START_NOT_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Recording", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shown while a recording is in progress.");
        ch.setShowBadge(false);
        ch.setSound(null, null);          // a recording notification must never make noise
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }

    @SuppressWarnings("deprecation")
    private Notification buildNotification(String title, String text) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        b.setContentTitle(title)
         .setContentText(text)
         .setSmallIcon(android.R.drawable.ic_btn_speak_now)   // framework mic icon: no app resource needed
         .setOngoing(true)
         .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT >= 21) b.setVisibility(Notification.VISIBILITY_PUBLIC);
        return b.build();
    }

    @Override
    public void onDestroy() {
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Throwable ignored) { }
        super.onDestroy();
    }
}
