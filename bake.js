/* MIDNIGHT MIRROR: the light, baked once.
 *
 * THE FINDING (Documents/PHOTOREAL-RESEARCH.md, "Bake the light, do not compute it"):
 * every celebrated three.js interior is PRE-LIT. Bruno Simon's room ships Blender bakes
 * and mixes them in a thirty line shader, so its beauty costs one texture fetch while
 * ours costs a forward loop over every point light. We cannot ship a Blender bake: the
 * room is procedural, the venue has no internet, and guests light the candles LIVE, so
 * the hall has to stay fully real time.
 *
 * So we bake the part that never moves. At load we solve the indirect and bounced light
 * per VERTEX (not per UV, because BoxGeometry's six faces share one 0..1 unwrap and an
 * atlas unwrap is a week we do not have), write it into an 'aBaked' attribute, and add
 * it to `irradiance` inside the standard shader. Zero per-frame cost, and it gives the
 * room the thing screen-space AO structurally cannot: the ceiling above you, the corner
 * behind you, and every candle that is not in the live light pool.
 *
 * THE FLICKER CHANNELS are why this does not read as a photograph of a lit room. Three
 * scalar channels ('aFlickA/B/C') carry each candle CLUSTER's share of the bake, and
 * three uniforms pulse them at runtime, so the whole hall breathes with the flames
 * without ever re-baking. Zero is neutral: the uniforms ride around 0, not around 1.
 *
 * NOTHING HERE THROWS. A bake that fails has to leave a working room behind, so every
 * risky step is guarded and logged into stats.warnings instead.
 */
import * as THREE from 'three';

const EPS = 1e-4;
const TAU = Math.PI * 2;

/* The uniform OBJECTS are shared by every injected material, so setFlicker writes one
   value and every shader in the hall sees it. This is the same trick the grunge layer
   uses, and it is the only reason a 200 material scene needs no per-frame traversal. */
const U = {
  uBakeMul:    { value: 1 },
  uFlickA:     { value: 0 },
  uFlickB:     { value: 0 },
  uFlickC:     { value: 0 },
  uFlickColor: { value: new THREE.Color(0xFFB661) },
};

/* ---------- the runtime API ---------- */

/**
 * Drive the three cluster channels. Call it every frame with SIGNED values around zero
 * (0 is the neutral bake, +-0.15 is a candle's worth of breath). Feed it 1/f noise, not
 * sine waves, and correlate it with the flame sprites so the room breathes as one.
 */
export function setFlicker(a = 0, b = 0, c = 0) {
  U.uFlickA.value = a;
  U.uFlickB.value = b;
  U.uFlickC.value = c;
}

/** Global scale on the whole bake, for tuning exposure at the venue without re-baking. */
export function setBakeIntensity(mul = 1) {
  U.uBakeMul.value = mul;
}

/** The colour the flicker channels pulse in. Amber by default, the candles' own light. */
export function setFlickerColor(color) {
  U.uFlickColor.value.set(color);
}

/* ---------- defaults ---------- */

const DEFAULTS = {
  /* how far apart baked vertices should sit. The research panel's number is 20 to 30cm;
     0.45 is the honest compromise for a 26 x 70m hall on a projector GPU. */
  spacing: 0.45,
  /* per-mesh and whole-scene ceilings on ADDED density (native geometry is always baked
     whatever the budget). Measured on the real hall (829 meshes, 133 emitters): these
     give the floor 0.45m spacing at 161k vertices for ~0.95s of solve; 9000/140000 lands
     at 143k for ~0.78s, and is the lever to pull if the load-in clock complains. */
  maxVerticesPerMesh: 16000,
  maxVertices: 200000,
  resegmentRounded: false,

  /* occlusion. 48 proxies is plenty: the shell, the balconies, the frontispiece, the
     sofas and the tables are what actually block a candle. */
  maxProxies: 48,
  proxyMinSize: 1.1,
  proxyShrink: 0.03,

  /* ambient. This is the AO-modulated bounce term, NOT a copy of the page's
     HemisphereLight: the baked one carries corner darkening, the real one cannot. */
  ambient: { sky: 0x2A1030, ground: 0x0A0714, intensity: 0.10 },
  aoSamples: 12,
  aoRadius: 2.5,
  aoStrength: 0.9,

  /* a ceiling on what one vertex may hold. Inverse square puts a vertex 5cm from a wick
     at 300x white, and the wax cylinders sit exactly there; this is INDIRECT fill, so
     it caps by luminance (never per channel, which would shift amber toward white). */
  clampIrradiance: 8,

  /* per-vertex budget. Shadow rays go to the nearest and brightest lights only; a
     candle contributing 1% of a vertex's light does not deserve a visibility test. */
  maxShadowRays: 12,
  shadowThreshold: 0.012,
  maxLightsPerMesh: 96,
  defaultRange: 9,

  /* chunking. 6ms a frame keeps the loading bar animating while the room lights up. */
  budgetMs: 6,
  autoDrive: true,
  sync: false,
  onProgress: null,
  onDone: null,
  inject: true,
};

/* ---------- helpers ---------- */

const now = () => (typeof performance !== 'undefined' && performance.now)
  ? performance.now() : Date.now();

const schedule = (fn) => (typeof requestAnimationFrame === 'function')
  ? requestAnimationFrame(fn) : setTimeout(fn, 16);

const isLitMaterial = (m) => !!m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial
  || m.isMeshPhongMaterial || m.isMeshLambertMaterial || m.isMeshToonMaterial);

const matList = (m) => Array.isArray(m) ? m : (m ? [m] : []);

/* A candle at head height belongs to a different cluster than one on the balcony rail,
   and the chandeliers are a third. Height is the cheapest read of that, and it matches
   the research panel's nave / gallery / chandelier split. Override with opts.group. */
function defaultGroup(p) {
  if (p.y < 3.0) return 0;
  if (p.y < 9.0) return 1;
  return 2;
}

/* THE SLAB TEST. A segment from (ox,oy,oz) along a unit direction, length tMax, against
   the axis aligned box packed at P[b .. b+5]. Raycaster does the same job about fifty
   times slower, which at ~20M tests is the difference between a loading bar and a
   frozen tab.
   The t0 > EPS check is load bearing twice over: it rejects a box that CONTAINS the
   origin (that box is the surface the vertex is sitting on, not an occluder) and it
   rejects a box the ray merely grazes at its start, which is every coplanar wall. */
function occluded(P, b, ox, oy, oz, dx, dy, dz, tMax) {
  let t0 = 0, t1 = tMax, ta, tb, s, inv;

  if (dx !== 0) {
    inv = 1 / dx;
    ta = (P[b] - ox) * inv; tb = (P[b + 3] - ox) * inv;
    if (ta > tb) { s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  } else if (ox < P[b] || ox > P[b + 3]) return false;

  if (dy !== 0) {
    inv = 1 / dy;
    ta = (P[b + 1] - oy) * inv; tb = (P[b + 4] - oy) * inv;
    if (ta > tb) { s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  } else if (oy < P[b + 1] || oy > P[b + 4]) return false;

  if (dz !== 0) {
    inv = 1 / dz;
    ta = (P[b + 2] - oz) * inv; tb = (P[b + 5] - oz) * inv;
    if (ta > tb) { s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  } else if (oz < P[b + 2] || oz > P[b + 5]) return false;

  return t0 > EPS;
}

/* ---------- resegmentation ----------
   A BoxGeometry has 24 vertices, so per-vertex light on it is one value per corner:
   useless. Where three.js can rebuild the same shape denser from its own parameters, we
   do; everything else is baked at its native density and counted in stats.skippedCoarse.

   REBUILT: BoxGeometry, PlaneGeometry, CylinderGeometry, SphereGeometry.
   NOT REBUILT, and why:
     RoundedBoxGeometry  already carries 324+ non-indexed vertices at segments=1, and its
                         single `segments` parameter applies to all three axes, so a long
                         thin cushion pays for density it cannot use. opts.resegmentRounded
                         turns it on anyway.
     TorusGeometry       tubularSegments already puts this scene's rings (window heads,
                         door arch, balcony caps) under 0.3m spacing.
     CircleGeometry      three.js builds ONE rim ring around a centre vertex and exposes
                         no radial subdivision, so there is nothing to densify.
     anything else       no .parameters we can trust, or a morph target set, or a material
                         array on a non-box, so rebuilding would change what renders. */
function resegment(geo, spacing, cap, allowRounded) {
  const p = geo.parameters;
  if (!p) return null;
  const t = geo.type;

  const build = (sp) => {
    const s = (len, cur) => Math.max(cur | 0 || 1, Math.max(1, Math.round(Math.abs(len) / sp)));
    if (t === 'BoxGeometry')
      return new THREE.BoxGeometry(p.width, p.height, p.depth,
        s(p.width, p.widthSegments), s(p.height, p.heightSegments), s(p.depth, p.depthSegments));
    if (t === 'PlaneGeometry')
      return new THREE.PlaneGeometry(p.width, p.height,
        s(p.width, p.widthSegments), s(p.height, p.heightSegments));
    if (t === 'CylinderGeometry')
      return new THREE.CylinderGeometry(p.radiusTop, p.radiusBottom, p.height,
        s(TAU * Math.max(p.radiusTop, p.radiusBottom), p.radialSegments),
        s(p.height, p.heightSegments), p.openEnded, p.thetaStart, p.thetaLength);
    if (t === 'SphereGeometry')
      return new THREE.SphereGeometry(p.radius,
        s(TAU * p.radius, p.widthSegments), s(Math.PI * p.radius, p.heightSegments),
        p.phiStart, p.phiLength, p.thetaStart, p.thetaLength);
    if (t === 'RoundedBoxGeometry' && allowRounded) {
      const big = Math.max(p.width, p.height, p.depth);
      const segs = Math.max(p.segments | 0 || 1, Math.min(4, Math.round(big / (sp * 2))));
      // the addon is already vendored for the furniture, so this adds no dependency
      const RB = geo.constructor;
      return new RB(p.width, p.height, p.depth, segs, p.radius);
    }
    return null;
  };

  // build and measure rather than predicting counts: three's own formulas are the truth,
  // and a discarded BufferGeometry at load costs a fraction of a millisecond
  let sp = spacing;
  for (let i = 0; i < 6; i++) {
    const g = build(sp);
    if (!g) return null;
    if (g.attributes.position.count <= cap) return g;
    g.dispose();
    sp *= 1.55;
  }
  return null;
}

/* ---------- the shader injection ----------
   '#include <lights_fragment_maps>' is the exact slot three.js r185 uses to fold a
   lightMap into `irradiance`, verified against vendor-three/three.module.js. The added
   line has to sit inside the same RE_IndirectDiffuse guard the chunk itself carries,
   because that is where `irradiance` is declared. */
const VERT_PARS = `
attribute vec3 aBaked;
attribute float aFlickA;
attribute float aFlickB;
attribute float aFlickC;
uniform float uBakeMul;
uniform float uFlickA;
uniform float uFlickB;
uniform float uFlickC;
uniform vec3 uFlickColor;
varying vec3 vBaked;
`;

function injectMaterial(mat) {
  if (!mat || mat.userData.__mmBaked) return false;
  mat.userData.__mmBaked = true;

  const prevCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    // never swallow another finding's injection (the grunge layer chains in here too)
    if (typeof prevCompile === 'function') {
      try { prevCompile.call(this, shader, renderer); } catch (e) { console.warn('[bake] chained onBeforeCompile failed', e); }
    }
    shader.uniforms.uBakeMul = U.uBakeMul;
    shader.uniforms.uFlickA = U.uFlickA;
    shader.uniforms.uFlickB = U.uFlickB;
    shader.uniforms.uFlickC = U.uFlickC;
    shader.uniforms.uFlickColor = U.uFlickColor;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + VERT_PARS)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vBaked = max( vec3( 0.0 ), aBaked + uFlickColor * ( aFlickA * uFlickA + aFlickB * uFlickB + aFlickC * uFlickC ) ) * uBakeMul;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBaked;')
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
  #if defined( RE_IndirectDiffuse )
    irradiance += vBaked;
  #endif`);
  };

  /* Without this every material hashes its own onBeforeCompile SOURCE into the program
     cache key, so three recompiles the whole physical shader per material. One constant
     key and they all share a program. The key is appended to the normal parameter hash,
     so materials that genuinely differ still get their own. */
  const prevKey = mat.customProgramCacheKey;
  const isDefaultKey = prevKey === THREE.Material.prototype.customProgramCacheKey;
  mat.customProgramCacheKey = isDefaultKey
    ? () => 'mm-bake'
    : function () { return 'mm-bake|' + prevKey.call(this); };

  /* meshes that were skipped (instanced wax, sprites, anything too coarse) share these
     materials and carry no attributes, so three feeds them these constants instead of
     whatever was last left in the generic attribute slots */
  mat.defaultAttributeValues = Object.assign({}, mat.defaultAttributeValues, {
    aBaked: [0, 0, 0], aFlickA: [0], aFlickB: [0], aFlickC: [0],
  });

  mat.needsUpdate = true;
  return true;
}

/* ---------- the bake ---------- */

/**
 * Bake per-vertex irradiance into `root` and inject it into the materials it finds.
 *
 * @param {THREE.Object3D|THREE.Object3D[]} root  the hall group (an array is accepted, so
 *        the floor and the rug, which the page adds to the scene rather than the hall,
 *        can be baked in the same pass)
 * @param {Object} opts  see DEFAULTS. opts.lights is the emitter list:
 *        [{ position:Vector3, color:Color|number, intensity:number, range:number, group:0|1|2 }]
 * @returns {{stats:Object, done:Promise, step:Function, cancel:Function, progress:number}}
 *        `stats` is live and fills in as the bake runs; `done` resolves with it.
 */
export function bakeIrradiance(root, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  o.ambient = Object.assign({}, DEFAULTS.ambient, opts.ambient || {});

  const stats = {
    meshes: 0, skipped: 0, skippedCoarse: 0, vertices: 0,
    resegmented: 0, verticesAdded: 0, proxies: 0, lights: 0,
    shadowRays: 0, aoRays: 0, materials: 0,
    progress: 0, ms: 0, done: false, cancelled: false, warnings: [],
  };
  const warn = (msg, err) => {
    stats.warnings.push(msg);
    console.warn('[bake] ' + msg, err || '');
  };

  const roots = (Array.isArray(root) ? root : [root]).filter(Boolean);
  if (!roots.length) {
    warn('no root given, nothing baked');
    stats.done = true;
    return finish(stats, Promise.resolve(stats), () => 1, () => {});
  }

  const t0 = now();
  let cancelled = false;
  const steps = bakeSteps();
  let resolveDone;
  const donePromise = new Promise(res => { resolveDone = res; });

  /* ---------- collection ---------- */

  function collect() {
    for (const r of roots) {
      try { r.updateMatrixWorld(true); } catch (e) { warn('updateMatrixWorld failed on a root', e); }
    }

    /* THE PROXIES: the scene's larger boxes, as world AABBs, packed flat so the inner
       loop never touches an object. Basic and transparent materials are out (the contact
       decals, the moonbeam cones and the floor pools are AIR, not walls). */
    const isOccluder = o.isOccluder || (() => true);
    const cand = [];
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    const collectFrom = o.occluders ? roots.concat(o.occluders) : roots;
    for (const r of collectFrom) {
      r.traverse(m => {
        if (!m.isMesh || m.isInstancedMesh || !m.visible) return;
        if (m.userData && m.userData.noOcclude) return;
        const mats = matList(m.material);
        if (!mats.length) return;
        if (mats.some(x => x.isMeshBasicMaterial || x.transparent)) return;
        let keep = true;
        try { keep = isOccluder(m) !== false; } catch (e) { warn('opts.isOccluder threw, keeping the mesh', e); }
        if (!keep) return;
        const g = m.geometry;
        if (!g || !g.attributes || !g.attributes.position) return;
        if (!g.boundingBox) g.computeBoundingBox();
        box.copy(g.boundingBox).applyMatrix4(m.matrixWorld);
        box.getSize(size);
        const d = [size.x, size.y, size.z].sort((a, b) => b - a);
        if (d[1] < o.proxyMinSize) return;      // a spindle blocks nothing worth an AABB
        cand.push({ area: d[0] * d[1], min: box.min.clone(), max: box.max.clone() });
      });
    }
    cand.sort((a, b) => b.area - a.area);
    const keep = cand.slice(0, o.maxProxies);
    const P = new Float32Array(keep.length * 6);
    for (let i = 0; i < keep.length; i++) {
      const c = keep[i], s = o.proxyShrink;
      // a shrunk box must never invert, or the slab test starts reporting hits backwards
      for (let a = 0; a < 3; a++) {
        const lo = c.min.getComponent(a) + s, hi = c.max.getComponent(a) - s;
        if (lo <= hi) { P[i * 6 + a] = lo; P[i * 6 + 3 + a] = hi; }
        else { const mid = (c.min.getComponent(a) + c.max.getComponent(a)) * 0.5; P[i * 6 + a] = mid; P[i * 6 + 3 + a] = mid; }
      }
    }
    stats.proxies = keep.length;

    /* THE EMITTERS, flattened the same way. */
    const src = Array.isArray(o.lights) ? o.lights : [];
    const L = {
      n: 0, x: null, y: null, z: null, r: null, g: null, b: null,
      range: null, group: null,
    };
    const tmpCol = new THREE.Color();
    const lx = [], ly = [], lz = [], lr = [], lg = [], lb = [], lrange = [], lgrp = [];
    for (const s of src) {
      const p = s.position;
      if (!p) continue;
      const inten = (s.intensity === undefined ? 1 : s.intensity);
      if (!(inten > 0)) continue;
      tmpCol.set(s.color === undefined ? 0xffffff : s.color);
      const range = (s.range === undefined || s.range <= 0) ? o.defaultRange : s.range;
      let grp = s.group;
      if (grp === undefined) {
        try { grp = o.group ? o.group(s) : defaultGroup(p); }
        catch (e) { warn('opts.group threw, falling back to height bands', e); grp = defaultGroup(p); }
      }
      lx.push(p.x); ly.push(p.y); lz.push(p.z);
      lr.push(tmpCol.r * inten); lg.push(tmpCol.g * inten); lb.push(tmpCol.b * inten);
      lrange.push(range); lgrp.push(Math.max(0, Math.min(2, grp | 0)));
    }
    L.n = lx.length;
    L.x = Float64Array.from(lx); L.y = Float64Array.from(ly); L.z = Float64Array.from(lz);
    L.r = Float64Array.from(lr); L.g = Float64Array.from(lg); L.b = Float64Array.from(lb);
    L.range = Float64Array.from(lrange); L.group = Uint8Array.from(lgrp);
    stats.lights = L.n;
    if (!L.n) warn('opts.lights is empty, only the ambient and AO term will be baked');

    /* THE JOBS: every mesh that can hold vertex light, resegmented where three can. */
    const jobs = [];
    const seenGeo = new Map();
    const shouldBake = o.shouldBake || (() => true);
    const cands = [];
    for (const r of roots) {
      r.traverse(m => {
        if (!m.isMesh || m.isInstancedMesh || m.isSkinnedMesh || m.isSprite || m.isPoints || m.isLine) return;
        const mats = matList(m.material).filter(isLitMaterial);
        if (!mats.length) { stats.skipped++; return; }
        if (m.userData && m.userData.noBake) { stats.skipped++; return; }
        let keep = true;
        try { keep = shouldBake(m) !== false; } catch (e) { warn('opts.shouldBake threw, keeping the mesh', e); }
        if (!keep) { stats.skipped++; return; }
        const g = m.geometry;
        if (!g || !g.attributes || !g.attributes.position || !g.attributes.normal) { stats.skipped++; return; }
        if (!g.boundingBox) g.computeBoundingBox();
        box.copy(g.boundingBox).applyMatrix4(m.matrixWorld);
        box.getSize(size);
        const d = [size.x, size.y, size.z].sort((a, b) => b - a);
        cands.push({ mesh: m, mats, area: d[0] * d[1] });
      });
    }

    /* THE BUDGET GOES TO THE BIG SURFACES FIRST. This is the whole reason for the sort:
       walking the graph in scene order let a hundred sofa cushions spend the vertex
       budget before the traverse ever reached the floor, and the floor is where baked
       candlelight actually reads. Largest silhouette first, floor and walls win. */
    cands.sort((a, b) => b.area - a.area);

    for (const cand of cands) {
      {
        const m = cand.mesh, mats = cand.mats;
        let g = m.geometry;

        try {
          const hasMorphs = g.morphAttributes && Object.keys(g.morphAttributes).length > 0;
          const matArray = Array.isArray(m.material);
          const budgetLeft = o.maxVertices - stats.vertices;
          const cap = Math.max(64, Math.min(o.maxVerticesPerMesh, budgetLeft));
          const coarse = g.attributes.position.count < 200;

          if (!hasMorphs && !(matArray && g.type !== 'BoxGeometry') && cap > 200) {
            const before = g.attributes.position.count;
            const ng = resegment(g, o.spacing, cap, o.resegmentRounded);
            if (ng) {
              if (g.attributes.uv1 && ng.attributes.uv) ng.setAttribute('uv1', ng.attributes.uv.clone());
              ng.userData = Object.assign({}, g.userData);
              ng.computeBoundingBox();
              /* the old geometry is NOT disposed: it may be shared with a mesh outside
                 the roots we walked, and a disposed live buffer is a black room. A few
                 orphaned buffers for one night is the cheaper failure. */
              m.geometry = ng;
              g = ng;
              stats.resegmented++;
              stats.verticesAdded += (g.attributes.position.count - before);
            } else if (coarse) {
              stats.skippedCoarse++;
            }
          } else if (coarse) {
            stats.skippedCoarse++;
          }
        } catch (e) {
          warn('resegment failed on ' + (m.name || g.type) + ', baking it at native density', e);
        }

        /* a geometry used by two meshes cannot hold two different bakes: the second
           mesh gets its own copy rather than silently overwriting the first */
        if (seenGeo.has(g.uuid)) {
          try {
            const c = g.clone();
            c.computeBoundingBox();
            m.geometry = c;
            g = c;
          } catch (e) {
            warn('could not clone a shared geometry, skipping the mesh', e);
            stats.skipped++;
            continue;
          }
        }
        seenGeo.set(g.uuid, true);

        if (!g.boundingBox) g.computeBoundingBox();
        jobs.push({ mesh: m, geo: g, mats });
        stats.meshes++;
        stats.vertices += g.attributes.position.count;
      }
    }

    return { P, L, jobs };
  }

  /* ---------- the solve, chunked ---------- */

  function* bakeSteps() {
    let ctx;
    try { ctx = collect(); }
    catch (e) { warn('collection failed, nothing baked', e); return; }
    const { P, L, jobs } = ctx;
    yield;

    const amb = o.ambient;
    const ambSky = new THREE.Color(amb.sky), ambGround = new THREE.Color(amb.ground);
    const ai = amb.intensity || 0;
    const clampL = o.clampIrradiance > 0 ? o.clampIrradiance : 0;

    /* the AO ray set: a fixed cosine-distributed sheaf, rotated per vertex so the
       undersampling reads as grain rather than as banding */
    const N = Math.max(0, o.aoSamples | 0);
    const su = new Float64Array(N), sv = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      // Hammersley: one stratified axis, one radical-inverse axis
      su[i] = (i + 0.5) / N;
      let bits = i, rev = 0, denom = 1;
      for (let k = 0; k < 12; k++) { rev = rev * 2 + (bits & 1); bits >>= 1; denom *= 2; }
      sv[i] = rev / denom;
    }

    const worldBox = new THREE.Box3();
    const nmat = new THREE.Matrix3();
    const scratch = new THREE.Vector3();
    let vDone = 0;
    const vTotal = Math.max(1, stats.vertices);

    for (const job of jobs) {
      if (cancelled) return;
      const { mesh, geo, mats } = job;
      let posAttr, norAttr, count;
      try {
        posAttr = geo.attributes.position;
        norAttr = geo.attributes.normal;
        count = posAttr.count;
      } catch (e) { warn('a job lost its attributes, skipping', e); continue; }
      /* the tight loop below indexes position and normal at stride 3. An interleaved or
         oddly-sized attribute would silently read the wrong floats, so it is skipped
         rather than baked into garbage. Nothing in this scene builds one today. */
      if (posAttr.isInterleavedBufferAttribute || norAttr.isInterleavedBufferAttribute
          || posAttr.itemSize !== 3 || norAttr.itemSize !== 3 || norAttr.count !== count) {
        warn('skipping ' + (mesh.name || geo.type) + ': interleaved or mismatched position/normal');
        continue;
      }

      const pos = posAttr.array, nor = norAttr.array;
      const e4 = mesh.matrixWorld.elements;
      nmat.getNormalMatrix(mesh.matrixWorld);
      const e3 = nmat.elements;

      worldBox.copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld);

      /* PER-MESH PREFILTER. This is what makes the bake finish: the lights that can
         reach this mesh at all, nearest first, each carrying only the proxies that lie
         between it and the mesh. The inner loop then walks a handful of boxes instead
         of all forty eight. */
      const near = [];
      for (let i = 0; i < L.n; i++) {
        const d = worldBox.distanceToPoint(scratch.set(L.x[i], L.y[i], L.z[i]));
        if (d < L.range[i]) near.push({ i, d });
      }
      near.sort((a, b) => a.d - b.d);
      if (near.length > o.maxLightsPerMesh) near.length = o.maxLightsPerMesh;

      const li = new Int32Array(near.length);
      const lr2 = new Float64Array(near.length);
      const lProx = [];
      for (let k = 0; k < near.length; k++) {
        const i = near[k].i;
        li[k] = i;
        lr2[k] = L.range[i] * L.range[i];
        const bx0 = Math.min(worldBox.min.x, L.x[i]), bx1 = Math.max(worldBox.max.x, L.x[i]);
        const by0 = Math.min(worldBox.min.y, L.y[i]), by1 = Math.max(worldBox.max.y, L.y[i]);
        const bz0 = Math.min(worldBox.min.z, L.z[i]), bz1 = Math.max(worldBox.max.z, L.z[i]);
        const sub = [];
        for (let q = 0; q < stats.proxies; q++) {
          const b = q * 6;
          if (P[b] > bx1 || P[b + 3] < bx0) continue;
          if (P[b + 1] > by1 || P[b + 4] < by0) continue;
          if (P[b + 2] > bz1 || P[b + 5] < bz0) continue;
          sub.push(b);
        }
        lProx.push(sub);
      }

      // and the AO neighbourhood: proxies within one ray length of the mesh
      const aoProx = [];
      {
        const R = o.aoRadius;
        const bx0 = worldBox.min.x - R, bx1 = worldBox.max.x + R;
        const by0 = worldBox.min.y - R, by1 = worldBox.max.y + R;
        const bz0 = worldBox.min.z - R, bz1 = worldBox.max.z + R;
        for (let q = 0; q < stats.proxies; q++) {
          const b = q * 6;
          if (P[b] > bx1 || P[b + 3] < bx0) continue;
          if (P[b + 1] > by1 || P[b + 4] < by0) continue;
          if (P[b + 2] > bz1 || P[b + 5] < bz0) continue;
          aoProx.push(b);
        }
      }

      const baked = new Float32Array(count * 3);
      const fA = new Float32Array(count);
      const fB = new Float32Array(count);
      const fC = new Float32Array(count);

      for (let v = 0; v < count; v++) {
        const ox = pos[v * 3], oy = pos[v * 3 + 1], oz = pos[v * 3 + 2];
        const px = e4[0] * ox + e4[4] * oy + e4[8] * oz + e4[12];
        const py = e4[1] * ox + e4[5] * oy + e4[9] * oz + e4[13];
        const pz = e4[2] * ox + e4[6] * oy + e4[10] * oz + e4[14];
        let nx = e3[0] * nor[v * 3] + e3[3] * nor[v * 3 + 1] + e3[6] * nor[v * 3 + 2];
        let ny = e3[1] * nor[v * 3] + e3[4] * nor[v * 3 + 1] + e3[7] * nor[v * 3 + 2];
        let nz = e3[2] * nor[v * 3] + e3[5] * nor[v * 3 + 1] + e3[8] * nor[v * 3 + 2];
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;

        // the ray origin lifts off the surface so a vertex never shadows itself
        const rx = px + nx * 0.02, ry = py + ny * 0.02, rz = pz + nz * 0.02;

        let ir = 0, ig = 0, ib = 0;
        let cA = 0, cB = 0, cC = 0;
        let rays = 0;

        for (let k = 0; k < li.length; k++) {
          const i = li[k];
          let dx = L.x[i] - px, dy = L.y[i] - py, dz = L.z[i] - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          /* the two cheap rejections FIRST, before any sqrt: out of range, and behind
             the surface. Half the hall's candles fail one of them at any vertex, and
             this ordering is most of the difference between a 6s bake and a 2s one. */
          if (d2 >= lr2[k]) continue;
          const ndlRaw = nx * dx + ny * dy + nz * dz;
          if (ndlRaw <= 0) continue;
          const d = Math.sqrt(d2) || 1e-6;
          const inv = 1 / d;
          dx *= inv; dy *= inv; dz *= inv;
          const ndl = ndlRaw * inv;

          /* three.js's own punctual falloff, so the bake and the live PointLights agree
             about what a candle does at two metres */
          let fall = 1 / Math.max(d2, 0.01);
          const w = 1 - Math.min(1, Math.pow(d / L.range[i], 4));
          fall *= w * w;
          if (fall <= 0) continue;

          const cr = L.r[i] * fall * ndl, cg = L.g[i] * fall * ndl, cb = L.b[i] * fall * ndl;
          const lum = cr * 0.2126 + cg * 0.7152 + cb * 0.0722;
          if (lum < 1e-5) continue;

          /* visibility, but only where it can be SEEN. A candle worth one percent of
             this vertex's light does not earn a ray, and the nearest-first ordering
             means the budget is spent on the ones that do. */
          let vis = 1;
          if (lum > o.shadowThreshold && rays < o.maxShadowRays) {
            rays++;
            const sub = lProx[k];
            for (let q = 0; q < sub.length; q++) {
              if (occluded(P, sub[q], rx, ry, rz, dx, dy, dz, d - 0.02)) { vis = 0; break; }
            }
          }
          if (!vis) continue;

          ir += cr; ig += cg; ib += cb;
          const grp = L.group[i];
          if (grp === 0) cA += lum; else if (grp === 1) cB += lum; else cC += lum;
        }
        stats.shadowRays += rays;

        /* AMBIENT x AO. The hemisphere term is three's own weighting so it sits where a
           HemisphereLight would, and the AO factor is what a screen-space pass can never
           know: the corner behind the camera. */
        if (ai > 0 || N > 0) {
          let ao = 1;
          if (N > 0 && aoProx.length) {
            // an orthonormal frame around the normal, then cosine samples inside it
            let ux = 0, uy = 1, uz = 0;
            if (Math.abs(ny) > 0.99) { ux = 1; uy = 0; uz = 0; }
            let tx = uy * nz - uz * ny, ty = uz * nx - ux * nz, tz = ux * ny - uy * nx;
            const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
            tx /= tl; ty /= tl; tz /= tl;
            const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
            // a per-vertex twist, so neighbouring vertices do not share a sample pattern
            const h = Math.sin(px * 12.9898 + py * 78.233 + pz * 37.719) * 43758.5453;
            const jitter = h - Math.floor(h);
            let hits = 0;
            for (let s = 0; s < N; s++) {
              const r = Math.sqrt(su[s]);
              const phi = TAU * ((sv[s] + jitter) % 1);
              const cx = Math.cos(phi) * r, cy = Math.sin(phi) * r;
              const cz = Math.sqrt(Math.max(0, 1 - su[s]));
              const dx = tx * cx + bx * cy + nx * cz;
              const dy = ty * cx + by * cy + ny * cz;
              const dz = tz * cx + bz * cy + nz * cz;
              for (let q = 0; q < aoProx.length; q++) {
                if (occluded(P, aoProx[q], rx, ry, rz, dx, dy, dz, o.aoRadius)) { hits++; break; }
              }
            }
            stats.aoRays += N;
            ao = 1 - o.aoStrength * (hits / N);
          }
          if (ai > 0) {
            const hw = 0.5 * ny + 0.5;
            ir += (ambGround.r + (ambSky.r - ambGround.r) * hw) * ai * ao;
            ig += (ambGround.g + (ambSky.g - ambGround.g) * hw) * ai * ao;
            ib += (ambGround.b + (ambSky.b - ambGround.b) * hw) * ai * ao;
          }
        }

        if (clampL > 0) {
          const lum = ir * 0.2126 + ig * 0.7152 + ib * 0.0722;
          if (lum > clampL) {
            const s = clampL / lum;
            ir *= s; ig *= s; ib *= s;
            cA *= s; cB *= s; cC *= s;   // the flicker channels ride the same scale
          }
        }

        baked[v * 3] = ir; baked[v * 3 + 1] = ig; baked[v * 3 + 2] = ib;
        fA[v] = cA; fB[v] = cB; fC[v] = cC;

        vDone++;
        if ((v & 255) === 255) {
          stats.progress = Math.min(0.999, vDone / vTotal);
          yield;
          if (cancelled) return;
        }
      }

      try {
        geo.setAttribute('aBaked', new THREE.BufferAttribute(baked, 3));
        geo.setAttribute('aFlickA', new THREE.BufferAttribute(fA, 1));
        geo.setAttribute('aFlickB', new THREE.BufferAttribute(fB, 1));
        geo.setAttribute('aFlickC', new THREE.BufferAttribute(fC, 1));
      } catch (e) { warn('could not write the baked attributes on ' + (mesh.name || geo.type), e); }

      if (o.inject) {
        for (const m of mats) {
          try { if (injectMaterial(m)) stats.materials++; }
          catch (e) { warn('material injection failed, that material stays unlit by the bake', e); }
        }
      }

      stats.progress = Math.min(0.999, vDone / vTotal);
      yield;
    }
  }

  /* ---------- the driver ----------
     A 160k vertex bake is a second of work, and a frozen tab during load-in is how a
     venue night starts badly. The generator yields every 256 vertices; this pumps it
     for a slice of each frame and hands the loading bar a number. */
  function pump() {
    if (cancelled) return;
    const start = now();
    let r;
    try {
      do { r = steps.next(); } while (!r.done && (now() - start) < o.budgetMs);
    } catch (e) {
      warn('the bake threw mid-solve, leaving the room as it was', e);
      r = { done: true };
    }
    report();
    if (r.done) { complete(); return; }
    schedule(pump);
  }

  function report() {
    if (typeof o.onProgress === 'function') {
      try { o.onProgress(stats.progress); } catch (e) { warn('opts.onProgress threw', e); }
    }
  }

  function complete() {
    if (stats.done) return;
    stats.progress = cancelled ? stats.progress : 1;
    stats.done = true;
    stats.cancelled = cancelled;
    stats.ms = Math.round(now() - t0);
    report();
    if (typeof o.onDone === 'function') {
      try { o.onDone(stats); } catch (e) { warn('opts.onDone threw', e); }
    }
    resolveDone(stats);
  }

  /** Run one slice by hand, for a page that would rather drive the bake from its own
      loop than let it schedule itself. Returns progress 0..1. */
  function step(ms) {
    if (stats.done || cancelled) return stats.progress;
    const start = now();
    const budget = ms === undefined ? o.budgetMs : ms;
    let r;
    try {
      do { r = steps.next(); } while (!r.done && (now() - start) < budget);
    } catch (e) {
      warn('the bake threw mid-solve, leaving the room as it was', e);
      r = { done: true };
    }
    report();
    if (r.done) complete();
    return stats.progress;
  }

  function cancel() {
    if (stats.done) return;
    cancelled = true;
    complete();
  }

  if (o.sync) {
    // the ?bake=1 path: block, measure, dump. Never the venue path.
    try { let r; do { r = steps.next(); } while (!r.done); }
    catch (e) { warn('the synchronous bake threw', e); }
    complete();
  } else if (o.autoDrive) {
    schedule(pump);
  }

  return finish(stats, donePromise, step, cancel);
}

function finish(stats, donePromise, step, cancel) {
  return {
    stats,
    done: donePromise,
    step,
    cancel,
    get progress() { return stats.progress; },
  };
}
