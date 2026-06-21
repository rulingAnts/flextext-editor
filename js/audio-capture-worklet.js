/* audio-capture-worklet.js — AudioWorkletProcessor that captures raw Float32 PCM
 * (all input channels) from the live mic graph and posts it to the main thread
 * (record-pcm.js).
 *
 * MediaRecorder cannot emit lossless audio, so lossless recording taps the raw
 * Web Audio graph here. We buffer a few thousand samples PER CHANNEL and post
 * them by TRANSFERRING the ArrayBuffers (no copy) to keep postMessage traffic
 * low. On a 'flush' message — sent when recording stops — we post whatever
 * remains and mark it final, so the very tail of the take is never dropped.
 *
 * Captures however many channels the input actually has (1 if mono was honored,
 * 2 if not); record-pcm.js decides mono-vs-stereo from the content.
 *
 * Loaded by record-pcm.js via `addModule(new URL('audio-capture-worklet.js',
 * import.meta.url))`, which resolves against THIS file's URL (the engine path,
 * /flextext-editor/js/) — correct in both the editor and the cross-path
 * recorder app. Precached by BOTH service workers (editor + recorder).
 */
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = null; // array (per channel) of Float32Array chunks
    this._nch = 0;
    this._count = 0;     // samples per channel buffered
    this._flushAt = 8192; // ~0.17s @ 48kHz — bounds the postMessage rate
    this.port.onmessage = (e) => { if (e.data === 'flush') this._post(true); };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length && input[0] && input[0].length) {
      const nch = input.length;
      if (!this._chunks || nch !== this._nch) {
        this._nch = nch;
        this._chunks = [];
        for (let c = 0; c < nch; c++) this._chunks.push([]);
        this._count = 0;
      }
      // copy: the render buffers are reused next quantum
      for (let c = 0; c < nch; c++) this._chunks[c].push(input[c].slice(0));
      this._count += input[0].length;
      if (this._count >= this._flushAt) this._post(false);
    }
    return true; // stay alive until the node is disconnected
  }

  _post(final) {
    const nch = this._nch || 1;
    const bufs = [];
    if (this._count && this._chunks) {
      for (let c = 0; c < nch; c++) {
        const out = new Float32Array(this._count);
        let o = 0;
        for (const chunk of this._chunks[c]) { out.set(chunk, o); o += chunk.length; }
        bufs.push(out.buffer);
      }
    }
    if (this._chunks) for (let c = 0; c < nch; c++) this._chunks[c] = [];
    this._count = 0;
    this.port.postMessage({ bufs, nch, final }, bufs);
  }
}

registerProcessor('pcm-capture', PCMCapture);
