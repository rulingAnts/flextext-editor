package app.flextext.audio;

import android.Manifest;
import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.AutomaticGainControl;
import android.media.audiofx.NoiseSuppressor;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Unprocessed, true-bit-depth microphone capture for the Flextext suite.
 *
 * WHY THIS EXISTS (two independent reasons, both archival):
 *  1. The Chromium WebView forces an AGC-or-clip dilemma that IASA TC-03 / FADGI forbid on a
 *     preservation master. AudioRecord with MediaRecorder.AudioSource.UNPROCESSED does not.
 *  2. The Web Audio API is 32-bit-float end-to-end BY SPECIFICATION, so a web app can never
 *     capture at a chosen integer bit depth — it can only capture float and reduce afterwards.
 *     AudioRecord can request a real 16/24/32-bit integer capture straight off the ADC.
 *
 * HONESTY CONTRACT — the whole point of this plugin. The rule is NOT "never substitute"; it is
 * "never substitute SILENTLY":
 *  - capabilities() probes what THIS device can actually open, by really constructing an
 *    AudioRecord for each combination. It never reports a format it hasn't proven. It also
 *    returns recommended{} — the best archival capture this particular device can manage.
 *  - start() falls back to the CLOSEST format the device genuinely supports (preferring not to
 *    lose information: e.g. 24-bit unavailable -> 32-bit float before 16-bit), and returns
 *    requested{}, the actual encoding/rate, substituted=true and a human-readable
 *    substitutionReason so the UI can warn the researcher plainly. It only rejects when the
 *    device can capture nothing at all.
 *  - stop() repeats all of that on the finished file, so the provenance record states what was
 *    really written — never a fabricated "24-bit" that would poison an archive's chain.
 *  - unprocessedSupported() is reported separately: if the device lacks a genuine unprocessed
 *    path we fall back to VOICE_RECOGNITION and say so, rather than claiming a clean master.
 *
 * DELIBERATELY DUMB: this class applies no gain, no resampling, no bit-depth conversion, and no
 * DSP of any kind. It opens the mic, writes exactly the bytes the ADC produced into a WAV
 * container, and reports peak levels for the meter. Everything mutable — encoding to FLAC,
 * format menus, upload, consent, UI — stays in the web engine so it keeps auto-updating.
 */
@CapacitorPlugin(
    name = "FlextextAudio",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class FlextextAudioPlugin extends Plugin {

    // Encoding ids shared with the web engine. Explicit about int-vs-float: "pcm32" and
    // "float32" are both 32 bits wide but are NOT the same thing to an archive.
    private static final String ENC_PCM16 = "pcm16";
    private static final String ENC_PCM24 = "pcm24";
    private static final String ENC_PCM32 = "pcm32";
    private static final String ENC_FLOAT32 = "float32";
    private static final String[] ALL_ENCODINGS = { ENC_PCM16, ENC_PCM24, ENC_PCM32, ENC_FLOAT32 };
    private static final int[] PROBE_RATES = { 8000, 16000, 22050, 32000, 44100, 48000, 96000 };

    private static final int WAV_FMT_PCM = 1;   // integer PCM
    private static final int WAV_FMT_FLOAT = 3; // IEEE float

    /**
     * JS<->native contract version. The web adapter checks this and degrades LOUDLY on mismatch.
     * BUMP IT whenever a method is added/removed or a returned field changes meaning — the web
     * engine auto-updates (service worker / OTA) while the APK does NOT, so a silently-changed
     * contract would break installed apps in the field with no obvious cause.
     */
    private static final int CONTRACT_VERSION = 1;

    /** Captures live in filesDir (NOT cacheDir): the OS may purge cacheDir under storage pressure,
     *  and these users routinely run storage at 100% — a not-yet-absorbed recording would vanish. */
    private static final String CAPTURE_DIR = "flextext-captures";

    private AudioRecord recorder;
    private volatile boolean recording = false;
    private Thread worker;
    private RandomAccessFile out;
    private File outFile;
    private long dataBytes = 0;

    private String activeEncoding = ENC_PCM16;
    private int activeRate = 48000;
    private int activeChannels = 1;
    private String activeSource = "UNPROCESSED";
    // What the caller ASKED for vs what the device could actually do — carried into stop() so the
    // saved file's provenance record states the substitution, not just the final format.
    private String activeRequestedEncoding = ENC_PCM16;
    private int activeRequestedRate = 48000;
    private boolean activeSubstituted = false;
    private String activeSubReason = null;
    // The OS pre-processing effects attached to OUR capture session. We hold them so we can
    // report their real state and keep them disabled for the life of the recording.
    private AcousticEchoCanceler aec;
    private NoiseSuppressor ns;
    private AutomaticGainControl agc;
    private JSObject effectsReport = new JSObject();

    /* ---------------- capability probing ---------------- */

    private Integer androidEncoding(String enc) {
        switch (enc) {
            case ENC_PCM16:
                return AudioFormat.ENCODING_PCM_16BIT;
            case ENC_FLOAT32:
                return AudioFormat.ENCODING_PCM_FLOAT;                       // API 23+
            case ENC_PCM24:
                return Build.VERSION.SDK_INT >= 31 ? AudioFormat.ENCODING_PCM_24BIT_PACKED : null;
            case ENC_PCM32:
                return Build.VERSION.SDK_INT >= 31 ? AudioFormat.ENCODING_PCM_32BIT : null;
            default:
                return null;
        }
    }

    private static int bytesPerSample(String enc) {
        switch (enc) {
            case ENC_PCM24: return 3;
            case ENC_PCM32: case ENC_FLOAT32: return 4;
            default: return 2;
        }
    }

    private static int bitsOf(String enc) { return bytesPerSample(enc) * 8; }
    private static boolean isFloat(String enc) { return ENC_FLOAT32.equals(enc); }

    /**
     * Does this device genuinely support an unprocessed capture path? Android exposes this as an
     * explicit property; when it is false we must NOT claim an unprocessed master, even though
     * AudioRecord will still accept the UNPROCESSED constant (it silently degrades).
     */
    private boolean unprocessedSupported() {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            return "true".equals(am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED));
        } catch (Throwable t) {
            return false;
        }
    }

    /** UNPROCESSED where the device really supports it; else the least-processed fallback. */
    private int audioSource() {
        return unprocessedSupported()
            ? MediaRecorder.AudioSource.UNPROCESSED
            : MediaRecorder.AudioSource.VOICE_RECOGNITION; // no AGC/NS by convention, but not guaranteed raw
    }

    private String audioSourceName() {
        return unprocessedSupported() ? "UNPROCESSED" : "VOICE_RECOGNITION";
    }

    private static int channelMask(int channels) {
        return channels == 2 ? AudioFormat.CHANNEL_IN_STEREO : AudioFormat.CHANNEL_IN_MONO;
    }

    /** Really opens an AudioRecord — the only trustworthy test of "can this device capture this". */
    private boolean canCapture(String enc, int rate, int channels) {
        Integer aEnc = androidEncoding(enc);
        if (aEnc == null) return false;
        int mask = channelMask(channels);
        int min;
        try {
            min = AudioRecord.getMinBufferSize(rate, mask, aEnc);
        } catch (Throwable t) {
            return false;
        }
        if (min <= 0) return false; // ERROR / ERROR_BAD_VALUE → unsupported combination
        AudioRecord probe = null;
        try {
            probe = new AudioRecord(audioSource(), rate, mask, aEnc, min);
            return probe.getState() == AudioRecord.STATE_INITIALIZED;
        } catch (Throwable t) {
            return false;
        } finally {
            if (probe != null) {
                try { probe.release(); } catch (Throwable ignored) { }
            }
        }
    }

    /** Where captures are written. We own this directory and are responsible for cleaning it. */
    private File captureDir() {
        File d = new File(getContext().getFilesDir(), CAPTURE_DIR);
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /* ---------------- OS pre-processing effects ----------------
     * "unprocessed = false" is far too vague to put in front of an archivist. Even when the
     * device has no UNPROCESSED source, we can attach to OUR OWN capture session and explicitly
     * turn off acoustic echo cancellation, noise suppression and automatic gain control — then
     * report, per effect, whether it exists, whether it was on, and whether we actually got it
     * off. That is the specific, auditable answer: not "processed/unprocessed" but exactly which
     * processors were present and what state they ended in. (The WebView gives no such control.) */

    private static boolean effectAvailable(String kind) {
        try {
            switch (kind) {
                case "aec": return AcousticEchoCanceler.isAvailable();
                case "ns":  return NoiseSuppressor.isAvailable();
                default:    return AutomaticGainControl.isAvailable();
            }
        } catch (Throwable t) { return false; }
    }

    /** Attach to our session, record the as-found state, force it off, record the result. */
    private JSObject disableEffect(String kind, int sessionId) {
        JSObject o = new JSObject();
        boolean avail = effectAvailable(kind);
        o.put("available", avail);
        if (!avail) {
            o.put("stillActive", false);
            o.put("note", "not implemented on this device");
            return o;
        }
        try {
            Boolean was = null, now = null;
            switch (kind) {
                case "aec":
                    aec = AcousticEchoCanceler.create(sessionId);
                    if (aec != null) { was = aec.getEnabled(); aec.setEnabled(false); now = aec.getEnabled(); }
                    break;
                case "ns":
                    ns = NoiseSuppressor.create(sessionId);
                    if (ns != null) { was = ns.getEnabled(); ns.setEnabled(false); now = ns.getEnabled(); }
                    break;
                default:
                    agc = AutomaticGainControl.create(sessionId);
                    if (agc != null) { was = agc.getEnabled(); agc.setEnabled(false); now = agc.getEnabled(); }
                    break;
            }
            if (was == null) {
                o.put("note", "available but could not attach to this capture session");
                o.put("stillActive", true);   // cannot prove it is off → assume the worst, honestly
            } else {
                o.put("wasEnabled", was.booleanValue());
                o.put("stillActive", now != null && now.booleanValue());
                o.put("disabledByUs", was.booleanValue() && (now != null && !now.booleanValue()));
            }
        } catch (Throwable t) {
            o.put("note", "error: " + t.getMessage());
            o.put("stillActive", true);
        }
        return o;
    }

    private JSObject configureEffects(int sessionId) {
        JSObject r = new JSObject();
        r.put("agc", disableEffect("agc", sessionId));
        r.put("ns", disableEffect("ns", sessionId));
        r.put("aec", disableEffect("aec", sessionId));
        boolean clean = !r.getJSObject("agc").getBoolean("stillActive", true)
                     && !r.getJSObject("ns").getBoolean("stillActive", true)
                     && !r.getJSObject("aec").getBoolean("stillActive", true);
        r.put("allDisabled", clean);
        return r;
    }

    private void releaseEffects() {
        try { if (aec != null) aec.release(); } catch (Throwable ignored) { }
        try { if (ns != null) ns.release(); } catch (Throwable ignored) { }
        try { if (agc != null) agc.release(); } catch (Throwable ignored) { }
        aec = null; ns = null; agc = null;
    }

    /* ---------------- format negotiation (fallback WITH disclosure) ----------------
     * The rule is not "never substitute" — it is "never substitute SILENTLY". If the device
     * cannot do what was asked, we capture the closest thing it genuinely can and report
     * exactly what happened, so the researcher (and the provenance record) know the truth. */

    private static class Chosen {
        String encoding; int rate; int channels;
        boolean substituted; String reason;
    }

    /** Alternatives in preference order — favour NOT losing information over matching width. */
    private static String[] substitutionOrder(String req) {
        switch (req) {
            case ENC_PCM24:   return new String[] { ENC_FLOAT32, ENC_PCM32, ENC_PCM16 };
            case ENC_PCM32:   return new String[] { ENC_FLOAT32, ENC_PCM24, ENC_PCM16 };
            case ENC_FLOAT32: return new String[] { ENC_PCM32, ENC_PCM24, ENC_PCM16 };
            default:          return new String[] { ENC_FLOAT32, ENC_PCM24, ENC_PCM16 };
        }
    }

    /** Closest rate this device really supports for an encoding; ties prefer the higher rate. */
    private int closestSupportedRate(String enc, int wanted, int channels) {
        int best = -1, bestDist = Integer.MAX_VALUE;
        for (int r : PROBE_RATES) {
            if (!canCapture(enc, r, channels)) continue;
            int d = Math.abs(r - wanted);
            if (d < bestDist || (d == bestDist && r > best)) { best = r; bestDist = d; }
        }
        return best;
    }

    /** Resolve what this device will ACTUALLY capture for a request. null = nothing works at all. */
    private Chosen chooseFormat(String reqEnc, int reqRate, int reqChannels) {
        Chosen c = new Chosen();
        c.encoding = reqEnc; c.rate = reqRate; c.channels = reqChannels;
        c.substituted = false; c.reason = null;

        if (canCapture(reqEnc, reqRate, reqChannels)) return c;

        // 1) Same encoding, nearest rate the device supports — smallest possible change.
        int altRate = closestSupportedRate(reqEnc, reqRate, reqChannels);
        if (altRate > 0) {
            c.rate = altRate;
            c.substituted = true;
            c.reason = "This device cannot record " + label(reqEnc) + " at " + reqRate
                     + " Hz; captured at " + altRate + " Hz instead.";
            return c;
        }

        // 2) Next-best encoding (prefers no information loss), at the nearest rate it supports.
        for (String enc : substitutionOrder(reqEnc)) {
            int r = canCapture(enc, reqRate, reqChannels) ? reqRate : closestSupportedRate(enc, reqRate, reqChannels);
            if (r > 0) {
                c.encoding = enc; c.rate = r;
                c.substituted = true;
                c.reason = "This device cannot record " + label(reqEnc) + " (Android "
                         + Build.VERSION.SDK_INT + "); captured " + label(enc)
                         + (r == reqRate ? "" : " at " + r + " Hz") + " instead.";
                return c;
            }
        }

        // 3) Stereo was asked for but nothing stereo works — retry mono.
        if (reqChannels == 2) {
            Chosen mono = chooseFormat(reqEnc, reqRate, 1);
            if (mono != null) {
                mono.substituted = true;
                mono.reason = "This device cannot record stereo; captured mono."
                            + (mono.reason == null ? "" : " " + mono.reason);
                return mono;
            }
        }
        return null;
    }

    private static String label(String enc) {
        switch (enc) {
            case ENC_PCM16: return "16-bit WAV";
            case ENC_PCM24: return "24-bit WAV";
            case ENC_PCM32: return "32-bit WAV (integer)";
            case ENC_FLOAT32: return "32-bit float WAV";
            default: return enc;
        }
    }

    /** The best archival capture this device can genuinely manage — what the UI should default to. */
    private JSObject recommended() {
        for (String enc : new String[] { ENC_PCM24, ENC_FLOAT32, ENC_PCM32, ENC_PCM16 }) {
            int r = canCapture(enc, 48000, 1) ? 48000 : closestSupportedRate(enc, 48000, 1);
            if (r > 0) {
                JSObject o = new JSObject();
                o.put("encoding", enc);
                o.put("sampleRate", r);
                o.put("channels", 1);
                o.put("label", label(enc));
                return o;
            }
        }
        return null;
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("platform", "android");
        ret.put("contractVersion", CONTRACT_VERSION);
        ret.put("androidSdk", Build.VERSION.SDK_INT);
        ret.put("device", Build.MANUFACTURER + " " + Build.MODEL);
        ret.put("unprocessedSupported", unprocessedSupported());
        ret.put("source", audioSourceName());
        JSObject fx = new JSObject();
        fx.put("agcImplemented", effectAvailable("agc"));
        fx.put("nsImplemented", effectAvailable("ns"));
        fx.put("aecImplemented", effectAvailable("aec"));
        ret.put("effectsAvailable", fx);

        boolean granted = getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED;
        ret.put("permission", granted ? "granted" : "prompt");
        if (!granted) {
            // Probing requires the mic permission; report honestly rather than guessing.
            ret.put("encodings", new JSArray());
            ret.put("probed", false);
            call.resolve(ret);
            return;
        }

        JSArray encodings = new JSArray();
        for (String enc : ALL_ENCODINGS) {
            JSArray rates = new JSArray();
            for (int rate : PROBE_RATES) {
                if (canCapture(enc, rate, 1)) rates.put(rate);
            }
            if (rates.length() == 0) continue;            // not offered — device cannot truly do it
            JSObject e = new JSObject();
            e.put("id", enc);
            e.put("bits", bitsOf(enc));
            e.put("float", isFloat(enc));
            e.put("rates", rates);
            e.put("stereo", canCapture(enc, 48000, 2) || canCapture(enc, 44100, 2));
            encodings.put(e);
        }
        ret.put("encodings", encodings);
        JSObject rec = recommended();
        if (rec != null) ret.put("recommended", rec);
        ret.put("probed", true);
        call.resolve(ret);
    }

    /* ---------------- permission ---------------- */

    @PluginMethod
    public void requestMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("microphone", call, "micPermCallback");
    }

    @PermissionCallback
    private void micPermCallback(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED);
        call.resolve(r);
    }

    /* ---------------- capture ---------------- */

    @PluginMethod
    public void start(PluginCall call) {
        if (recording) { call.reject("already_recording"); return; }
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("permission_denied"); return;
        }

        String enc = call.getString("encoding", ENC_PCM16);
        int rate = call.getInt("sampleRate", 48000);
        int channels = call.getInt("channels", 1);

        // HONESTY GATE: substituting is allowed, substituting SILENTLY is not. Resolve what this
        // device can genuinely capture, then report requested-vs-actual in the result so the UI can
        // warn the researcher and the provenance record states what was really written.
        final String reqEnc = enc;
        final int reqRate = rate;
        final int reqChannels = channels;
        Chosen chosen = chooseFormat(reqEnc, reqRate, reqChannels);
        if (chosen == null) {
            JSObject data = new JSObject();
            data.put("encoding", reqEnc);
            data.put("sampleRate", reqRate);
            data.put("channels", reqChannels);
            call.reject("no_supported_format", (String) null, null, data);
            return;
        }
        enc = chosen.encoding;
        rate = chosen.rate;
        channels = chosen.channels;

        Integer aEnc = androidEncoding(enc);
        int mask = channelMask(channels);
        int min = AudioRecord.getMinBufferSize(rate, mask, aEnc);
        int bufSize = Math.max(min * 4, min); // a little headroom against dropouts on cheap phones

        try {
            recorder = new AudioRecord(audioSource(), rate, mask, aEnc, bufSize);
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                recorder.release(); recorder = null;
                call.reject("audiorecord_init_failed"); return;
            }
            // Force the OS processors off on OUR session before a single frame is captured.
            effectsReport = configureEffects(recorder.getAudioSessionId());
            // --- AudioRouting --- (remove this line to revert; see AudioRouting.java)
            // Steer away from a wireless route BEFORE capture starts. Best-effort by design.
            AudioRouting.preferBestInput(
                (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE), recorder);
            // --- end AudioRouting ---
            outFile = new File(captureDir(), "flextext-" + System.currentTimeMillis() + ".wav");
            out = new RandomAccessFile(outFile, "rw");
            writeWavHeaderPlaceholder(out, enc, rate, channels);
            dataBytes = 0;
        } catch (Throwable t) {
            cleanup();
            call.reject("start_failed: " + t.getMessage()); return;
        }

        activeEncoding = enc; activeRate = rate; activeChannels = channels;
        activeRequestedEncoding = reqEnc; activeRequestedRate = reqRate;
        activeSubstituted = chosen.substituted; activeSubReason = chosen.reason;
        activeSource = audioSourceName();
        recording = true;
        recorder.startRecording();
        // Hold the process up for the duration. Notification strings come from the web layer so
        // they follow the app's language; native has no access to the JS i18n table.
        try {
            RecordingService.start(getContext(),
                call.getString("notificationTitle", null),
                call.getString("notificationText", null));
        } catch (Throwable ignored) { /* capture is already running; background protection is best-effort */ }

        final int chunk = Math.max(bufSize / 2, 2048);
        worker = new Thread(() -> pump(chunk), "flextext-audio-capture");
        worker.start();

        // Full transparency: what was asked for, what is actually being written, and why they differ.
        JSObject requested = new JSObject();
        requested.put("encoding", reqEnc);
        requested.put("sampleRate", reqRate);
        requested.put("channels", reqChannels);
        requested.put("label", label(reqEnc));

        JSObject ret = new JSObject();
        ret.put("encoding", enc);
        ret.put("sampleRate", rate);
        ret.put("channels", channels);
        ret.put("bits", bitsOf(enc));
        ret.put("float", isFloat(enc));
        ret.put("label", label(enc));
        ret.put("requested", requested);
        ret.put("substituted", chosen.substituted);
        ret.put("substitutionReason", chosen.reason);
        ret.put("source", activeSource);
        ret.put("unprocessedSource", "UNPROCESSED".equals(activeSource));
        ret.put("effects", effectsReport);
        // "archivalClean" is the claim that actually matters: no OS processor left running on
        // this capture. It can be true even without an UNPROCESSED source.
        ret.put("archivalClean", effectsReport.getBoolean("allDisabled", false));
        // --- AudioRouting --- (remove this line to revert; see AudioRouting.java)
        // WHICH mic this actually ran on. Additive fields only, so CONTRACT_VERSION stays 1 and an
        // engine that predates routing is unaffected. Must come AFTER startRecording(), because the
        // route is not resolved until then. Deliberately does NOT touch archivalClean above: that
        // field's documented meaning is "no OS processor left running", which stays true and
        // separately measured. Combining the two claims is the web layer's job.
        AudioRouting.describeRouted(recorder, ret);
        // --- end AudioRouting ---
        call.resolve(ret);
    }

    /** Reads raw bytes exactly as the ADC produced them and appends them to the WAV data chunk. */
    private void pump(int chunkBytes) {
        ByteBuffer buf = ByteBuffer.allocateDirect(chunkBytes);
        byte[] tmp = new byte[chunkBytes];
        long lastMeter = 0;
        while (recording) {
            buf.clear();
            int n = recorder.read(buf, chunkBytes);
            if (n <= 0) continue;
            buf.position(0);
            buf.get(tmp, 0, n);
            try {
                out.write(tmp, 0, n);
                dataBytes += n;
            } catch (Throwable t) {
                break; // disk trouble — stop() will still finalise what we have
            }
            long now = System.currentTimeMillis();
            if (now - lastMeter >= 100) {          // ~10 updates/sec keeps the bridge light
                lastMeter = now;
                final double peak = peakOf(tmp, n, activeEncoding);
                JSObject ev = new JSObject();
                ev.put("peak", peak);
                notifyListeners("meter", ev);
            }
        }
    }

    /** Peak amplitude 0..1 for the level/clipping meter (the web meter can't see a native stream). */
    private static double peakOf(byte[] b, int len, String enc) {
        double peak = 0;
        switch (enc) {
            case ENC_PCM16: {
                for (int i = 0; i + 1 < len; i += 2) {
                    int v = (short) ((b[i] & 0xff) | (b[i + 1] << 8));
                    peak = Math.max(peak, Math.abs(v) / 32768.0);
                }
                break;
            }
            case ENC_PCM24: {
                for (int i = 0; i + 2 < len; i += 3) {
                    int v = (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8) | (b[i + 2] << 16); // sign-extends
                    peak = Math.max(peak, Math.abs(v) / 8388608.0);
                }
                break;
            }
            case ENC_PCM32: {
                for (int i = 0; i + 3 < len; i += 4) {
                    int v = (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8) | ((b[i + 2] & 0xff) << 16) | (b[i + 3] << 24);
                    peak = Math.max(peak, Math.abs((double) v) / 2147483648.0);
                }
                break;
            }
            case ENC_FLOAT32: {
                ByteBuffer bb = ByteBuffer.wrap(b, 0, len).order(ByteOrder.LITTLE_ENDIAN);
                while (bb.remaining() >= 4) peak = Math.max(peak, Math.abs(bb.getFloat()));
                break;
            }
            default: break;
        }
        return Math.min(peak, 1.0);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (!recording) { call.reject("not_recording"); return; }
        recording = false;
        try { if (worker != null) worker.join(1500); } catch (InterruptedException ignored) { }
        try {
            if (recorder != null) { recorder.stop(); recorder.release(); }
        } catch (Throwable ignored) { }
        recorder = null;
        releaseEffects();
        RecordingService.stop(getContext());

        long frames = 0;
        try {
            patchWavHeader(out, activeEncoding, activeRate, activeChannels, dataBytes);
            frames = dataBytes / (bytesPerSample(activeEncoding) * (long) activeChannels);
            out.close();
        } catch (Throwable t) {
            call.reject("finalise_failed: " + t.getMessage()); return;
        }
        out = null;

        JSObject ret = new JSObject();
        ret.put("path", outFile.getAbsolutePath());
        ret.put("uri", "file://" + outFile.getAbsolutePath());
        ret.put("bytes", dataBytes);
        ret.put("frames", frames);
        ret.put("durationSec", activeRate > 0 ? (double) frames / activeRate : 0);
        // Everything below is the truthful provenance record for the archive.
        ret.put("encoding", activeEncoding);
        ret.put("bits", bitsOf(activeEncoding));
        ret.put("float", isFloat(activeEncoding));
        ret.put("sampleRate", activeRate);
        ret.put("channels", activeChannels);
        ret.put("label", label(activeEncoding));
        ret.put("source", activeSource);
        ret.put("unprocessedSource", "UNPROCESSED".equals(activeSource));
        ret.put("effects", effectsReport);
        ret.put("archivalClean", effectsReport.getBoolean("allDisabled", false));
        ret.put("substituted", activeSubstituted);
        ret.put("substitutionReason", activeSubReason);
        JSObject req = new JSObject();
        req.put("encoding", activeRequestedEncoding);
        req.put("sampleRate", activeRequestedRate);
        req.put("label", label(activeRequestedEncoding));
        ret.put("requested", req);
        ret.put("device", Build.MANUFACTURER + " " + Build.MODEL);
        ret.put("androidSdk", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        recording = false;
        try { if (worker != null) worker.join(1000); } catch (InterruptedException ignored) { }
        cleanup();
        if (outFile != null && outFile.exists()) outFile.delete();
        call.resolve();
    }

    private void cleanup() {
        recording = false;
        releaseEffects();
        try { RecordingService.stop(getContext()); } catch (Throwable ignored) { }
        try { if (recorder != null) { recorder.release(); } } catch (Throwable ignored) { }
        recorder = null;
        try { if (out != null) out.close(); } catch (Throwable ignored) { }
        out = null;
    }

    /* ---------------- capture-file lifecycle ----------------
     * The web layer ABSORBS a capture (fetch via Capacitor.convertFileSrc -> Blob -> IndexedDB)
     * and then calls deleteCapture() so nothing is left on disk. Because a crash or an OEM
     * process-kill can happen between "file written" and "absorbed", listCaptures()/cleanupCaptures()
     * let the web layer sweep orphans at startup: it knows which paths it already holds, so anything
     * else in the directory is garbage. We never auto-delete on our own — only the web layer knows
     * what has actually been absorbed, and guessing here could destroy field data. */

    @PluginMethod
    public void deleteCapture(PluginCall call) {
        String path = call.getString("path");
        JSObject ret = new JSObject();
        if (path == null || path.isEmpty()) { call.reject("no_path"); return; }
        File f = new File(path);
        // Refuse anything outside our own capture directory — never let a bad/hostile path
        // delete arbitrary app files.
        try {
            if (!f.getCanonicalPath().startsWith(captureDir().getCanonicalPath() + File.separator)) {
                call.reject("path_outside_capture_dir"); return;
            }
        } catch (Throwable t) { call.reject("path_check_failed"); return; }
        if (recording && outFile != null && outFile.getAbsolutePath().equals(f.getAbsolutePath())) {
            call.reject("still_recording_this_file"); return;   // never delete a live capture
        }
        ret.put("deleted", f.exists() && f.delete());
        call.resolve(ret);
    }

    @PluginMethod
    public void listCaptures(PluginCall call) {
        JSArray arr = new JSArray();
        File[] files = captureDir().listFiles();
        if (files != null) {
            for (File f : files) {
                if (!f.isFile()) continue;
                JSObject o = new JSObject();
                o.put("path", f.getAbsolutePath());
                o.put("bytes", f.length());
                o.put("modified", f.lastModified());
                o.put("active", recording && outFile != null && outFile.getAbsolutePath().equals(f.getAbsolutePath()));
                arr.put(o);
            }
        }
        JSObject ret = new JSObject();
        ret.put("dir", captureDir().getAbsolutePath());
        ret.put("captures", arr);
        call.resolve(ret);
    }

    /** Delete every capture EXCEPT the paths the web layer says it still needs (and the live one). */
    @PluginMethod
    public void cleanupCaptures(PluginCall call) {
        JSArray keep = call.getArray("keep", new JSArray());
        java.util.HashSet<String> keepSet = new java.util.HashSet<>();
        try { for (Object o : keep.toList()) if (o != null) keepSet.add(String.valueOf(o)); }
        catch (Throwable ignored) { }
        int deleted = 0; long freed = 0;
        File[] files = captureDir().listFiles();
        if (files != null) {
            for (File f : files) {
                if (!f.isFile()) continue;
                String p = f.getAbsolutePath();
                if (keepSet.contains(p)) continue;
                if (recording && outFile != null && outFile.getAbsolutePath().equals(p)) continue;
                long n = f.length();
                if (f.delete()) { deleted++; freed += n; }
            }
        }
        JSObject ret = new JSObject();
        ret.put("deleted", deleted);
        ret.put("bytesFreed", freed);
        call.resolve(ret);
    }

    /* ---------------- WAV container ----------------
     * Framing only: the sample bytes are written through untouched. Format code 1 (integer PCM)
     * or 3 (IEEE float) must match the real encoding, or downstream tools will misread the file. */

    private void writeWavHeaderPlaceholder(RandomAccessFile f, String enc, int rate, int channels) throws Exception {
        f.seek(0);
        f.write(new byte[44]); // patched in stop() once the data size is known
        patchWavHeader(f, enc, rate, channels, 0);
        f.seek(44);
    }

    private void patchWavHeader(RandomAccessFile f, String enc, int rate, int channels, long dataLen) throws Exception {
        int bps = bytesPerSample(enc);
        int bits = bps * 8;
        int blockAlign = bps * channels;
        int byteRate = rate * blockAlign;
        int fmt = isFloat(enc) ? WAV_FMT_FLOAT : WAV_FMT_PCM;

        ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        h.put("RIFF".getBytes("US-ASCII"));
        h.putInt((int) (36 + dataLen));
        h.put("WAVE".getBytes("US-ASCII"));
        h.put("fmt ".getBytes("US-ASCII"));
        h.putInt(16);
        h.putShort((short) fmt);
        h.putShort((short) channels);
        h.putInt(rate);
        h.putInt(byteRate);
        h.putShort((short) blockAlign);
        h.putShort((short) bits);
        h.put("data".getBytes("US-ASCII"));
        h.putInt((int) dataLen);

        long keep = f.getFilePointer();
        f.seek(0);
        f.write(h.array());
        f.seek(Math.max(keep, 44));
    }
}
