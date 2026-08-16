/* PACK THE WHOLE ROOM INTO ONE index.html.
 *
 * Why this exists: Bluehost file access 403s any file three or more folders deep, and it
 * has no reliable way around that from the hosting side. A 3D scene normally ships as a
 * library plus model files plus textures in nested folders, which is exactly what Bluehost
 * chokes on. So we remove the folders entirely: three.js, every addon, our own modules,
 * all five GLTF models and every texture are embedded INTO the html as data URIs. The
 * result is a single self contained file with no dependencies and no folders, which cannot
 * hit the depth limit because there is nothing to nest.
 *
 * This is a PACKAGING step, run by hand when shipping, not a build step in the dev loop.
 * The source stays split into readable files; this just bakes a deploy artifact from them.
 * No npm, Node stdlib only.
 *
 *   node tools/pack-single.mjs            ->  dist/index.html
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = p => readFileSync(join(CODE, p));
const rdText = p => rd(p).toString('utf8');

/* ---------- 1. the module graph, resolved to canonical keys ---------- */
// key = path relative to Code/ (posix slashes), except three.module.js which is "three".
const keyToFile = key => key === 'three' ? 'vendor-three/three.module.js' : key;
const fileToKey = file => file === 'vendor-three/three.module.js' ? 'three' : file;

// resolve an import specifier found inside `fromFile` to a canonical key
function resolveSpec(spec, fromFile) {
  if (spec === 'three') return 'three';
  if (spec.startsWith('three/addons/')) return 'vendor-three/addons/' + spec.slice('three/addons/'.length);
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const abs = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    return abs.replace(/^\.\//, '');
  }
  return spec; // a bare specifier we do not manage; left as-is (should not occur here)
}

// every static/dynamic import or re-export specifier in a module
const SPEC_RE = /(?:\bimport\s+(?:[^'"]*?\sfrom\s*)?|\bexport\s+[^'"]*?\sfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

function rewriteImports(src, fromFile) {
  return src.replace(SPEC_RE, (m, spec) => {
    const key = resolveSpec(spec, fromFile);
    return m.replace(spec, key);
  });
}
function importedSpecs(src, fromFile) {
  const out = new Set();
  for (const m of src.matchAll(SPEC_RE)) out.add(resolveSpec(m[1], fromFile));
  return [...out];
}

// entry specifiers, taken from index.html's main module script
const ENTRY_KEYS = [
  'three',
  'vendor-three/addons/postprocessing/EffectComposer.js',
  'vendor-three/addons/postprocessing/RenderPass.js',
  'vendor-three/addons/postprocessing/UnrealBloomPass.js',
  'vendor-three/addons/postprocessing/OutputPass.js',
  'vendor-three/addons/postprocessing/SMAAPass.js',
  'vendor-three/addons/postprocessing/GTAOPass.js',
  'vendor-three/addons/postprocessing/ShaderPass.js',
  'vendor-three/addons/lights/RectAreaLightUniformsLib.js',
  'hall.js', 'flames.js', 'audio.js', 'bake.js', 'models.js',
  'vendor-three/addons/utils/BufferGeometryUtils.js',
];

// breadth-first closure over the whole graph
const modules = new Map(); // key -> rewritten source (assets not yet inlined)
const queue = [...ENTRY_KEYS];
while (queue.length) {
  const key = queue.shift();
  if (modules.has(key)) continue;
  const file = keyToFile(key);
  if (!existsSync(join(CODE, file))) { console.error('MISSING module: ' + file); process.exit(1); }
  const raw = rdText(file);
  modules.set(key, raw);
  for (const dep of importedSpecs(raw, file)) if (!modules.has(dep)) queue.push(dep);
}
console.log('modules in graph: ' + modules.size);

/* ---------- 2. asset data URIs ---------- */
const b64 = buf => buf.toString('base64');
const assetMap = new Map(); // source path literal -> data URI

// textures the room loads directly (webp), plus the two brand marks
const TEX = [
  'textures/compressed/dark_wooden_planks_diff_2k.webp',
  'textures/compressed/dark_wooden_planks_nor_gl_2k.webp',
  'textures/compressed/dark_wooden_planks_arm_2k.webp',
  'textures/compressed/quatrefoil_jacquard_fabric_diff_2k.webp',
  'textures/compressed/quatrefoil_jacquard_fabric_nor_gl_2k.webp',
  'textures/compressed/dark_wood_diff_1k.webp',
  'textures/compressed/dark_wood_nor_gl_1k.webp',
  'textures/compressed/dark_wood_arm_1k.webp',
  'textures/compressed/fabric_pattern_07_col_1_2k.webp',
  'textures/compressed/fabric_pattern_07_nor_gl_2k.webp',
  'textures/compressed/velour_velvet_diff_1k.webp',
  'textures/compressed/velour_velvet_nor_gl_1k.webp',
  'textures/compressed/painted_plaster_wall_nor_gl_1k.webp',
  'textures/brand/compressed/mixr_logo.webp',
  'textures/brand/compressed/endless_river.webp',
];
for (const p of TEX) {
  if (!existsSync(join(CODE, p))) { console.error('MISSING texture: ' + p); process.exit(1); }
  assetMap.set(p, 'data:image/webp;base64,' + b64(rd(p)));
}

// models: fold each gltf's .bin and images INTO the gltf as data URIs, so the model
// becomes one self contained JSON, then that becomes a data URI of its own. A gltf whose
// buffers and images are already data URIs needs no folder to resolve against.
const MODELS = {
  chandelier: 'models/lantern_chandelier_01/lantern_chandelier_01.gltf',
  sofa:       'models/sofa_02/sofa_02.gltf',
  statue:     'models/gothic_statue/gothic_statue.gltf',
  frame:      'models/fancy_picture_frame_01/fancy_picture_frame_01.gltf',
  candelabra: 'models/brass_candleholders/brass_candleholders.gltf',
};
const mimeFor = uri => uri.endsWith('.webp') ? 'image/webp'
                     : uri.endsWith('.jpg') || uri.endsWith('.jpeg') ? 'image/jpeg'
                     : uri.endsWith('.png') ? 'image/png' : 'application/octet-stream';
for (const [, gltfPath] of Object.entries(MODELS)) {
  const dir = posix.dirname(gltfPath);
  const doc = JSON.parse(rdText(gltfPath));
  for (const b of (doc.buffers || [])) if (b.uri && !b.uri.startsWith('data:'))
    b.uri = 'data:application/octet-stream;base64,' + b64(rd(posix.join(dir, b.uri)));
  for (const im of (doc.images || [])) if (im.uri && !im.uri.startsWith('data:'))
    im.uri = 'data:' + mimeFor(im.uri) + ';base64,' + b64(rd(posix.join(dir, im.uri)));
  /* URL-encoded, NOT base64. The gltf already carries its bin and textures as base64
     inside it; base64-ing the whole thing again is a second 1.33x on the biggest asset in
     the file. URL-encoding a string that is mostly base64 (alphanumeric, passes through)
     costs almost nothing. Escape the single quote too, which encodeURIComponent leaves
     alone, so the data URI is safe inside models.js's single-quoted CATALOG literals. */
  const payload = encodeURIComponent(JSON.stringify(doc)).replace(/'/g, '%27');
  assetMap.set(gltfPath, 'data:model/gltf+json;charset=utf-8,' + payload);
}
console.log('assets embedded: ' + assetMap.size + ' (' + TEX.length + ' textures, ' + Object.keys(MODELS).length + ' models)');

// swap every asset path literal for its data URI, longest paths first so no path is a
// prefix of another mid-replace
function inlineAssets(src) {
  let out = src;
  for (const p of [...assetMap.keys()].sort((a, b) => b.length - a.length)) {
    out = out.split("'" + p + "'").join("'" + assetMap.get(p) + "'")
             .split('"' + p + '"').join('"' + assetMap.get(p) + '"');
  }
  return out;
}

/* ---------- 3. encode every module, build the importmap ---------- */
const imap = { imports: {} };
for (const [key, raw] of modules) {
  const rewritten = inlineAssets(rewriteImports(raw, keyToFile(key)));
  const uri = 'data:text/javascript;base64,' + b64(Buffer.from(rewritten, 'utf8'));
  imap.imports[key] = uri;
}

/* ---------- 4. assemble the single html ---------- */
let html = rdText('index.html');

// one main module script (the entry), and one importmap. bail if that assumption breaks.
const modScripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
const entry = modScripts.find(m => m[1].includes("import * as THREE"));
if (!entry) { console.error('could not find the entry module script'); process.exit(1); }

const newEntry = inlineAssets(rewriteImports(entry[1], 'index.html'));
const newMap = '<script type="importmap">\n' + JSON.stringify(imap) + '\n</script>';

/* Move the importmap and the entry module OUT of their source spots to the very END of the
   body. The importmap is now ~22MB, and a script that large in <head> blocks the body from
   painting, so the loading screen (top of body) would not show until the whole payload had
   parsed, defeating its whole purpose. At the end of the body the loading markup streams and
   paints first, then the heavy map. The map must precede the module that consumes it, so map
   first, module second. Module scripts defer regardless of position, so the move is free. */
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, ''); // old (small) map out of head
html = html.replace(entry[0], '');                                         // entry module out of body
html = html.replace('</body>', newMap + '\n<script type="module">' + newEntry + '</script>\n</body>');

// inline the favicon and touch icon so the ONE file needs nothing beside it for the tab
// icon. The og:image stays an absolute URL on purpose: link-preview scrapers (iMessage,
// WhatsApp, social) do not read data URIs, so that one image must be a real file if JoJo
// wants a thumbnail in shared links. It is a single flat file at the folder root, depth 0,
// so it never hits the Bluehost deep-folder block.
const favB64 = 'data:image/png;base64,' + b64(rd('captures/favicon.png'));
const touchB64 = 'data:image/png;base64,' + b64(rd('captures/apple-touch-icon.png'));
html = html.replace(/(<link rel="icon" href=")[^"]*(")/, '$1' + favB64 + '$2');
html = html.replace(/(<link rel="apple-touch-icon" href=")[^"]*(")/, '$1' + touchB64 + '$2');

// leave a fingerprint so a future reader knows this file is generated, not the source
html = html.replace('<title>', '<!-- SELF CONTAINED BUILD. Generated by tools/pack-single.mjs from the split source.\n'
  + '     Do not edit by hand: edit the source and re-run the packer. -->\n<title>');

const outDir = join(CODE, 'dist');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);
const mb = (Buffer.byteLength(html) / 1048576).toFixed(2);
console.log('wrote dist/index.html  ' + mb + ' MB');
