// MIDNIGHT MIRROR server. Node stdlib only, no npm install, no build step.
//
// THE MODEL: the projection is one enormous mirror. It does not reflect the room,
// it reflects the MANOR. Every guest builds the reflection the mirror sees when it
// looks at them (thumb only, no camera), and that reflection takes a place in a
// candlelit hall on the screen. Every few minutes the mirror CHOOSES one of them
// by name, and the whole room turns to find out who it is.
//
// NO CAMERA ANYWHERE. That is deliberate. R!OT WALL on the other floor already
// carries camera and printed-panel risk; this one must not. It also means no
// secure context is needed, so plain http over venue wifi works and the whole
// installation runs with NO INTERNET.
//
// THE HALL IS AN EVENT LOG-ish STATE, not an image. Guests and their looks persist,
// so a reload of the screen rebuilds the hall exactly, moderation can remove one
// person, and the end of the night can export everyone's portrait.
//
//   node server.mjs [port]

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
/* PORT from the environment first: every host (Render, Railway, Fly) assigns
   one and ignores whatever you hardcoded. The CLI argument stays for local. */
const PORT = Number(process.env.PORT || process.argv[2] || 8400);
const DATA = join(ROOT, 'data');
const STATE_FILE = join(DATA, 'hall.json');
const ADMIN_KEY = process.env.MIRROR_ADMIN_KEY || 'midnight2026';

/* ---------- lead backup to Firestore ----------
   data/ is EPHEMERAL on a PaaS free tier: a redeploy or a spin-down wipes the
   disk, and the emails are the deliverable of the night. So every join is also
   fired at Firestore, write-only, fire-and-forget: a Firestore failure logs and
   never blocks the candle. Same pattern and key as the riot wall next door.
   FIREBASE_API_KEY is env-only ON PURPOSE: this repo is public. */
const FB = {
  project: process.env.FIREBASE_PROJECT_ID || 'mixr-project-board',
  apiKey: process.env.FIREBASE_API_KEY || '',
  collection: process.env.FIREBASE_COLLECTION || 'midnight-gothic-leads',
  token: '', tokenAt: 0,
};
if (!FB.apiKey) console.log('lead backup to Firestore is OFF: set FIREBASE_API_KEY to enable');
async function fbToken() {
  if (FB.token && Date.now() - FB.tokenAt < 50 * 60 * 1000) return FB.token;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB.apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }) });
  if (!r.ok) throw new Error('firebase auth ' + r.status);
  const j = await r.json();
  FB.token = j.idToken; FB.tokenAt = Date.now();
  return FB.token;
}
function pushLead(g) {
  if (!FB.project || !FB.apiKey) return;
  (async () => {
    const token = await fbToken();
    const r = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FB.project}/databases/(default)/documents/${encodeURIComponent(FB.collection)}`,
      { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ fields: {
          handle: { stringValue: g.handle },
          email:  { stringValue: g.email },
          event:  { stringValue: 'slowsie-2026-08-15' },
          joined: { timestampValue: new Date(g.ts).toISOString() },
        } }) });
    if (!r.ok) throw new Error('firestore write ' + r.status);
  })().catch(e => console.warn('lead backup failed:', e.message));
}

// Beat timing. Overridable from /admin at load-in, because a room that is filling
// wants the mirror choosing often and a packed room wants it rarer.
const DEFAULTS = {
  chooseEveryMs: 4 * 60 * 1000, // how often the mirror picks someone
  chooseHoldMs: 18000,          // long enough for the chosen guest to step up and shoot
  takenHoldMs: 9000,            // how long the dissolve reads before they return
  takenBackMs: 90000,           // a taken guest returns to the hall after this
  minGuestsToChoose: 3,         // below this it is a spotlight on the only person here
};

/* The QR layer. Guests scan, and their phone reaches the room: a gust across the
   candles, a flare, petals, a request to turn the light, a request to be called.
   Everything below is a ceiling, and there are three of them because they fail
   differently. A budget per guest stops one phone owning the wall. A gap per action
   stops the same beat landing on top of itself and reading as noise. A room budget
   stops two hundred phones on a packed floor from melting the projection at 1am. */
/* The moods guests can vote the room into. Each is a designed lighting palette
   in the room page; the server only referees names. */
const MOODS = ['candle','moon','ember','violet','rose','jade'];

const CONTROL = {
  windowMs: 10000,      // the per-guest budget window
  perGuest: 3,          // actions a guest may spend inside it
  roomWindowMs: 5000,   // the room-wide window for effects that cost the renderer
  roomMax: 14,          // accepted effects across every phone inside it
  /* self: that guest's own wait for this action. room: the gap before this beat can
     land again at all, from anyone. The two ceilings guard different things, which is
     why they are tuned apart: the per-action room gap protects the LOOK (a petal burst
     on top of a petal burst is a mess, a flare on top of a flare is a strobe), and the
     room budget protects the SSE fan-out to two hundred phones. A gust is the cheap
     tactile one, so its gap is only long enough to stop two phones firing the same
     instant; anything longer and half the floor gets refused for tapping together,
     which is the fastest way to teach a room that the buttons do not work. */
  gaps: {
    /* Halved for flare and petals (JoJo, night-of ruling 2026-08-15): the 20s/15s
       packed-floor numbers read as broken buttons at a party this size. The room
       budget above stays as the melt-guard if the floor does fill. */
    gust:   { self:  2500, room:  300 },
    flare:  { self:  8000, room: 3500 },
    petals: { self:  6000, room: 2500 },
    mood:   { self:  4000, room: 2000 },
    summon: { self: 45000, room:    0 },
  },
  moodWindowMs: 45000,  // how long a guest's standing mood request keeps counting
  moodMin: 3,           // the floor under the threshold, for a room that is still filling
  moodMax: 20,          // and the ceiling, see moodNeed()
  moodFraction: 0.25,
  moodHoldMs: 90000,    // once the room turns it stays turned, or the light strobes
};
const EFFECTS = new Set(['gust', 'flare', 'petals']);      // the ones that cost the room
const ACTIONS = new Set([...EFFECTS, 'mood', 'summon']);

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp',
  '.woff2':'font/woff2', '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8',
  '.jpeg':'image/jpeg',
  // the modelled furniture: a .gltf is JSON, its buffers and any .glb are binary
  '.gltf':'model/gltf+json; charset=utf-8', '.bin':'application/octet-stream',
  '.glb':'model/gltf-binary', '.ktx2':'image/ktx2',
};

/* ---------- state ---------- */
let guests = new Map();   // id -> { id, handle, email, ts, look, chosen, taken, takenAt, banished }
let nextId = 1;
let mood = 'candle';      // 'candle' (stay) or 'moon' (run). Set by the midnight vote.
let photoMode = false;    // the step-and-repeat drape: staff drops it for photo runs
let cfg = { ...DEFAULTS };
let phase = { name: 'idle', guestId: 0, until: 0 };
let vote = null;          // { q, a, b, tally:{a,b}, voters:[ids], open:true }
let lastChooseAt = 0;
let rotation = 0;         // fair-rotation pointer, so the same face is not picked twice
const clients = new Set();

/* control-layer bookkeeping. All of it is in memory on purpose: a cooldown that
   survives a server restart would punish guests for our crash, and the queue and the
   tally are both about THIS moment in the room, not about the night as a record. */
const spent = new Map();  // guest id -> [timestamps] inside their budget window
const selfAt = new Map(); // guest id -> { action: epoch } their own last use
const roomAt = {};        // action -> epoch, the last time the ROOM took it
let roomSpent = [];       // timestamps of accepted effects, room wide
const moodReq = new Map();// guest id -> { side, at }, standing requests to turn the light
let summons = [];         // guest ids waiting to be called, in the order they asked
let lastMoodTurn = 0;

if (existsSync(STATE_FILE)) {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    nextId = s.nextId || 1;
    mood = s.mood || 'candle';
    cfg = { ...DEFAULTS, ...(s.cfg || {}) };
    for (const g of (s.guests || [])) guests.set(g.id, g);
    console.log(`restored ${guests.size} guests`);
  } catch { console.log('hall.json unreadable, starting clean'); }
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(DATA, { recursive: true });
      await writeFile(STATE_FILE, JSON.stringify({
        nextId, mood, cfg, guests: [...guests.values()],
      }));
    } catch (e) { console.error('persist failed', e.message); }
  }, 3000);
}

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch {} }
}

function lanUrls(port) {
  const out = [];
  for (const list of Object.values(networkInterfaces()))
    for (const ni of list || [])
      // the join QR must land on the PHONE page: the root is the projected room now
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}/phone.html`);
  return out;
}

function readBody(req, limit = 400_000) {
  return new Promise((res, rej) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length;
      if (n > limit) { rej(new Error('too large')); req.destroy(); return; }
      chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

/* Strip control characters only. NOT punctuation: an email is about to go through
   here and `slowsie@endless-river.com` must survive with its hyphen, and a
   plus-addressed `jo+kcon@x.com` must survive with its plus. Getting this wrong
   corrupts the lead list silently and still passes the address regex. */
const clean = (s, max) =>
  String(s == null ? '' : s).replace(/[ -]/g, '').trim().slice(0, max);

const num = (v, lo, hi, dflt) => {
  const n = +v;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* A handle goes on a ten foot screen in front of a few hundred people. This list is
   a speed bump for the laziest cases, NOT moderation. Staff banish in /admin is the
   moderation, and it is one tap. */
const BLOCK = ['fuck','shit','cunt','nigg','fagg','rape','nazi','kys','slut','whore'];
function handleOk(h) {
  const low = h.toLowerCase().replace(/[^a-z]/g, '');
  return !BLOCK.some(b => low.includes(b));
}

/* Where a guest stands in the hall. Derived from the id so it is stable across a
   screen reload and identical on every connected client, which a random position
   would not be. Depth bands keep the near figures large and readable and push the
   crowd into the distance instead of into a pile. */
/* A deterministic integer hash, so every screen agrees and a reload does not move
   anybody. NOT a golden-ratio sequence: deriving x from id*g and depth from id*3g
   makes both linear in id, so the guests land on a lattice and the hall fills up
   with diagonal conga lines. This was visible immediately at sixty guests. */
function hash01(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = n + (n << 3);
  n = n ^ (n >>> 4);
  n = Math.imul(n, 0x27d4eb2d);
  n = n ^ (n >>> 15);
  return (n >>> 0) / 4294967296;
}

function placeOf(id) {
  // Depth is CONTINUOUS. An earlier version bucketed it into four bands and the hall
  // came out as four tidy rows of people, which looks like a class photo.
  return {
    x: 0.05 + hash01(id * 2 + 1) * 0.90,
    depth: 0.12 + hash01(id * 2 + 2) * 0.80,
  };
}

const LOOK_MAX = { sil: 3, mask: 4, collar: 4, jewel: 5, glow: 3 };
function cleanLook(raw) {
  const out = {};
  for (const k of Object.keys(LOOK_MAX)) out[k] = num(raw && raw[k], 0, LOOK_MAX[k], 0) | 0;
  return out;
}

/* public view of a guest: never carries the email */
const pub = g => ({
  id: g.id, handle: g.handle, look: g.look, chosen: g.chosen || 0,
  taken: !!g.taken, place: placeOf(g.id),
});

const eligible = () =>
  [...guests.values()].filter(g => !g.banished && !g.taken && g.look);

/* ---------- the control layer ---------- */

/* How many distinct guests it takes to turn the light. A fraction of the hall so a
   quiet room can still do it and a busy one is not turned by three people, but CAPPED,
   because a quarter of three hundred phones will never agree inside one window and a
   button that can never work is a lie told to every guest holding it. */
function moodNeed() {
  return Math.max(CONTROL.moodMin,
    Math.min(CONTROL.moodMax, Math.ceil(eligible().length * CONTROL.moodFraction)));
}

/* Counts distinct guests, and expires their request while counting. A guest may change
   their mind inside the window: the last side they asked for is the one that counts. */
function moodTally() {
  const now = Date.now();
  const t = Object.fromEntries(MOODS.map(m => [m, 0]));
  for (const [id, r] of moodReq) {
    const g = guests.get(id);
    if (!g || g.banished || now - r.at > CONTROL.moodWindowMs) { moodReq.delete(id); continue; }
    t[r.side]++;
  }
  return t;
}

/* Prunes guests who can never be called again. NOT the taken: being dissolved lasts
   ninety seconds and then they walk back into the hall, so dropping them here would
   quietly cost someone their place in the line for a beat they did not ask for.
   pickGuest simply skips over them until they return. */
function summonQueue() {
  summons = summons.filter(id => {
    const g = guests.get(id);
    return g && !g.banished && g.look;
  });
  return summons;
}

function dropSummon(id) {
  const i = summons.indexOf(id);
  if (i < 0) return false;
  summons.splice(i, 1);
  return true;
}

/* One gate for every action, so a refusal can say WHICH ceiling it hit and exactly how
   long the wait is. A button that greys out without a number is a button guests keep
   mashing, which is the load this whole section exists to prevent. */
function gate(id, action) {
  const now = Date.now();
  const gp = CONTROL.gaps[action];

  const mine = (spent.get(id) || []).filter(t => now - t < CONTROL.windowMs);
  spent.set(id, mine);
  if (mine.length >= CONTROL.perGuest)
    return { scope: 'guest', until: mine[0] + CONTROL.windowMs };

  const last = (selfAt.get(id) || {})[action] || 0;
  if (now - last < gp.self) return { scope: 'action', until: last + gp.self };

  if (gp.room && now - (roomAt[action] || 0) < gp.room)
    return { scope: 'room', until: (roomAt[action] || 0) + gp.room };

  if (EFFECTS.has(action)) {
    roomSpent = roomSpent.filter(t => now - t < CONTROL.roomWindowMs);
    if (roomSpent.length >= CONTROL.roomMax)
      return { scope: 'room', until: roomSpent[0] + CONTROL.roomWindowMs };
  }
  return null;
}

function spend(id, action) {
  const now = Date.now();
  spent.set(id, [...(spent.get(id) || []), now]);
  const s = selfAt.get(id) || {};
  s[action] = now; selfAt.set(id, s);
  roomAt[action] = now;
  if (EFFECTS.has(action)) roomSpent.push(now);
}

/* What one guest is allowed to do right now. The phone renders its countdowns straight
   off this instead of guessing, so a reconnecting phone and a phone that never dropped
   show the same numbers. */
function meControl(id) {
  const now = Date.now();
  const mine = (spent.get(id) || []).filter(t => now - t < CONTROL.windowMs);
  const s = selfAt.get(id) || {};
  const ready = {};
  for (const a of ACTIONS) {
    const gp = CONTROL.gaps[a];
    ready[a] = Math.max((s[a] || 0) + gp.self, (roomAt[a] || 0) + gp.room);
  }
  const q = summonQueue();
  const r = moodReq.get(id);
  return {
    left: Math.max(0, CONTROL.perGuest - mine.length),
    until: mine.length >= CONTROL.perGuest ? mine[0] + CONTROL.windowMs : 0,
    ready,
    mood: r && now - r.at < CONTROL.moodWindowMs ? r.side : null,
    summon: q.includes(id) ? q.indexOf(id) + 1 : 0,
  };
}

/* The shared truth: the tally and the queue. A phone that reconnects mid-vote reads
   this and is immediately correct, rather than waiting for the next broadcast. */
function controlState() {
  return {
    mood, tally: moodTally(), need: moodNeed(),
    moodWindowMs: CONTROL.moodWindowMs,
    turnedAt: lastMoodTurn,
    holdUntil: lastMoodTurn ? lastMoodTurn + CONTROL.moodHoldMs : 0,
    voteOpen: !!(vote && vote.open),
    queue: summonQueue().slice(0, 60),
    queued: summons.length,
    limits: { windowMs: CONTROL.windowMs, perGuest: CONTROL.perGuest, gaps: CONTROL.gaps },
    now: Date.now(),
  };
}

/* Staff and the midnight vote outrank the tally. Without this the room bounces back on
   the next tap and the staff override looks broken. */
function settleMood() {
  moodReq.clear();
  lastMoodTurn = Date.now();
  broadcast('controlstate', controlState());
}

/* ---------- the beats ---------- */

function setPhase(name, guestId, holdMs) {
  phase = { name, guestId: guestId || 0, until: Date.now() + holdMs };
  broadcast('phase', phase);
  clearTimeout(setPhase._t);
  setPhase._t = setTimeout(() => {
    phase = { name: 'idle', guestId: 0, until: 0 };
    broadcast('phase', phase);
  }, holdMs);
}

/* Fair rotation, not a lottery. Everyone who stays gets their moment, and nobody
   gets picked twice while someone is still waiting for their first.

   A summon does NOT buy a place in that order. It only reorders a guest inside the
   fewest-chosen tier they were already in, so asking is worth something on a busy
   night but never passes somebody still waiting for their first turn. Someone who has
   already been chosen can hammer the button all night and still waits for the tier to
   come round. honourSummons is off for the taken beat: being dissolved is not what
   they asked for, so their place in the line survives it. */
function pickGuest(honourSummons = true) {
  const pool = eligible();
  if (!pool.length) return null;
  const fewest = Math.min(...pool.map(g => g.chosen || 0));
  const tier = pool.filter(g => (g.chosen || 0) === fewest).sort((a, b) => a.ts - b.ts);
  if (honourSummons) {
    for (const id of summonQueue()) {
      const g = tier.find(x => x.id === id);
      if (g) return g;
    }
  }
  return tier[rotation++ % tier.length];
}

function doChoose(force) {
  if (phase.name !== 'idle' && !force) return null;
  if (!force && eligible().length < cfg.minGuestsToChoose) return null;
  const g = pickGuest();
  if (!g) return null;
  g.chosen = (g.chosen || 0) + 1;
  lastChooseAt = Date.now();
  // being called IS the answer to a summon, so the queue clears here and every phone
  // watching the line sees itself move up
  if (dropSummon(g.id)) broadcast('controlstate', controlState());
  persist();
  setPhase('choosing', g.id, cfg.chooseHoldMs);
  console.log(`the mirror chose #${g.id} ${g.handle}`);
  return g;
}

function doTake(id) {
  const g = guests.get(id);
  if (!g || g.banished) return null;
  g.taken = true;
  g.takenAt = Date.now();
  persist();
  setPhase('taken', g.id, cfg.takenHoldMs);
  console.log(`the mirror took #${g.id} ${g.handle}`);
  return g;
}

/* One slow loop drives auto-choosing and the return of taken guests. Deliberately
   5s and not a tight timer: nothing here needs to be precise and a party machine
   should not be woken up more than it has to be. */
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const g of guests.values()) {
    if (g.taken && now - (g.takenAt || 0) > cfg.takenBackMs) {
      g.taken = false; g.takenAt = 0; changed = true;
      broadcast('return', pub(g));
    }
  }
  if (changed) persist();
  if (vote && vote.open) return;                       // the vote owns the room
  if (now - lastChooseAt > cfg.chooseEveryMs) doChoose(false);
}, 5000);

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };
  const json = (code, o) => send(code, 'application/json; charset=utf-8', JSON.stringify(o));
  const staff = raw => raw && raw.key === ADMIN_KEY;

  try {
    /* --- SSE feed. Phones listen too: it is how a chosen guest's phone knows. --- */
    if (u.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8',
        'Cache-Control':'no-store', 'Connection':'keep-alive' });
      res.write('retry: 1500\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    /* --- step through the mirror. This is the lead capture, and it gates entry. --- */
    if (req.method === 'POST' && u.pathname === '/api/join') {
      const raw = JSON.parse(await readBody(req, 8000));
      const handle = clean(raw.handle, 18).toUpperCase() || 'GUEST';
      const email = clean(raw.email, 120);
      if (!EMAIL.test(email)) return json(400, { error: 'bad email' });
      if (!handleOk(handle)) return json(400, { error: 'pick another name' });
      const g = { id: nextId++, handle, email, ts: Date.now(), look: null, chosen: 0 };
      guests.set(g.id, g);
      persist();
      console.log(`guest #${g.id} ${handle} stepped through`);
      pushLead(g);
      return json(200, { id: g.id, handle: g.handle, mood, phase });
    }

    /* --- the reflection they built. Only now do they appear in the hall. --- */
    if (req.method === 'POST' && u.pathname === '/api/reflect') {
      const raw = JSON.parse(await readBody(req, 8000));
      const g = guests.get(raw.u | 0);
      if (!g || g.banished) return json(403, { error: 'not in the mirror' });
      const first = !g.look;
      g.look = cleanLook(raw.look);
      persist();
      broadcast(first ? 'arrive' : 'change', pub(g));
      return json(200, { ok: true, look: g.look });
    }

    /* --- the QR layer: the room, in the guest's hand ---
           Accepted actions go out on the SSE stream as 'control' and the projection
           decides what each one looks like. A refusal never reaches the room and
           always carries a wait, so the phone counts down honestly instead of
           pretending the tap did something. --- */
    if (req.method === 'POST' && u.pathname === '/api/control') {
      const raw = JSON.parse(await readBody(req, 4000));
      const g = guests.get(raw.u | 0);
      // g.look, not just membership: the room answers the people who are standing in it
      if (!g || g.banished || !g.look) return json(403, { error: 'not in the mirror' });
      const action = String(raw.action || '');
      if (!ACTIONS.has(action)) return json(400, { error: 'no such action' });

      // a mood request while the midnight vote is open would be a second, quieter
      // ballot on the same question. The vote owns the room.
      if (action === 'mood' && vote && vote.open)
        return json(409, { error: 'the room is voting', scope: 'vote' });

      // asking again from inside the queue is not a refusal, it is a no-op. Telling
      // them their place is the honest answer and it costs them nothing.
      if (action === 'summon' && summonQueue().includes(g.id))
        return json(200, { ok: true, action, queued: true, already: true,
          position: summons.indexOf(g.id) + 1, ...meControl(g.id), state: controlState() });

      const blocked = gate(g.id, action);
      if (blocked) return json(429, { error: 'too soon', scope: blocked.scope,
        until: blocked.until, wait: Math.max(0, blocked.until - Date.now()) });

      spend(g.id, action);
      const now = Date.now();
      const out = { ok: true, action };
      let value = num(raw.value, -1, 1, 0);
      let extra = {};

      if (action === 'mood') {
        /* No vote (JoJo, 2026-08-15 night-of): whoever taps it turns it, and the
           floor fights over the room. The action gaps above are the only referee:
           one guest can retake every few seconds, the room flips at most every
           couple, so the fight has a rhythm instead of a strobe. */
        value = MOODS.includes(raw.value) ? raw.value : 'candle';
        if (mood !== value) {
          mood = value; persist(); broadcast('mood', { mood });
          out.turned = true;
          console.log(`the room turned to ${mood} by #${g.id} ${g.handle}`);
        }
        extra = { mood };
      }

      if (action === 'summon') {
        summons.push(g.id);
        value = summons.length;          // their place in line, 1 is next
        out.queued = true; out.position = value;
      }

      /* place rides along because it costs nothing and it is the whole feeling: the
         wind starts at THAT guest's candle, not at the middle of a generic room.
         placeOf is the same derivation the hall uses, so the screen already has the
         candle standing there. */
      broadcast('control', {
        action, value, from: g.id, handle: g.handle, at: now,
        place: placeOf(g.id),
        gapUntil: CONTROL.gaps[action].room ? now + CONTROL.gaps[action].room : 0,
        ...extra,
      });
      if (action === 'mood' || action === 'summon') broadcast('controlstate', controlState());
      return json(200, { ...out, ...meControl(g.id), state: controlState() });
    }

    /* --- the tally and the queue, so a phone that reconnects sees the truth --- */
    if (u.pathname === '/api/controlstate') {
      const g = guests.get((u.searchParams.get('u') | 0));
      return json(200, { ...controlState(),
        me: g && !g.banished ? meControl(g.id) : null });
    }

    /* --- the step-and-repeat drape --- */
    if (req.method === 'POST' && u.pathname === '/api/photomode') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (!staff(raw)) return json(403, { error: 'nope' });
      photoMode = !!raw.on;
      broadcast('photomode', { on: photoMode });
      console.log(`photo wall ${photoMode ? 'DOWN' : 'up'}`);
      return json(200, { on: photoMode });
    }

    /* --- backfill: the hall rebuilds itself exactly from this --- */
    if (u.pathname === '/api/state') {
      return json(200, {
        mood, phase, cfg, photoMode, control: controlState(),
        vote: vote ? { q: vote.q, a: vote.a, b: vote.b, tally: vote.tally, open: vote.open } : null,
        guests: [...guests.values()].filter(g => !g.banished && g.look).map(pub),
        counts: { total: guests.size, inHall: eligible().length },
      });
    }

    /* --- a guest's own view, so a reconnecting phone knows where it stands --- */
    if (u.pathname === '/api/me') {
      const g = guests.get((u.searchParams.get('u') | 0));
      if (!g || g.banished) return json(404, { error: 'gone' });
      return json(200, { ...pub(g), mood, phase,
        control: controlState(), me: meControl(g.id),
        vote: vote ? { q: vote.q, a: vote.a, b: vote.b, open: vote.open,
                       voted: vote.voters.includes(g.id) } : null });
    }

    /* --- beats, staff driven or forced early --- */
    if (req.method === 'POST' && u.pathname === '/api/choose') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (!staff(raw)) return json(403, { error: 'nope' });
      const g = raw.u ? guests.get(raw.u | 0) : null;
      if (g && !g.banished && g.look) {
        g.chosen = (g.chosen || 0) + 1; lastChooseAt = Date.now(); persist();
        if (dropSummon(g.id)) broadcast('controlstate', controlState());
        setPhase('choosing', g.id, cfg.chooseHoldMs);
        return json(200, { chose: pub(g) });
      }
      const picked = doChoose(true);
      return json(200, { chose: picked ? pub(picked) : null });
    }

    if (req.method === 'POST' && u.pathname === '/api/take') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (!staff(raw)) return json(403, { error: 'nope' });
      // pickGuest(false): a summon asks to be CALLED, and honouring it with the
      // dissolve instead would spend their place on a beat they did not ask for
      const g = doTake(raw.u | 0) || (() => { const p = pickGuest(false); return p ? doTake(p.id) : null; })();
      // one fewer guest in the hall moves the mood threshold, so the phones re-read it
      if (g) broadcast('controlstate', controlState());
      return json(200, { took: g ? pub(g) : null });
    }

    /* --- the midnight vote --- */
    if (req.method === 'POST' && u.pathname === '/api/vote/open') {
      const raw = JSON.parse(await readBody(req, 8000));
      if (!staff(raw)) return json(403, { error: 'nope' });
      vote = {
        q: clean(raw.q, 60).toUpperCase() || 'CANDLELIGHT OR MOONLIGHT',
        a: clean(raw.a, 14).toUpperCase() || 'CANDLELIGHT',
        b: clean(raw.b, 14).toUpperCase() || 'MOONLIGHT',
        tally: { a: 0, b: 0 }, voters: [], open: true,
      };
      broadcast('vote', { q: vote.q, a: vote.a, b: vote.b, tally: vote.tally, open: true });
      console.log(`vote opened: ${vote.q}`);
      return json(200, { ok: true });
    }

    if (req.method === 'POST' && u.pathname === '/api/vote/cast') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (!vote || !vote.open) return json(409, { error: 'closed' });
      const g = guests.get(raw.u | 0);
      if (!g || g.banished) return json(403, { error: 'not in the mirror' });
      if (vote.voters.includes(g.id)) return json(200, { ok: true, already: true });
      const side = raw.side === 'b' ? 'b' : 'a';
      vote.tally[side]++; vote.voters.push(g.id);
      broadcast('tally', vote.tally);
      return json(200, { ok: true, side });
    }

    if (req.method === 'POST' && u.pathname === '/api/vote/close') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (!staff(raw)) return json(403, { error: 'nope' });
      if (!vote) return json(409, { error: 'no vote' });
      vote.open = false;
      const win = vote.tally.b > vote.tally.a ? 'b' : 'a';
      mood = win === 'b' ? 'moon' : 'candle';
      persist();
      settleMood();   // the room just answered; standing phone requests are stale
      broadcast('vote', { q: vote.q, a: vote.a, b: vote.b, tally: vote.tally, open: false, win, mood });
      console.log(`vote closed: ${win === 'a' ? vote.a : vote.b} wins, mood ${mood}`);
      return json(200, { win, mood, tally: vote.tally });
    }

    /* --- moderation. Banishing removes the guest from the hall entirely. --- */
    if (req.method === 'POST' && u.pathname === '/api/banish') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (!staff(raw)) return json(403, { error: 'nope' });
      const g = guests.get(raw.u | 0);
      if (!g) return json(404, { error: 'no such guest' });
      g.banished = true; persist();
      moodReq.delete(g.id); dropSummon(g.id);
      broadcast('banish', { id: g.id });
      broadcast('controlstate', controlState());
      console.log(`banished #${g.id} ${g.handle}`);
      return json(200, { ok: true });
    }

    /* --- mood and timings, so the room can be tuned live --- */
    if (req.method === 'POST' && u.pathname === '/api/mood') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (!staff(raw)) return json(403, { error: 'nope' });
      mood = MOODS.includes(raw.mood) ? raw.mood : 'candle';
      persist(); broadcast('mood', { mood });
      settleMood();   // staff outrank the tally, or the next tap undoes them
      return json(200, { mood });
    }

    if (req.method === 'POST' && u.pathname === '/api/cfg') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (!staff(raw)) return json(403, { error: 'nope' });
      const c = raw.cfg || {};
      cfg = {
        chooseEveryMs: num(c.chooseEveryMs, 20000, 3600000, DEFAULTS.chooseEveryMs),
        chooseHoldMs:  num(c.chooseHoldMs,   4000,   60000, DEFAULTS.chooseHoldMs),
        takenHoldMs:   num(c.takenHoldMs,    3000,   60000, DEFAULTS.takenHoldMs),
        takenBackMs:   num(c.takenBackMs,   10000,  900000, DEFAULTS.takenBackMs),
        minGuestsToChoose: num(c.minGuestsToChoose, 1, 50, DEFAULTS.minGuestsToChoose),
      };
      persist(); broadcast('cfg', cfg);
      return json(200, cfg);
    }

    /* --- ask the screen to render everyone's portrait to captures/ --- */
    if (req.method === 'POST' && u.pathname === '/api/portraits') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (!staff(raw)) return json(403, { error: 'nope' });
      broadcast('portraits', {});
      return json(200, { queued: eligible().length });
    }

    if (req.method === 'POST' && u.pathname === '/api/wipe') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (!staff(raw)) return json(403, { error: 'nope' });
      guests = new Map(); nextId = 1; vote = null; mood = 'candle';
      phase = { name: 'idle', guestId: 0, until: 0 };
      // the control layer is keyed by guest id, and ids restart at 1 after a wipe
      spent.clear(); selfAt.clear(); moodReq.clear();
      summons = []; roomSpent = []; lastMoodTurn = 0;
      persist(); broadcast('rebuild', {});
      return json(200, { ok: true });
    }

    if (u.pathname === '/api/leads.csv') {
      if (u.searchParams.get('key') !== ADMIN_KEY) return send(403, 'text/plain', 'nope');
      const q = s => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
      const rows = [['id','handle','email','joined','chosen','built_reflection','banished'].join(',')];
      for (const g of guests.values())
        rows.push([g.id, q(g.handle), q(g.email), new Date(g.ts).toISOString(),
          g.chosen || 0, g.look ? 'yes' : 'no', g.banished ? 'yes' : ''].join(','));
      return send(200, 'text/csv; charset=utf-8', rows.join('\n'),
        { 'Content-Disposition': 'attachment; filename="midnight-mirror-leads.csv"' });
    }

    if (u.pathname === '/api/wifi') return json(200, { urls: lanUrls(PORT), port: PORT });

    /* --- frame sink: a hidden browser pane stops compositing, so screenshots time
           out and animation never advances. The page renders itself and POSTs a
           data URL here. This is also how the portrait export lands on disk. --- */
    if (req.method === 'POST' && u.pathname === '/__save') {
      const body = await readBody(req, 40_000_000);
      const name = basename(u.searchParams.get('name') || 'frame').replace(/[^\w.-]/g, '') || 'frame';
      await mkdir(join(ROOT, 'captures'), { recursive: true });
      await writeFile(join(ROOT, 'captures', name.endsWith('.png') ? name : name + '.png'),
        Buffer.from(body.slice(body.indexOf(',') + 1), 'base64'));
      return send(200, 'text/plain', 'saved ' + name);
    }

    /* --- static --- */
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    if (p === '/mirror') p = '/index.html';      // the room IS the root now
    if (p === '/phone') p = '/phone.html';
    if (p === '/admin') p = '/admin.html';
    const target = join(ROOT, normalize(p).replace(/^([/\\])+/, ''));
    if (!target.startsWith(ROOT)) return send(403, 'text/plain', 'forbidden');
    const s = await stat(target);
    const file = s.isDirectory() ? join(target, 'index.html') : target;
    return send(200, MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      await readFile(file));
  } catch {
    if (!res.headersSent) send(404, 'text/plain', 'not found');
  }
}).listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls(PORT);
  console.log('\n  MIDNIGHT MIRROR is up');
  console.log('  ---------------------------------------------');
  console.log(`  MIRROR (on the screen)   http://localhost:${PORT}/mirror`);
  console.log(`  ADMIN  (staff phone)     http://localhost:${PORT}/admin`);
  console.log('\n  PHONES on the same wifi, put this on the QR cards:');
  urls.length ? urls.forEach(x => console.log(`     ${x}`))
              : console.log('     (no LAN address, connect this machine to wifi)');
  console.log(`\n  staff key: ${ADMIN_KEY}`);
  console.log('  no camera, no internet needed');
  console.log('  ---------------------------------------------');
});
