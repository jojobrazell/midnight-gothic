/* Repoint every model's .gltf at its MIXR Compress output.
 *
 * House rule 9a says any media asset pulled into a project runs through MIXR Compress,
 * and that originals are never silently overwritten. The compressor honours the second
 * half by writing to `textures/compressed/`, which means by default NOTHING changes at
 * runtime: the .gltf still names the original .jpg and the savings sit unused on disk.
 * This closes that gap by rewriting the image URIs.
 *
 * ONE .gltf, not two. Writing a second "compressed" .gltf would leave two files doing
 * the same job, which is exactly the confusion the mirror3d/mirror split caused. The
 * originals stay in `textures/` untouched, so this is reversible by re-running with
 * --revert.
 *
 * On WebP in glTF: the spec only blesses png/jpeg, with WebP behind EXT_texture_webp.
 * We do not add the extension because nothing else consumes these files: three.js hands
 * the URI to the browser, and every browser we ship to decodes WebP. If these models are
 * ever handed to another engine, run --revert first.
 *
 *   node tools/repoint-gltf-textures.mjs           # point at compressed/
 *   node tools/repoint-gltf-textures.mjs --revert  # point back at the originals
 */
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');
const REVERT = process.argv.includes('--revert');

if (!existsSync(ROOT)) { console.error('no models folder at ' + ROOT); process.exit(1); }

let files = 0, rewrote = 0, missing = 0;

for (const slug of readdirSync(ROOT)) {
  const dir = join(ROOT, slug);
  if (!statSync(dir).isDirectory()) continue;
  const gltfPath = join(dir, slug + '.gltf');
  if (!existsSync(gltfPath)) { console.warn('  no .gltf in ' + slug); continue; }

  const doc = JSON.parse(readFileSync(gltfPath, 'utf8'));
  if (!Array.isArray(doc.images) || !doc.images.length) continue;
  files++;
  let touched = 0;

  for (const img of doc.images) {
    if (!img.uri) continue;                       // an embedded buffer view, leave it
    const name = basename(img.uri);
    if (REVERT) {
      if (!img.uri.includes('compressed/')) continue;
      const orig = ['.jpg', '.png', '.jpeg'].map(e => 'textures/' + basename(name, '.webp') + e)
        .find(p => existsSync(join(dir, p)));
      if (!orig) { missing++; continue; }
      img.uri = orig; touched++;
    } else {
      if (img.uri.includes('compressed/')) continue;   // already repointed, idempotent
      const webp = 'textures/compressed/' + basename(name, extname(name)) + '.webp';
      if (!existsSync(join(dir, webp))) { missing++; console.warn('  missing ' + webp); continue; }
      img.uri = webp; touched++;
    }
  }

  if (touched) {
    writeFileSync(gltfPath, JSON.stringify(doc, null, 2));
    rewrote += touched;
    console.log('  ' + slug + ': ' + touched + ' image uri(s) -> ' + (REVERT ? 'originals' : 'compressed'));
  }
}

console.log('\n' + files + ' gltf file(s), ' + rewrote + ' uri(s) rewritten'
  + (missing ? ', ' + missing + ' with no counterpart (left alone)' : ''));
