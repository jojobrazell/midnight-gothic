/* MIDNIGHT MIRROR: the shared draw module.
 *
 * The phone and the screen import THIS SAME FILE, so the little preview in a
 * guest's hand and the figure standing in the hall are the same drawing at two
 * sizes. If they drift apart, the whole trick dies, so there is exactly one
 * implementation and both surfaces call it.
 *
 * Brand discipline, from the A Dark Night deck:
 *   GOLD is architecture. Frames, plates, ornament. Nothing else.
 *   SILVER is glass and mask. Every figure is silver.
 *   The jewel and the eye glow are the ONLY saturated colour on a person, which is
 *   what stops two hundred guests from looking like confetti.
 *
 * No shadowBlur anywhere: it is the single most expensive canvas op and this draws
 * up to a few hundred figures a frame. Halos are radial gradients instead.
 */

export const TONE = {
  candle: {
    ink:   '#0B0908',
    silver:['#8E949E', '#D6DBE2', '#767C86'],
    spec:  'rgba(255,255,255,0.85)',
    light: '#FFB661',
    haze:  'rgba(255,182,97,0.10)',
    floor: 'rgba(255,182,97,0.07)',
  },
  moon: {
    ink:   '#07070B',
    silver:['#79808E', '#CFE0F0', '#636A78'],
    spec:  'rgba(255,255,255,0.9)',
    light: '#CFE0F0',
    haze:  'rgba(160,190,225,0.10)',
    floor: 'rgba(160,190,225,0.07)',
  },
};

export const GOLD = { dark: '#6E5220', mid: '#C8A24A', hi: '#E7C978', low: '#8A6B2C' };
export const PARCHMENT = '#EDE4D3';

/* The only colour a guest gets to pick. Kept to six so the hall stays coherent. */
export const JEWELS = [
  { id: 0, name: 'ROSE',     hex: '#E9A9B8' },
  { id: 1, name: 'AMBER',    hex: '#FFB661' },
  { id: 2, name: 'WINE',     hex: '#B0223F' },
  { id: 3, name: 'VIOLET',   hex: '#8A4FC8' },
  { id: 4, name: 'MOON',     hex: '#CFE0F0' },
  { id: 5, name: 'ABSINTHE', hex: '#9FBF7A' },
];

export const GLOWS = [
  { id: 0, name: 'ROSE',   hex: '#E9A9B8' },
  { id: 1, name: 'EMBER',  hex: '#FFB661' },
  { id: 2, name: 'MOON',   hex: '#CFE0F0' },
  { id: 3, name: 'VIOLET', hex: '#A96BE0' },
];

export const SILS    = ['GOWN', 'COAT', 'CLOAK', 'CORSET'];
export const MASKS   = ['VEIL', 'PORCELAIN', 'FILIGREE', 'LACE', 'DIADEM'];
export const COLLARS = ['BARE', 'RUFF', 'LACE', 'HIGH', 'RIBBON'];

export const EMPTY_LOOK = { sil: 0, mask: 1, collar: 1, jewel: 0, glow: 0 };

/* A stable per-figure phase, so everyone sways on their own clock and the hall does
   not breathe in unison like a screensaver. Derived from the id, never random, so
   every connected screen agrees. */
export const phaseOf = id => ((id * 2654435761) % 1000) / 1000 * Math.PI * 2;

const lerp = (a, b, t) => a + (b - a) * t;

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

/* ---------- the figure ---------- */

/* x, baseY: where the feet are. h: full height, head to floor.
   opts: { tone, alpha, t, id, dim, faceOut } */
export function drawReflection(ctx, look, x, baseY, h, opts = {}) {
  const L = { ...EMPTY_LOOK, ...(look || {}) };
  const T = TONE[opts.tone === 'moon' ? 'moon' : 'candle'];
  const alpha = opts.alpha == null ? 1 : opts.alpha;
  const jewel = JEWELS[L.jewel % JEWELS.length].hex;
  const glow  = GLOWS[L.glow % GLOWS.length].hex;
  const t     = opts.t || 0;
  const ph    = phaseOf(opts.id || 1);

  // The sway. Small on purpose: A Dark Night drifts, it never bounces.
  const sway = Math.sin(t * 0.55 + ph) * h * 0.006;
  const lean = Math.sin(t * 0.31 + ph * 1.7) * 0.012;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x + sway, baseY);
  ctx.rotate(lean * 0.25);

  /* Proportion, settled by looking at a zoomed frame rather than by arithmetic.
     The head must be about a THIRD of the shoulder width, and there must be a neck.
     The pass before this had a head over half the shoulder width sitting straight on a
     flat-topped box, which reads as a chess pawn no matter what you draw on it. */
  const headR = h * 0.046;
  const headY = -h * 0.912;
  const shoulderY = -h * 0.790;      // the shoulder POINT, the outer end
  const shoulderW = h * 0.140;
  const neckW = h * 0.030;
  const neckTop = -h * 0.845;        // where the shoulder line meets the neck

  /* 1. the halo, tight and faint. A wide soft halo per figure washes the hall out and
        turns twenty guests into one fog bank, which is exactly what the first pass
        looked like. */
  if (!opts.dim) {
    const g = ctx.createRadialGradient(0, -h * 0.64, 0, 0, -h * 0.64, h * 0.30);
    g.addColorStop(0, hexA(glow, 0.11));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-h * 0.30, -h * 0.94, h * 0.60, h * 0.60);
  }

  /* 2. the body, drawn as ETCHED GLASS and not as a person.
        These are reflections in an aged mirror. A pale filled silhouette reads as a
        mannequin; a dark translucent body with a silver rim reads as something the
        glass is holding. The rim is where all the light lives. */
  /* Proportion is the whole game here. A standing person is roughly a quarter of
     their height wide; the first pass gave every silhouette a hem 60 percent of its
     height across, which turns an elegant figure into a traffic cone. Every hem below
     is measured against the shoulder, and the waist is what makes it read as a body
     rather than a shape. */
  const P = new Path2D();
  const waistY = -h * 0.470;
  /* A real trapezius: the shoulder line RISES from the shoulder point to the neck over
     a proper run. A shallow cap reads as shoulder pads and a flat cap reads as a box,
     and both were visible in earlier frames. */
  const capShoulders = () => {
    P.bezierCurveTo(shoulderW * 0.76, shoulderY - h * 0.014,
                    neckW * 2.0, neckTop + h * 0.020, neckW, neckTop);
    P.lineTo(-neckW, neckTop);
    P.bezierCurveTo(-neckW * 2.0, neckTop + h * 0.020,
                    -shoulderW * 0.76, shoulderY - h * 0.014, -shoulderW, shoulderY);
    P.closePath();
  };

  if (L.sil === 0) {                        // GOWN: a soft column, slight flare
    P.moveTo(-shoulderW, shoulderY);
    P.bezierCurveTo(-h * 0.126, -h * 0.68, -h * 0.096, -h * 0.56, -h * 0.086, waistY);
    P.bezierCurveTo(-h * 0.128, -h * 0.29, -h * 0.176, -h * 0.11, -h * 0.198, 0);
    P.quadraticCurveTo(0, h * 0.016, h * 0.198, 0);
    P.bezierCurveTo(h * 0.176, -h * 0.11, h * 0.128, -h * 0.29, h * 0.086, waistY);
    P.bezierCurveTo(h * 0.096, -h * 0.56, h * 0.126, -h * 0.68, shoulderW, shoulderY);
  } else if (L.sil === 1) {                 // COAT: tailored, narrow, a little severe
    P.moveTo(-shoulderW, shoulderY);
    P.bezierCurveTo(-h * 0.130, -h * 0.69, -h * 0.086, -h * 0.57, -h * 0.078, waistY);
    P.bezierCurveTo(-h * 0.092, -h * 0.30, -h * 0.108, -h * 0.12, -h * 0.118, 0);
    P.quadraticCurveTo(0, h * 0.012, h * 0.118, 0);
    P.bezierCurveTo(h * 0.108, -h * 0.12, h * 0.092, -h * 0.30, h * 0.078, waistY);
    P.bezierCurveTo(h * 0.086, -h * 0.57, h * 0.130, -h * 0.69, shoulderW, shoulderY);
  } else if (L.sil === 2) {                 // CLOAK: falls wide and straight, no waist
    P.moveTo(-shoulderW, shoulderY);
    P.bezierCurveTo(-h * 0.186, -h * 0.60, -h * 0.200, -h * 0.26, -h * 0.210, -h * 0.02);
    P.quadraticCurveTo(-h * 0.10, h * 0.014, 0, -h * 0.004);
    P.quadraticCurveTo(h * 0.10, h * 0.014, h * 0.210, -h * 0.02);
    P.bezierCurveTo(h * 0.200, -h * 0.26, h * 0.186, -h * 0.60, shoulderW, shoulderY);
  } else {                                  // CORSET: hard cinch, then a full skirt
    const waistW = h * 0.050;
    P.moveTo(-shoulderW, shoulderY);
    P.bezierCurveTo(-h * 0.122, -h * 0.70, -h * 0.062, -h * 0.56, -waistW, waistY);
    P.bezierCurveTo(-h * 0.148, -h * 0.31, -h * 0.202, -h * 0.11, -h * 0.226, 0);
    P.quadraticCurveTo(0, h * 0.018, h * 0.226, 0);
    P.bezierCurveTo(h * 0.202, -h * 0.11, h * 0.148, -h * 0.31, waistW, waistY);
    P.bezierCurveTo(h * 0.062, -h * 0.56, h * 0.122, -h * 0.70, shoulderW, shoulderY);
  }
  capShoulders();

  /* Dark, but not a hole. The pass before this was so dark the figures vanished into
     the hall and the chosen guest read as an EMPTY gold frame. The body needs enough
     luminosity to sit in front of the room. */
  // where the figure meets the floor. Without it everyone hovers.
  if (!opts.dim) {
    const sh = ctx.createRadialGradient(0, 0, 0, 0, 0, h * 0.20);
    sh.addColorStop(0, 'rgba(0,0,0,0.50)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh;
    ctx.save(); ctx.scale(1, 0.20); ctx.fillRect(-h * 0.20, -h * 0.20, h * 0.40, h * 0.40); ctx.restore();
  }

  /* Dark. These are silhouettes lit at the edge, not pale cutouts: a light fill turns
     a crowd into grey wedges, which earlier frames showed clearly. */
  const dark = ctx.createLinearGradient(0, shoulderY, 0, 0);
  dark.addColorStop(0, hexA(T.silver[0], 0.34));
  dark.addColorStop(0.26, 'rgba(28,23,34,0.86)');
  dark.addColorStop(1, 'rgba(12,9,16,0.92)');
  ctx.fillStyle = dark;
  ctx.fill(P);

  // the rim. One weight, all the way round, because glass catches light on every edge.
  ctx.strokeStyle = hexA(T.silver[1], opts.dim ? 0.40 : 0.66);
  ctx.lineWidth = Math.max(0.55, h * 0.0055);
  ctx.stroke(P);

  // one specular band, clipped inside the body, per the deck's chrome rule
  if (!opts.dim) {
    ctx.save();
    ctx.clip(P);
    const sh = ctx.createLinearGradient(-shoulderW * 1.4, shoulderY, shoulderW * 0.5, 0);
    sh.addColorStop(0, 'rgba(255,255,255,0)');
    sh.addColorStop(0.44, hexA(T.silver[1], 0.22));
    sh.addColorStop(0.56, 'rgba(255,255,255,0.04)');
    sh.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sh;
    ctx.fillRect(-h * 0.4, shoulderY, h * 0.8, -shoulderY);
    ctx.restore();
  }

  /* No fold lines. An earlier pass drew one and, crossing the specular band and the
     far outline, it produced a visible X down the front of every guest. At the size a
     figure actually occupies on a projector, the rim and the sheen ARE the detail. */

  /* From here down the rule is SHAPE, NOT DETAIL.
     A figure occupies roughly two hundred pixels on the projector and its head about
     twenty. Stacked ruffles, dotted lace and filigree scrollwork all turned to noise
     at that size and read as insect heads in the frames. Each choice below is now one
     clean silhouette that is still tellable apart from across a dark room. */
  const neckY = neckTop;
  const rim = hexA(T.silver[1], opts.dim ? 0.40 : 0.66);
  const rimW = Math.max(0.55, h * 0.0055);
  const silver = hexA(T.silver[1], opts.dim ? 0.58 : 0.92);
  const dressDark = 'rgba(20,16,25,0.88)';

  /* 4. the high collar rises BEHIND the skull, so it is drawn before the head. */
  if (L.collar === 3) {
    ctx.beginPath();
    ctx.moveTo(-shoulderW * 0.56, neckY + h * 0.010);
    ctx.quadraticCurveTo(-h * 0.112, headY - headR * 0.90, -h * 0.048, headY - headR * 0.30);
    ctx.lineTo(-h * 0.024, neckY + h * 0.010);
    ctx.closePath();
    ctx.moveTo(shoulderW * 0.56, neckY + h * 0.010);
    ctx.quadraticCurveTo(h * 0.112, headY - headR * 0.90, h * 0.048, headY - headR * 0.30);
    ctx.lineTo(h * 0.024, neckY + h * 0.010);
    ctx.closePath();
    ctx.fillStyle = dressDark;
    ctx.fill();
    ctx.strokeStyle = rim; ctx.lineWidth = rimW; ctx.stroke();
  }

  /* 5. hair: a dark cap over the crown and behind the jaw. One shape. The pass before
        this drew a sweeping mass with its own rim, and at size it merged with the mask
        into a single dark blob where a face should be. */
  ctx.beginPath();
  ctx.arc(0, headY, headR * 1.10, Math.PI * 0.94, Math.PI * 0.06);
  ctx.quadraticCurveTo(headR * 0.62, headY - headR * 0.34, 0, headY - headR * 0.46);
  ctx.quadraticCurveTo(-headR * 0.62, headY - headR * 0.34, -headR * 1.10, headY + headR * 0.20);
  ctx.closePath();
  ctx.fillStyle = 'rgba(8,6,11,0.94)';
  ctx.fill();

  /* 6. the head. Same etched-glass treatment as the body: dark, rimmed, not pale. */
  ctx.beginPath();
  ctx.arc(0, headY, headR, 0, Math.PI * 2);
  /* Porcelain, not a dark disc. A pale face against dark hair is the entire gothic
     portrait read, and at this size it is also the only way a head is legibly a head
     instead of an insect. */
  const face = ctx.createLinearGradient(0, headY - headR, 0, headY + headR);
  face.addColorStop(0, hexA(T.silver[1], opts.dim ? 0.44 : 0.76));
  face.addColorStop(0.60, hexA(T.silver[0], opts.dim ? 0.32 : 0.56));
  face.addColorStop(1, hexA(T.silver[2], 0.26));
  ctx.fillStyle = face;
  ctx.fill();
  ctx.strokeStyle = rim; ctx.lineWidth = rimW; ctx.stroke();

  /* 7. the collars that sit in front. One shape each. */
  if (L.collar === 1) {                      // RUFF: ONE row of scallops, not a stack
    const w = shoulderW * 0.60;
    ctx.beginPath();
    for (let s = -3; s <= 3; s++) ctx.arc((s / 3) * w, neckY + h * 0.012, w * 0.21, 0, Math.PI * 2);
    ctx.fillStyle = dressDark; ctx.fill();
    ctx.strokeStyle = hexA(T.silver[1], 0.52); ctx.lineWidth = rimW * 0.8; ctx.stroke();
  } else if (L.collar === 2) {               // LACE: a wide flat collar, no dots
    ctx.beginPath();
    ctx.moveTo(-shoulderW * 0.86, neckY + h * 0.008);
    ctx.quadraticCurveTo(0, neckY + h * 0.062, shoulderW * 0.86, neckY + h * 0.008);
    ctx.lineTo(shoulderW * 0.52, neckY);
    ctx.quadraticCurveTo(0, neckY + h * 0.020, -shoulderW * 0.52, neckY);
    ctx.closePath();
    ctx.fillStyle = dressDark; ctx.fill();
    ctx.strokeStyle = hexA(T.silver[1], 0.60); ctx.lineWidth = rimW * 0.8; ctx.stroke();
  } else if (L.collar === 4) {               // RIBBON: a choker and two SHORT tails
    ctx.fillStyle = jewel;
    ctx.fillRect(-h * 0.024, neckY - h * 0.004, h * 0.048, h * 0.009);
    ctx.beginPath();
    ctx.moveTo(-h * 0.006, neckY + h * 0.005);
    ctx.lineTo(-h * 0.019, neckY + h * 0.026);
    ctx.lineTo(-h * 0.001, neckY + h * 0.021);
    ctx.closePath();
    ctx.moveTo(h * 0.006, neckY + h * 0.005);
    ctx.lineTo(h * 0.019, neckY + h * 0.026);
    ctx.lineTo(h * 0.001, neckY + h * 0.021);
    ctx.closePath();
    ctx.fill();
  }

  /* 8. the mask. Silver, always, per the deck, and the BRIGHTEST thing on the figure.
        Everything else is dark glass, so this is where the eye lands. Each option is
        ONE shape sitting across the eyes: no dot fields, no scrollwork. */
  const eyeY = headY - headR * 0.10, eyeX = headR * 0.38;
  ctx.fillStyle = silver;
  ctx.strokeStyle = silver;
  ctx.lineWidth = Math.max(0.6, h * 0.0042);

  const eyeBand = (halfH) => {               // the shared mask footprint
    ctx.beginPath();
    ctx.moveTo(-headR * 0.99, eyeY - halfH * 0.55);
    ctx.quadraticCurveTo(0, eyeY - halfH * 1.35, headR * 0.99, eyeY - halfH * 0.55);
    ctx.quadraticCurveTo(headR * 0.70, eyeY + halfH * 1.05, 0, eyeY + halfH * 0.72);
    ctx.quadraticCurveTo(-headR * 0.70, eyeY + halfH * 1.05, -headR * 0.99, eyeY - halfH * 0.55);
    ctx.closePath();
  };

  if (L.mask === 0) {                        // VEIL: a soft fall over the head
    ctx.globalAlpha = alpha * 0.26;
    ctx.beginPath();
    ctx.moveTo(-headR * 1.06, headY - headR * 0.42);
    ctx.quadraticCurveTo(0, headY - headR * 1.36, headR * 1.06, headY - headR * 0.42);
    ctx.quadraticCurveTo(headR * 1.12, headY + headR * 0.86, 0, headY + headR * 1.02);
    ctx.quadraticCurveTo(-headR * 1.12, headY + headR * 0.86, -headR * 1.06, headY - headR * 0.42);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.beginPath();                          // the band that holds it on
    ctx.moveTo(-headR * 1.0, headY - headR * 0.60);
    ctx.quadraticCurveTo(0, headY - headR * 0.94, headR * 1.0, headY - headR * 0.60);
    ctx.lineWidth = Math.max(0.7, h * 0.005);
    ctx.stroke();
  } else if (L.mask === 1) {                 // PORCELAIN: the upper half of the face
    ctx.beginPath();
    ctx.moveTo(-headR * 0.99, headY - headR * 0.10);
    ctx.quadraticCurveTo(-headR * 1.02, headY - headR * 0.98, 0, headY - headR * 0.94);
    ctx.quadraticCurveTo(headR * 1.02, headY - headR * 0.98, headR * 0.99, headY - headR * 0.10);
    ctx.quadraticCurveTo(headR * 0.46, headY + headR * 0.22, 0, headY + headR * 0.06);
    ctx.quadraticCurveTo(-headR * 0.46, headY + headR * 0.22, -headR * 0.99, headY - headR * 0.10);
    ctx.fill();
  } else if (L.mask === 2) {                 // FILIGREE: the band as an outline
    eyeBand(headR * 0.40);
    ctx.globalAlpha = alpha * 0.26; ctx.fill();
    ctx.globalAlpha = alpha; ctx.stroke();
  } else if (L.mask === 3) {                 // LACE: the band with a scalloped lower edge
    eyeBand(headR * 0.36);
    ctx.globalAlpha = alpha * 0.62; ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let s = -2; s <= 2; s++)
      ctx.arc((s / 2.4) * headR * 0.82, eyeY + headR * 0.30, headR * 0.15, 0, Math.PI);
    ctx.fill();
  } else {                                   // DIADEM: three small points above the brow
    ctx.beginPath();
    ctx.moveTo(-headR * 0.74, headY - headR * 0.72);
    ctx.lineTo(-headR * 0.38, headY - headR * 1.02);
    ctx.lineTo(-headR * 0.12, headY - headR * 0.80);
    ctx.lineTo(0, headY - headR * 1.16);
    ctx.lineTo(headR * 0.12, headY - headR * 0.80);
    ctx.lineTo(headR * 0.38, headY - headR * 1.02);
    ctx.lineTo(headR * 0.74, headY - headR * 0.72);
    ctx.closePath();
    ctx.globalAlpha = alpha * 0.55; ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(0.7, h * 0.005);
    ctx.stroke();
  }

  /* 9. the eyes. Two small points of light. Discs read as an insect, which is exactly
        what the earlier frames showed. */
  if (!opts.dim) {
    const g2 = ctx.createRadialGradient(0, eyeY, 0, 0, eyeY, headR * 0.85);
    g2.addColorStop(0, hexA(glow, 0.30));
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(-headR, eyeY - headR, headR * 2, headR * 2);
  }
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(-eyeX, eyeY, headR * 0.125, headR * 0.070, 0, 0, Math.PI * 2);
  ctx.ellipse(eyeX, eyeY, headR * 0.125, headR * 0.070, 0, 0, Math.PI * 2);
  ctx.fill();

  /* 9. the jewel at the throat */
  ctx.fillStyle = jewel;
  ctx.beginPath();
  const jy = neckY + h * 0.026, jr = h * 0.010;
  ctx.moveTo(0, jy - jr * 1.5); ctx.lineTo(jr, jy); ctx.lineTo(0, jy + jr * 1.5); ctx.lineTo(-jr, jy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = hexA('#FFFFFF', 0.7);
  ctx.beginPath();
  ctx.arc(-jr * 0.25, jy - jr * 0.4, jr * 0.22, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/* ---------- the gilt frame ----------
   One implementation, used for the big mirror, the frame that draws itself around a
   chosen guest, the empty frames left on the back wall, and the portrait export. */

/* progress 0..1 lets the frame DRAW ITSELF around the chosen guest rather than
   appearing, which is the single hard beat in the whole piece. */
export function drawFrame(ctx, x, y, w, h, opts = {}) {
  const p = opts.progress == null ? 1 : Math.max(0, Math.min(1, opts.progress));
  const t = Math.max(2, opts.thickness || Math.min(w, h) * 0.045);
  const alpha = opts.alpha == null ? 1 : opts.alpha;
  if (p <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  const g = ctx.createLinearGradient(x, y, x + w * 0.35, y + h);
  g.addColorStop(0, GOLD.low);
  g.addColorStop(0.35, GOLD.mid);
  g.addColorStop(0.48, GOLD.hi);
  g.addColorStop(0.62, GOLD.mid);
  g.addColorStop(1, GOLD.dark);

  /* The reveal is a clip that sweeps from the top down, so the frame appears to be
     poured rather than faded in. Fading gold looks like a loading state. */
  if (p < 1) {
    ctx.beginPath();
    ctx.rect(x - t * 2, y - t * 2, w + t * 4, (h + t * 4) * p);
    ctx.clip();
  }

  ctx.strokeStyle = g;
  ctx.lineJoin = 'round';

  ctx.lineWidth = t;
  roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.05);
  ctx.stroke();

  ctx.lineWidth = t * 0.28;
  ctx.strokeStyle = hexA(GOLD.hi, 0.85);
  roundRect(ctx, x + t * 0.62, y + t * 0.62, w - t * 1.24, h - t * 1.24, Math.min(w, h) * 0.04);
  ctx.stroke();

  ctx.strokeStyle = hexA(GOLD.dark, 0.9);
  roundRect(ctx, x - t * 0.62, y - t * 0.62, w + t * 1.24, h + t * 1.24, Math.min(w, h) * 0.06);
  ctx.stroke();

  /* corner cartouches: two opposed scrolls, mirrored into all four corners */
  ctx.strokeStyle = g;
  ctx.lineWidth = t * 0.34;
  const s = Math.min(w, h) * 0.085;
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(sx, sy);
    ctx.beginPath();
    ctx.moveTo(s * 1.15, -t * 0.1);
    ctx.quadraticCurveTo(s * 0.25, -t * 0.1, s * 0.18, s * 0.55);
    ctx.quadraticCurveTo(s * 0.15, s * 0.95, s * 0.55, s * 0.92);
    ctx.moveTo(-t * 0.1, s * 1.15);
    ctx.quadraticCurveTo(-t * 0.1, s * 0.25, s * 0.55, s * 0.18);
    ctx.stroke();
    ctx.restore();
  }

  /* The crest: an ogee cartouche with a finial, centred on the top rail. The first
     pass used two humps meeting in a dip, which reads as a pair of arches and not as
     ornament. One sweep to a point, with a ball on top. */
  if (opts.crest !== false) {
    const cw = Math.min(w, h) * 0.10;
    const cx = x + w / 2, cy = y - t * 0.5;
    ctx.lineWidth = t * 0.40;
    ctx.beginPath();
    ctx.moveTo(cx - cw, cy);
    ctx.bezierCurveTo(cx - cw * 0.64, cy - cw * 0.08, cx - cw * 0.36, cy - cw * 0.50, cx, cy - cw * 0.70);
    ctx.bezierCurveTo(cx + cw * 0.36, cy - cw * 0.50, cx + cw * 0.64, cy - cw * 0.08, cx + cw, cy);
    ctx.stroke();
    ctx.beginPath();                                 // the volutes at each end
    ctx.moveTo(cx - cw, cy);
    ctx.quadraticCurveTo(cx - cw * 1.26, cy - cw * 0.26, cx - cw * 1.02, cy - cw * 0.36);
    ctx.moveTo(cx + cw, cy);
    ctx.quadraticCurveTo(cx + cw * 1.26, cy - cw * 0.26, cx + cw * 1.02, cy - cw * 0.36);
    ctx.lineWidth = t * 0.26;
    ctx.stroke();
    ctx.fillStyle = g;                               // the finial
    ctx.beginPath();
    ctx.arc(cx, cy - cw * 0.80, cw * 0.115, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
export { roundRect };

/* ---------- the engraved nameplate ---------- */

export const SERIF = "'Cormorant Garamond','Playfair Display',Georgia,'Times New Roman',serif";

export function drawPlate(ctx, cx, y, w, text, opts = {}) {
  const h = opts.height || w * 0.20;
  const alpha = opts.alpha == null ? 1 : opts.alpha;
  ctx.save();
  ctx.globalAlpha = alpha;

  const g = ctx.createLinearGradient(cx - w / 2, y, cx - w / 2, y + h);
  g.addColorStop(0, GOLD.hi);
  g.addColorStop(0.45, GOLD.mid);
  g.addColorStop(1, GOLD.low);
  ctx.fillStyle = g;
  roundRect(ctx, cx - w / 2, y, w, h, Math.min(h * 0.28, 12));   // 8-14px house rule
  ctx.fill();

  ctx.strokeStyle = hexA(GOLD.dark, 0.85);
  ctx.lineWidth = Math.max(1, h * 0.05);
  ctx.stroke();

  const fs = opts.fontSize || h * 0.50;
  ctx.font = `600 ${fs}px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = `${fs * 0.16}px`;       // engraved, not typed
  ctx.fillStyle = hexA('#2A1E08', 0.92);
  ctx.fillText(text, cx, y + h * 0.54);
  ctx.fillStyle = hexA('#FFF3D0', 0.30);      // the cut edge catching the light
  ctx.fillText(text, cx, y + h * 0.525);
  ctx.letterSpacing = '0px';

  ctx.restore();
}

/* ---------- the sigil ----------
   Slowsie asked for gothic MAGICAL, not gothic horror. This is where the magic
   lives: a slow rotating ring under the chosen guest and behind the hall. */
export function drawSigil(ctx, cx, cy, r, t, opts = {}) {
  const col = opts.color || GOLD.mid;
  const alpha = opts.alpha == null ? 0.5 : opts.alpha;
  const points = opts.points || 7;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  if (opts.flat) ctx.scale(1, opts.flat);      // laid on the floor in perspective
  ctx.rotate(t * 0.09);
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(0.8, r * 0.012);

  /* A ROSE WINDOW, not a pentagram. The first pass drew a star polygon and it landed
     as an occult symbol, which is the wrong register: Slowsie asked for gothic
     MAGICAL, and a cathedral window is enchantment where a pentagram is a horror
     movie. Rings, spokes, and petals only. */
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.30, 0, Math.PI * 2); ctx.stroke();

  for (let i = 0; i < points * 2; i++) {        // the spokes
    const a = (i / (points * 2)) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.30, Math.sin(a) * r * 0.30);
    ctx.lineTo(Math.cos(a) * r * 0.86, Math.sin(a) * r * 0.86);
    ctx.stroke();
  }
  for (let i = 0; i < points; i++) {            // the petals between them
    const a = (i / points) * Math.PI * 2 + Math.PI / points;
    const pr = r * 0.58, pw = r * 0.17;
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * pr, Math.sin(a) * pr, pw, pw * 0.55, a, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.globalAlpha = alpha * 0.75;               // the ticks around the rim
  for (let i = 0; i < points * 3; i++) {
    const a = (i / (points * 3)) * Math.PI * 2;
    const inner = i % 3 === 0 ? r * 1.02 : r * 1.05;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.lineTo(Math.cos(a) * r * 1.10, Math.sin(a) * r * 1.10);
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------- embers ----------
   The other half of "magical". Cheap, additive, and the only fast thing on screen. */
export function drawEmbers(ctx, w, h, t, tone, count = 90) {
  const T = TONE[tone === 'moon' ? 'moon' : 'candle'];
  ctx.save();
  for (let i = 0; i < count; i++) {
    const g = 0.618033988749895;
    const bx = ((i * g) % 1) * w;
    const speed = 0.10 + ((i * 3 * g) % 1) * 0.16;
    const by = h - ((t * speed * h * 0.16 + ((i * 7 * g) % 1) * h) % (h * 1.15));
    const drift = Math.sin(t * 0.4 + i) * w * 0.006;
    const r = (0.6 + ((i * 11 * g) % 1) * 1.7) * (h / 900);
    const a = 0.10 + ((i * 13 * g) % 1) * 0.30;
    ctx.globalAlpha = a * Math.max(0, Math.min(1, (h - by) / (h * 0.7)));
    ctx.fillStyle = T.light;
    ctx.beginPath();
    ctx.arc(bx + drift, by, r * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export { hexA, lerp };
