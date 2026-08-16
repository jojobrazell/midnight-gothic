/* MIDNIGHT MIRROR: flame physics, and the camera that pushes them.
 *
 * TWO SEPARATE THINGS, deliberately:
 *
 *   Flames  is a spring system. Every candle leans, overshoots, recovers and stretches
 *           on its own. It looks alive with NO camera attached, which is the point:
 *           a camera in a dark venue is the risk class that killed the projected room,
 *           so the camera is an enhancement here and never a dependency. Unplug it and
 *           the piece still runs.
 *
 *   MotionField is the optional sensor. It does NOT detect people. It detects CHANGE,
 *           by differencing successive camera frames, and it self-calibrates against a
 *           rolling peak so it works in a room lit only by a projector. Pose landmarking
 *           needs to see bodies and would mostly fail at this venue; frame differencing
 *           registers anything that moves, at almost no cost.
 */
import * as THREE from 'three';

/* ---------- the flame textures ----------
 * A candle flame is NOT a warm blob. It is a teardrop with a white hot base, a yellow
 * mantle, an orange body and a red wisp that fades at the tip, sitting inside a much
 * larger soft glow. The first version was one radial gradient, which is why every
 * candle read as a fuzzy dot. Two layers and a baked vertical ramp fix it.
 */
export function makeFlameTextures() {
  const S = 128;

  // THE BODY: teardrop, colour ramped bottom to tip
  const b = document.createElement('canvas');
  b.width = b.height = S;
  const g = b.getContext('2d');
  g.filter = 'blur(2.5px)';
  const ramp = g.createLinearGradient(0, S - 10, 0, 6);
  ramp.addColorStop(0.00, 'rgba(255,255,255,1)');
  ramp.addColorStop(0.16, 'rgba(255,246,216,0.98)');
  ramp.addColorStop(0.40, 'rgba(255,198,102,0.88)');
  ramp.addColorStop(0.68, 'rgba(255,132,38,0.48)');
  ramp.addColorStop(0.88, 'rgba(214,66,16,0.16)');
  ramp.addColorStop(1.00, 'rgba(150,30,8,0)');
  g.fillStyle = ramp;
  g.beginPath();
  g.moveTo(S * 0.50, S * 0.045);                                     // the wisp
  g.bezierCurveTo(S * 0.35, S * 0.34, S * 0.21, S * 0.58, S * 0.245, S * 0.735);
  g.bezierCurveTo(S * 0.275, S * 0.90, S * 0.725, S * 0.90, S * 0.755, S * 0.735);
  g.bezierCurveTo(S * 0.79, S * 0.58, S * 0.65, S * 0.34, S * 0.50, S * 0.045);
  g.closePath();
  g.fill();
  // the white hot core just above the wick
  g.filter = 'blur(7px)';
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.beginPath();
  g.ellipse(S * 0.5, S * 0.70, S * 0.115, S * 0.20, 0, 0, Math.PI * 2);
  g.fill();
  // the dark base a real flame has, where the wax vapour has not caught yet
  g.filter = 'blur(5px)';
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath();
  g.ellipse(S * 0.5, S * 0.875, S * 0.085, S * 0.055, 0, 0, Math.PI * 2);
  g.fill();

  // THE GLOW: what the flame throws onto the room around it
  const w = document.createElement('canvas');
  w.width = w.height = 64;
  const gw = w.getContext('2d');
  const rg = gw.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0.00, 'rgba(255,214,150,0.55)');
  rg.addColorStop(0.28, 'rgba(255,168,80,0.20)');
  rg.addColorStop(1.00, 'rgba(255,120,30,0)');
  gw.fillStyle = rg;
  gw.fillRect(0, 0, 64, 64);

  const mk = c => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
  return { body: mk(b), glow: mk(w) };
}

const _v = new THREE.Vector3();

export class Flames {
  /* parents: the objects a flame should be added to. Two of them, the hall and its
     mirrored copy, so every candle appears in the floor reflection too. */
  constructor(parents, textures, opts = {}) {
    this.parents = parents;
    this.tex = textures;
    this.list = [];
    this.k = opts.stiffness ?? 38;      // spring back to upright
    this.damp = opts.damping ?? 5.6;
    this.gust = 0;                      // a global gust that decays
    this.gustX = 0;
  }

  add(pos, seed, opts = {}) {
    const parts = [];
    const mkSprite = (map, parent, opacity, kind, scale) => {
      // fog:false — scene fog desaturates additive sprites with distance, and a flame
      // that goes grey at the far end of the hall reads as a dying bulb
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map, color: opts.color ?? 0xFFD9A0, transparent: true, opacity,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      s.position.copy(pos);
      // pivot at the WICK, so a lean rotates the flame about its base and not its middle
      s.center.set(0.5, kind === 'glow' ? 0.5 : 0.06);
      parent.add(s);
      parts.push({ s, kind, opacity, scale });
      return s;
    };
    // opts.parents lets a flame hang off something that MOVES (a swaying chandelier)
    // instead of off the room, so it swings with it for free
    const parents = opts.parents || this.parents;
    for (let i = 0; i < parents.length; i++) {
      const dim = i === 0 ? 1 : 0.55;            // the reflection is dimmer
      // the glow goes down first so the body burns through it
      // glow trimmed: with real shadows and AO carrying the depth, oversized halos
      // read as stickers again
      if (i === 0) mkSprite(this.tex.glow, parents[i], 0.6 * dim, 'glow', 3.8);
      mkSprite(this.tex.body, parents[i], 1 * dim, 'body', 1);
    }
    const f = {
      parts,
      lead: parts.find(p => p.kind === 'body').s,
      base: pos.clone(),
      size: opts.size ?? 0.40,
      lean: new THREE.Vector2(),
      vel: new THREE.Vector2(),
      seed: seed * 1.7,
      out: 0,                            // seconds left blown out
      birth: 0,                          // flare-up when a guest lights it
      ndc: 0,
      tilt: 0,
    };
    this.list.push(f);
    return f;
  }

  /* one strong sweep across the room, used when the sensor sees a big movement and
     when the mirror chooses someone */
  blow(ndcX, strength = 1) {
    this.gust = Math.max(this.gust, strength);
    this.gustX = ndcX;
  }

  update(dt, clock, camera, field) {
    this.gust *= Math.exp(-dt * 1.6);
    const amp = this.reduced ? 0.25 : 1;

    for (const f of this.list) {
      // where this flame sits on the screen, which is how the sensor is mapped: a
      // person crossing the left of the projection disturbs the flames on the left
      f.lead.getWorldPosition(_v);
      _v.project(camera);
      f.ndc = _v.x;

      // ambient turbulence. Two incommensurate frequencies so it never loops visibly.
      let fx = 0.55 * Math.sin(clock * 1.31 + f.seed) + 0.33 * Math.sin(clock * 2.17 + f.seed * 1.9);
      let fz = 0.40 * Math.sin(clock * 1.07 + f.seed * 2.3);
      fx *= amp; fz *= amp;

      // the sensor
      if (field && field.live) {
        const e = field.sample(f.ndc);
        fx += e.fx * 26;
        fz += e.energy * 6;
      }

      // the global gust, strongest near where it started
      if (this.gust > 0.01) {
        const d = Math.abs(f.ndc - this.gustX);
        const w = Math.exp(-d * d * 2.2) * this.gust;
        fx += w * 34 * Math.sign(f.ndc - this.gustX || 1);
        fz += w * 8;
      }

      // spring integration
      f.vel.x += (fx - this.k * f.lean.x - this.damp * f.vel.x) * dt;
      f.vel.y += (fz - this.k * f.lean.y - this.damp * f.vel.y) * dt;
      f.lean.x += f.vel.x * dt;
      f.lean.y += f.vel.y * dt;

      const speed = Math.hypot(f.vel.x, f.vel.y);
      const tilt = Math.hypot(f.lean.x, f.lean.y);

      // a hard enough gust puts a candle out for a moment. Rare on purpose: constant
      // blowing out reads as a bug, an occasional one reads as a draught.
      if (f.out <= 0 && speed > 5.6) f.out = 0.35 + (f.seed % 1) * 0.5;
      if (f.out > 0) f.out -= dt;
      if (f.birth > 0) f.birth -= dt;

      // `boost` is the music: the page sets it from the beat pulse, 1 when silent
      const flick = (1 + amp * (0.09 * Math.sin(clock * 8.1 + f.seed)
                             + 0.05 * Math.sin(clock * 13.7 + f.seed * 2.3)))
                    * (this.boost || 1);
      const stretch = 1 + Math.min(0.85, speed * 0.13);   // a leaning flame draws out
      const squeeze = 1 / (1 + Math.min(0.5, speed * 0.07));
      const flare = f.birth > 0 ? 1 + f.birth * 2.2 : 1;
      const alive = f.out > 0 ? Math.max(0, 1 - f.out * 2.6) : 1;

      for (const p of f.parts) {
        const s = p.s;
        if (p.kind === 'glow') {
          // the glow follows the flame but does not tilt or stretch: light spills
          // round, it does not lean
          s.position.set(f.base.x + f.lean.x * 0.20, f.base.y + f.size * 0.45, f.base.z + f.lean.y * 0.20);
          const gk = f.size * p.scale * (0.92 + 0.08 * flick) * flare;
          s.scale.set(gk, gk, 1);
          s.material.opacity = p.opacity * alive * (0.75 + 0.25 * flick);
        } else {
          s.position.set(f.base.x + f.lean.x * 0.30, f.base.y, f.base.z + f.lean.y * 0.30);
          s.material.rotation = -f.lean.x * 0.85;
          s.scale.set(
            f.size * flick * squeeze * flare,
            f.size * 1.70 * flick * stretch * flare,
            1);
          s.material.opacity = p.opacity * alive;
        }
      }
      f.tilt = tilt;
    }
  }
}

/* ---------- the optional sensor ----------
   A camera on the projection machine, differencing frames into a column histogram of
   motion. `live` stays false until a camera actually starts, and every consumer above
   checks it, so nothing here is load bearing. */
export class MotionField {
  constructor(opts = {}) {
    this.cols = opts.cols ?? 40;
    this.energy = new Float32Array(this.cols);
    this.flow = new Float32Array(this.cols);
    this.prev = null;
    this.live = false;
    this.total = 0;
    this.peak = 1e-4;               // rolling peak, this is the self-calibration
    this.flip = opts.flip !== false; // a camera facing the room mirrors it
    this.w = 96; this.h = 54;
    this.video = null;
    this.error = null;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error = 'no camera API (needs localhost or https)';
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
        audio: false,
      });
      const v = document.createElement('video');
      v.srcObject = stream; v.muted = true; v.playsInline = true;
      await v.play();
      this.video = v;
      const c = document.createElement('canvas');
      c.width = this.w; c.height = this.h;
      this.ctx = c.getContext('2d', { willReadFrequently: true });
      this.live = true;
      return true;
    } catch (e) {
      this.error = e.name || String(e);
      return false;
    }
  }

  stop() {
    this.live = false;
    if (this.video?.srcObject) for (const t of this.video.srcObject.getTracks()) t.stop();
  }

  update(dt) {
    if (!this.live || !this.video || this.video.readyState < 2) return;
    const { w, h, cols } = this;
    this.ctx.drawImage(this.video, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h).data;

    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4)
      lum[i] = (img[p] * 0.299 + img[p + 1] * 0.587 + img[p + 2] * 0.114) / 255;

    if (!this.prev) { this.prev = lum; return; }

    const raw = new Float32Array(cols);
    let total = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const d = Math.abs(lum[i] - this.prev[i]);
        if (d < 0.035) continue;                 // sensor noise floor
        const c = Math.min(cols - 1, ((x / w) * cols) | 0);
        raw[c] += d;
        total += d;
      }
    this.prev = lum;

    // self-calibrate: a dark room produces tiny absolute differences, so normalise
    // against a decaying peak rather than a fixed threshold
    let mx = 0;
    for (let c = 0; c < cols; c++) if (raw[c] > mx) mx = raw[c];
    this.peak = Math.max(mx, this.peak * Math.exp(-dt * 0.35), 1e-4);

    for (let c = 0; c < cols; c++) {
      const n = Math.min(1, raw[c] / this.peak);
      const prev = this.energy[c];
      this.energy[c] += (n - this.energy[c]) * Math.min(1, dt * 9);
      this.flow[c] = this.energy[c] - prev;      // rising edge, a rough direction cue
    }
    this.total = Math.min(1, total / (this.peak * cols * 0.6));
  }

  /* ndcX in -1..1 (screen space) -> a lateral force and a local energy */
  sample(ndcX) {
    if (!this.live) return { fx: 0, energy: 0 };
    let u = (ndcX * 0.5 + 0.5);
    if (this.flip) u = 1 - u;
    const f = Math.max(0, Math.min(0.9999, u)) * (this.cols - 1);
    const i = f | 0, t = f - i;
    const e = this.energy[i] * (1 - t) + this.energy[Math.min(this.cols - 1, i + 1)] * t;
    // push AWAY from where the motion is: someone walking past drags the air with them
    const left = this.energy[Math.max(0, i - 2)];
    const right = this.energy[Math.min(this.cols - 1, i + 2)];
    return { fx: (right - left) * (this.flip ? -1 : 1), energy: e };
  }
}
