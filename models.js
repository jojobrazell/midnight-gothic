/* MIDNIGHT MIRROR: real modeled assets.
 *
 * THE ROOT CAUSE, named 2026-08-13. Every complaint about this room looking cartoony
 * traced back to one thing: the furniture was BoxGeometry and CylinderGeometry. No
 * amount of lighting, grading, bevelling or post-processing rescues a sofa that is
 * literally five rounded boxes, because the silhouette is wrong before a single pixel
 * is shaded, and silhouette is what the eye reads first.
 *
 * These are CC0 scanned/modeled assets (Poly Haven), shipped local, no runtime
 * internet. They arrive with real topology, real UVs and real PBR maps.
 *
 * SCALE: Poly Haven models are true real-world metres. This hall is deliberately
 * oversized (26m wide, 15m to the ceiling) so a real 2m sofa reads as doll furniture
 * in it. Every placement below therefore carries an explicit scale, tuned against the
 * footprints the primitives already occupied, and named so nobody later "fixes" it.
 */
import * as THREE from 'three';
import { GLTFLoader } from './vendor-three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

const CATALOG = {
  chandelier: 'models/lantern_chandelier_01/lantern_chandelier_01.gltf',
  sofa:       'models/sofa_02/sofa_02.gltf',
  statue:     'models/gothic_statue/gothic_statue.gltf',
  frame:      'models/fancy_picture_frame_01/fancy_picture_frame_01.gltf',
  candelabra: 'models/brass_candleholders/brass_candleholders.gltf',
};

const cache = new Map();
const placed = {};      // per-key counter, only used to make names unique

/* Load once, clone per placement. A gltf scene is a graph, so a naive second load
   would pay the parse and the GPU upload twice for the same asset. */
export function loadAsset(key) {
  if (cache.has(key)) return cache.get(key);
  const url = CATALOG[key];
  if (!url) return Promise.reject(new Error('no such asset: ' + key));
  const p = new Promise((res, rej) => {
    loader.load(url, g => res(g.scene), undefined, err => rej(err));
  });
  cache.set(key, p);
  return p;
}

/* Measure, then scale to a TARGET SIZE IN METRES on a chosen axis. Hand-tuned scale
   numbers rot the moment an asset is swapped; a target dimension survives it. */
export function fitTo(obj, axis, metres) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  /* 'auto' means the longest horizontal axis. A sofa's long side is x in one export
     and z in the next, and guessing wrong gives a sofa scaled to a footstool. */
  const cur = axis === 'x' ? size.x
            : axis === 'y' ? size.y
            : axis === 'z' ? size.z
            : Math.max(size.x, size.z);
  if (cur > 1e-6) obj.scale.multiplyScalar(metres / cur);
  return obj;
}

/* Hang an object so its TOP sits at a given local y, for anything on a chain. */
export function hangTopAt(obj, y) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.y += y - box.max.y;
  return obj;
}

/* Hang an object by its BOTTOM edge. For a hanging fixture this is the number that
   actually matters: the top is buried at the ceiling where nobody looks, while the
   bottom edge is what crops the frame and what a guest walks under. Pinning the top
   and changing the width silently drops the fixture into the shot. */
export function hangBottomAt(obj, y) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.y += y - box.min.y;
  return obj;
}

/* The local-space box of the first material whose name matches. Used to find where an
   asset's own light sources live, instead of guessing a ring radius. */
export function partBox(root, re) {
  const b = new THREE.Box3();
  let found = false;
  root.traverse(m => {
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (!mats.some(x => x && re.test(x.name || ''))) return;
    b.expandByObject(m); found = true;
  });
  return found ? b : null;
}

/* Drop an object so its lowest point sits exactly on y, instead of trusting that the
   author modelled the origin at the base. Half of them do not. */
export function seat(obj, y = 0) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.y += y - box.min.y;
  return obj;
}

/* Every asset ships its own materials. They must still obey the room: the deck's
   environment response, our shadow rules, and no accidental cel-flat surfaces. */
export function dressMaterials(obj, { envMapIntensity = 0.6, cast = true } = {}) {
  obj.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = cast;
    o.receiveShadow = true;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (!m) continue;
      m.envMapIntensity = envMapIntensity;
      // a scanned asset with an alpha map needs it honoured or glass renders as a slab
      if (m.alphaMap) { m.transparent = true; m.depthWrite = false; }
    }
  });
  return obj;
}

/* place(key, opts) -> Promise<Object3D>
   The one call the page makes. Resolves once the asset is in the scene, so callers can
   await a whole dressing pass and only then reveal the room. */
export async function place(key, {
  parent, position = [0, 0, 0], rotationY = 0, fit, seatTo,
  envMapIntensity = 0.6, cast = true, onEach,
} = {}) {
  const src = await loadAsset(key);
  const obj = src.clone(true);
  // named so __measure() can put real world numbers on it instead of a judgement call
  obj.name = 'model-' + key + '-' + (placed[key] = (placed[key] || 0) + 1);
  if (fit) fitTo(obj, fit.axis, fit.metres);
  obj.position.set(position[0], position[1], position[2]);
  obj.rotation.y = rotationY;
  dressMaterials(obj, { envMapIntensity, cast });
  if (parent) parent.add(obj);
  if (seatTo !== undefined) seat(obj, seatTo);
  if (onEach) onEach(obj);
  return obj;
}

export const ASSET_KEYS = Object.keys(CATALOG);
