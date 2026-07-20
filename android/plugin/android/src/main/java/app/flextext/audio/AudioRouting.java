package app.flextext.audio;

import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.os.Build;

import com.getcapacitor.JSObject;

/**
 * WHICH MICROPHONE the capture actually came from — reporting first, steering second.
 *
 * <p>WHY THIS EXISTS. The plugin already proves what FORMAT a device can capture, but it said
 * nothing about the SOURCE. Those are independent: a Bluetooth headset routes input through SCO at
 * 8/16 kHz, heavily processed, and Android will happily hand those samples to an AudioRecord
 * configured for 24-bit/48 kHz. The file is then a genuine 24-bit/48 kHz WAV containing narrowband
 * compressed audio. Nothing in it is false and all of it is misleading — upsampling adds no
 * information. That is precisely the fabricated-provenance failure the honesty contract exists to
 * prevent, arriving through a door the contract did not cover.
 *
 * <p>HOW LIKELY IS IT, HONESTLY. Lower than the framing above suggests, and worth stating plainly
 * rather than overselling the fix: SCO input normally requires an app to call
 * {@code startBluetoothSco()}, which this plugin never does. So on stock Android the built-in mic
 * is the expected route. But OEM behaviour varies across exactly the cheap phones this project
 * targets, and newer Android can route BLE headsets. The point of this class is therefore to make
 * the route an OBSERVED FACT rather than an assumption. Steering is the secondary safeguard.
 *
 * <p>EASY TO REVERT — this was added ahead of any real APK users, deliberately:
 * <ul>
 *   <li>Flip {@link #ENABLED} to {@code false}: every method becomes a no-op and the plugin behaves
 *       exactly as it did before. No rebuild of anything else is required.</li>
 *   <li>Or delete this file and the three blocks in FlextextAudioPlugin.java marked
 *       {@code // --- AudioRouting ---}.</li>
 *   <li>Or {@code git revert} the single commit that introduced it.</li>
 * </ul>
 *
 * <p>CONTRACT: this class only ADDS fields to what {@code start()} already returns, so
 * {@code CONTRACT_VERSION} stays at 1 and an engine that has never heard of routing keeps working
 * unchanged. Do not repurpose an existing field here — that would require a contract bump and would
 * couple the APK to an engine release.
 */
final class AudioRouting {

    /** Master switch. Set false to disable routing entirely (see class docs). */
    static final boolean ENABLED = true;

    private AudioRouting() {}

    // Rank inputs by how defensible a recording from them is. Higher is better.
    private static final int RANK_WIRELESS = 0;   // compressed + processed: never a master
    private static final int RANK_UNKNOWN  = 1;
    private static final int RANK_BUILTIN  = 2;
    private static final int RANK_WIRED    = 3;
    private static final int RANK_USB      = 4;   // what real fieldwork uses

    private static int rankOf(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_USB_DEVICE:
            case AudioDeviceInfo.TYPE_USB_ACCESSORY:
            case AudioDeviceInfo.TYPE_USB_HEADSET:      // API 26 constant; inlined, safe on API 24
                return RANK_USB;
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                return RANK_WIRED;
            case AudioDeviceInfo.TYPE_BUILTIN_MIC:
                return RANK_BUILTIN;
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:      // API 31 constant; inlined, safe on API 24
                return RANK_WIRELESS;
            default:
                return RANK_UNKNOWN;
        }
    }

    /** True for routes that cannot carry archive-quality audio at any configured bit depth. */
    static boolean isWireless(int type) {
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_BLE_HEADSET;
    }

    static String typeName(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_MIC:    return "builtin_mic";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:  return "wired_headset";
            case AudioDeviceInfo.TYPE_USB_DEVICE:     return "usb_device";
            case AudioDeviceInfo.TYPE_USB_ACCESSORY:  return "usb_accessory";
            case AudioDeviceInfo.TYPE_USB_HEADSET:    return "usb_headset";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:  return "bluetooth_sco";
            case AudioDeviceInfo.TYPE_BLE_HEADSET:    return "ble_headset";
            case AudioDeviceInfo.TYPE_TELEPHONY:      return "telephony";
            default:                                  return "type_" + type;
        }
    }

    /**
     * Ask the framework for the best-ranked input before capture starts.
     *
     * <p>This is a PREFERENCE, not a guarantee — the platform may route elsewhere, which is exactly
     * why {@link #describeRouted} reports what actually happened instead of echoing this choice
     * back. Entirely best-effort: any failure leaves the default routing untouched, because a
     * recording that happens on the wrong mic still beats a recording that does not happen.
     */
    static void preferBestInput(AudioManager am, AudioRecord recorder) {
        if (!ENABLED || am == null || recorder == null) return;
        try {
            AudioDeviceInfo[] devices = am.getDevices(AudioManager.GET_DEVICES_INPUTS);
            if (devices == null || devices.length == 0) return;
            AudioDeviceInfo best = null;
            int bestRank = -1;
            for (AudioDeviceInfo d : devices) {
                int r = rankOf(d.getType());
                if (r > bestRank) { bestRank = r; best = d; }
            }
            // Only intervene to AVOID a wireless route. If the best available input is itself
            // wireless it is the only mic there is, and overriding would just break the recording.
            if (best != null && bestRank > RANK_WIRELESS) recorder.setPreferredDevice(best);
        } catch (Throwable ignored) {
            // Routing is an improvement, never a precondition.
        }
    }

    /**
     * Report the device the capture is ACTUALLY running on, after startRecording().
     *
     * <p>Must be called after {@code startRecording()}: before that the route is not yet resolved
     * and {@code getRoutedDevice()} returns null. Fields are additive (see class docs).
     */
    static void describeRouted(AudioRecord recorder, JSObject ret) {
        if (!ENABLED || recorder == null || ret == null) return;
        try {
            // getRoutedDevice() is API 24 and minSdk is 24, so it is always present — but a null
            // return is normal on some OEM builds, and is reported as "unknown" rather than guessed.
            AudioDeviceInfo d = recorder.getRoutedDevice();
            if (d == null) {
                ret.put("routedDevice", null);
                ret.put("routedType", "unknown");
                ret.put("routedWireless", false);   // unknown is not evidence of a bad route
                ret.put("routedArchival", true);
                ret.put("routedNote", "Android did not report which microphone was used.");
                return;
            }
            int type = d.getType();
            boolean wireless = isWireless(type);
            CharSequence name = null;
            try { name = d.getProductName(); } catch (Throwable ignored) { /* optional */ }
            ret.put("routedDevice", name == null ? null : name.toString());
            ret.put("routedType", typeName(type));
            ret.put("routedWireless", wireless);
            ret.put("routedArchival", !wireless);
            ret.put("routedNote", wireless
                ? "Recorded through a wireless (Bluetooth) microphone. That link compresses and "
                  + "processes the audio before this app receives it, so this recording is not "
                  + "archive quality no matter which bit depth was selected."
                : null);
        } catch (Throwable ignored) {
            // Never let reporting break a capture that is already running.
        }
    }
}
