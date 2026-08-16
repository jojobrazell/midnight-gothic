/* A DUMB STATIC SERVER, for proving an upload works before it is an upload.
 *
 * Bluehost file access is plain static hosting: no Node, no API, no SSE. The venue build
 * runs on server.mjs, so the only way to know the ZIP is actually viewable is to serve the
 * extracted zip with nothing but a file handler and load it.
 *
 * `python -m http.server` cannot do this job. Thirty parallel ES module fetches make it
 * reset connections, and files that returned 200 arrive truncated, which looks exactly
 * like a broken bundle and sends you hunting a bug that is not there.
 *
 *   node tools/static-check.mjs <root> [port]
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');
const PORT = +(process.argv[3] || 4455);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gltf': 'model/gltf+json; charset=utf-8', '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  // no traversal out of the root, even in a throwaway test server
  const p = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  let f = p;
  try { if (statSync(f).isDirectory()) f = join(f, 'index.html'); } catch {}
  try {
    const s = statSync(f);
    res.writeHead(200, {
      'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream',
      'Content-Length': s.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(f).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + url);
  }
}).listen(PORT, () => console.log('static root ' + ROOT + ' on http://localhost:' + PORT));
