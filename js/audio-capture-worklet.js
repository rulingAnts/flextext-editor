/* audio-capture-worklet.js — AudioWorkletProcessor that captures mono Float32
 * PCM from the live mic graph and posts it to the main thread (record-pcm.js).
 *
 * MediaRecorder cannot emit lossless audio, so lossless recording taps the raw
 * Web Audio graph here. We buffer a few thousand samples and post them by
 * TRANSFERRING the ArrayBuffer (no copy) to keep postMessage traffic low. On a
 * 'flush' message — sent when recording stops — we post whatever remains and
 * mark it final, so the very tail of the take is never dropped.
 *
 * Loaded by record-pcm.js via `addModule(new URL('audio-capture-worklet.js',
 * import.meta.url))`, which resolves against THIS file's URL (the engine path,
 * /flextext-editor/js/) — correct in both the editor and the cross-path
 * recorder app. Precached by BOTH service workers (editor + recorder).
 */
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._count = 0;
    this._flushAt = 8192; // ~0.17s @ 48kHz — bounds the postMessage rate
    this.port.onmessage = (e) => { if (e.data === 'flush') this._post(true); };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; // channel 0 (mono input)
    if (ch && ch.length) {
      this._chunks.push(ch.slice(0)); // copy: the render buffer is reused next quantum
      this._count += ch.length;
      if (this._count >= this._flushAt) this._post(false);
    }
    return true; // stay alive until the node is disconnected
  }

  _post(final) {
    let out;
    if (this._count) {
      out = new Float32Array(this._count);
      let o = 0;
      for (const c of this._chunks) { out.set(c, o); o += c.length; }
    } else {
      out = new Float32Array(0);
    }
    this._chunks = [];
    this._count = 0;
    this.port.postMessage({ buf: out.buffer, final }, [out.buffer]);
  }
}

registerProcessor('pcm-capture', PCMCapture);
