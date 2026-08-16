/* MIDNIGHT MIRROR: the sound of the room.
 *
 * The activation lives on the MAIN DANCE FLOOR (JoJo, 2026-08-13), which makes audio
 * the most reliable signal in the building: the music is guaranteed loud all night,
 * unlike a camera in the dark. Same doctrine as the motion sensor though: an
 * ENHANCEMENT, NEVER A DEPENDENCY. `live` gates every consumer, and with no mic the
 * room falls back to its own ambient behaviour.
 *
 * Self-calibrating: bands normalise against a decaying rolling peak, so a quiet
 * soundcheck and a peak-hour set both land in 0..1 without touching a dial.
 */
export class AudioField {
  constructor() {
    this.live = false;
    this.error = null;
    this.bass = 0; this.mid = 0; this.treble = 0;
    this.beat = 0;          // a pulse that spikes on a bass hit and decays fast
    this.level = 0;
    this._peak = 1e-3;
    this._bassAvg = 0;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error = 'no mic API (needs localhost or https)';
      return false;
    }
    try {
      // raw signal: browser "helpfulness" (echo cancellation, noise suppression,
      // auto gain) is exactly what would flatten the music into mush
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ac = new AC();
      const src = this.ac.createMediaStreamSource(stream);
      this.an = this.ac.createAnalyser();
      this.an.fftSize = 1024;
      this.an.smoothingTimeConstant = 0.55;
      src.connect(this.an);
      this.buf = new Uint8Array(this.an.frequencyBinCount);
      await this.ac.resume();
      this.live = true;
      return true;
    } catch (e) {
      this.error = e.name || String(e);
      return false;
    }
  }

  stop() {
    this.live = false;
    try { this.ac && this.ac.close(); } catch {}
  }

  update(dt) {
    if (!this.live) return;
    this.an.getByteFrequencyData(this.buf);
    const n = this.buf.length, nyq = this.ac.sampleRate / 2;
    const band = (f0, f1) => {
      const i0 = Math.max(0, Math.floor(f0 / nyq * n));
      const i1 = Math.min(n - 1, Math.ceil(f1 / nyq * n));
      let s = 0;
      for (let i = i0; i <= i1; i++) s += this.buf[i];
      return s / ((i1 - i0 + 1) * 255);
    };
    const rb = band(30, 150), rm = band(200, 2000), rt = band(3000, 9000);

    this._peak = Math.max(rb, this._peak * Math.exp(-dt * 0.2), 1e-3);
    const k = f => Math.min(1, f / this._peak);
    this.bass   += (k(rb) - this.bass)   * Math.min(1, dt * 12);
    this.mid    += (k(rm) - this.mid)    * Math.min(1, dt * 10);
    this.treble += (k(rt) - this.treble) * Math.min(1, dt * 10);

    // a beat is bass JUMPING over its own slow average, not bass being loud
    this._bassAvg += (this.bass - this._bassAvg) * Math.min(1, dt * 2.2);
    const jump = this.bass - this._bassAvg;
    if (jump > 0.18) this.beat = Math.min(1, this.beat + jump * 3);
    this.beat *= Math.exp(-dt * 3.2);

    this.level = this.bass * 0.5 + this.mid * 0.35 + this.treble * 0.15;
  }
}
