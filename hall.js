/* MIDNIGHT MIRROR: the room, v3. THE MANOR GREAT HALL.
 *
 * Rebuilt 2026-08-13 against JoJo's reference screenshot (a two-storey manor hall:
 * balconied gallery on both sides, coffered wood ceiling, rows of stone-traceried
 * windows, portraits in gilt frames, patterned rugs, a grand door at the far end).
 * His ruling reversed the oblique-camera experiment: the room is STRAIGHT and
 * SYMMETRIC, and the richness has to come from detail density, not from breaking the
 * axis. Kept from the deck: midnight purple air, lilac moon glass, candle amber.
 *
 * The amateur tells he named are dead here:
 *  - candelabra are ALWAYS fully lit furniture; guests' candles fill identical votive
 *    rows (window sills, balcony rails, the door steps), so nothing is ever a stand
 *    with one odd candle in the middle
 *  - no spinning sigil, no vignette frame, no mirror-clone floor
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from './vendor-three/addons/geometries/RoundedBoxGeometry.js';

export const DIMS = {
  W: 13,          // half width
  CEIL: 15.2,     // coffered ceiling height
  BAYS: 4,
  BAY: 11,
  Z0: 10,         // first bay front edge
  FAR_Z: -40,     // the far wall with the grand door
  BALCONY_Y: 7.6,
};

const TAU = Math.PI * 2;

export function buildHall(MAT, C) {
  const hall = new THREE.Group();
  const { W, CEIL, BAYS, BAY, Z0, FAR_Z, BALCONY_Y } = DIMS;
  const candleSlots = [];     // guests' candles: sills, rails, steps. Identical votives.
  const ambient = [];         // always-lit: candelabra flames (chandeliers live in the page)
  const beams = [];
  const wallFrames = [];
  /* Declared UP HERE with the other collections, not beside the code that fills it.
     standLights shipped a TDZ crash for exactly this reason: buildHall runs top to
     bottom, so anything pushed to from the bay loop must exist before the bay loop. */
  const sponsorBoards = [];   // the logo panels, dressed with a real carved frame later

  /* contact shadows: the cheap grounding decal every archviz web scene uses. A soft
     radial darkening under every object that touches the floor, so nothing hovers. */
  const contactTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g2 = c.getContext('2d');
    const rg = g2.createRadialGradient(64, 64, 8, 64, 64, 62);
    rg.addColorStop(0, 'rgba(0,0,0,0.55)');
    rg.addColorStop(0.7, 'rgba(0,0,0,0.22)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g2.fillStyle = rg; g2.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  let csn = 0;
  function contact(x, z, r, o = 1) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2),
      new THREE.MeshBasicMaterial({ map: contactTex, transparent: true, opacity: o, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.031 + (csn++ % 7) * 0.0015, z);
    hall.add(m);
  }
  const standLights = [];   // where the page hangs real candle-cluster lights


  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    hall.add(m);
    return m;
  };
  const box = (w, h, d, mat, x, y, z, ry = 0) =>
    add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, 0, ry, 0);

  const frontZ = Z0 + 4;

  /* ---------- shell ---------- */
  for (const side of [-1, 1]) {
    box(0.7, CEIL + 1, frontZ - FAR_Z + 4, MAT.wall, side * (W + 0.35), (CEIL + 1) / 2, (frontZ + FAR_Z) / 2);
    // dark wood wainscot, ground floor
    box(0.28, 1.6, frontZ - FAR_Z, MAT.woodDark, side * (W - 0.1), 0.8, (frontZ + FAR_Z) / 2);
    box(0.34, 0.14, frontZ - FAR_Z, MAT.gold, side * (W - 0.12), 1.62, (frontZ + FAR_Z) / 2);
  }
  box(2 * W + 1.4, 0.7, frontZ - FAR_Z + 4, MAT.wall, 0, CEIL + 0.6, (frontZ + FAR_Z) / 2);

  /* ---------- coffered ceiling ----------
     A grid of dark wood beams with recessed panels: the reference's single biggest
     "this is a real building" cue, and it replaces the vault entirely. */
  const beamY = CEIL - 0.18;
  for (let x = -3; x <= 3; x++)
    box(0.42, 0.36, frontZ - FAR_Z, MAT.woodDark, x * (W / 3.4), beamY, (frontZ + FAR_Z) / 2);
  for (let z = frontZ; z > FAR_Z; z -= BAY / 2)
    box(2 * W, 0.42, 0.38, MAT.woodDark, 0, beamY, z);
  box(2 * W + 0.8, 0.32, 0.5, MAT.gold, 0, beamY - 0.02, frontZ + 0.2);   // gilt edge at the front

  /* ---------- the two-storey side walls ---------- */
  const bayZ = i => Z0 - i * BAY - BAY / 2;

  /* a stone-traceried window: lilac glass behind silver-grey mullions in a stone
     surround. `w,h` glass size; tall ground lights and smaller gallery pairs. */
  function stoneWindow(x, y, z, w, h, ry) {
    const g = new THREE.Group();
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), MAT.moonGlow);
    g.add(pane);
    const archTop = new THREE.Mesh(new THREE.CircleGeometry(w / 2, 20, 0, Math.PI), MAT.moonGlow);
    archTop.position.y = h / 2; g.add(archTop);
    const bar = (bw, bh, bx, by) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.14), MAT.stoneLight);
      m.position.set(bx, by, 0.06); g.add(m);
    };
    bar(0.12, h, 0, 0);
    if (w > 2.2) { bar(0.10, h, -w / 4, 0); bar(0.10, h, w / 4, 0); }
    bar(w, 0.12, 0, h * 0.16);
    bar(w, 0.10, 0, -h * 0.24);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(w / 2, 0.09, 8, 22, Math.PI), MAT.stoneLight);
    ring.position.set(0, h / 2, 0.06); g.add(ring);
    /* THE SURROUND WRAPS THE WHOLE OPENING. It used to stop at the springing line, so
       the arched top of every window sat in bare wall with no frame around it, which
       is what read as unfinished. The jambs now run the full glass height plus the
       arch rise, and an arched head follows the curve. */
    const sur = (bw, bh, bx, by, d = 0.4) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, d), MAT.stoneLight);
      m.position.set(bx, by, -0.05); g.add(m);
    };
    const jambH = h + w / 2 + 1.3;
    sur(0.42, jambH, -(w / 2 + 0.21), (w / 2 - 0.5) / 2);
    sur(0.42, jambH, w / 2 + 0.21, (w / 2 - 0.5) / 2);
    sur(w + 0.84, 0.46, 0, -(h / 2 + 0.23));
    const head = new THREE.Mesh(
      new THREE.TorusGeometry(w / 2 + 0.21, 0.21, 8, 24, Math.PI), MAT.stoneLight);
    head.position.set(0, h / 2, -0.05);
    g.add(head);
    /* The sill belongs to the WINDOW, not the world. It was a separate 0.8-deep slab
       pinned at a fixed height, which is exactly the "random white rectangle poking
       out" - it did not line up with the glass it was supposed to serve. */
    sur(w + 1.1, 0.2, 0, -(h / 2 + 0.5), 0.62);
    g.position.set(x, y, z);
    g.rotation.y = ry;
    hall.add(g);
    return g;
  }

  /* a portrait: gilt frame around an aged, nearly-black canvas. The FRAME does the
     talking; the canvas is a dark vignette so it never reads as bad drawn art. */
  function portrait(x, y, z, w, h, ry, tex) {
    const g = new THREE.Group();
    const t = 0.16;
    const rail = (bw, bh, bx, by) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.16), MAT.gold);
      m.position.set(bx, by, 0.02); g.add(m);
    };
    rail(w + t, t, 0, h / 2); rail(w + t, t, 0, -h / 2);
    rail(t, h, -w / 2, 0); rail(t, h, w / 2, 0);
    const canvas = new THREE.Mesh(new THREE.PlaneGeometry(w - t, h - t),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    g.add(canvas);
    g.position.set(x, y, z);
    g.rotation.y = ry;
    hall.add(g);
    return g;
  }

  for (const side of [-1, 1]) {
    const ry = -side * Math.PI / 2;
    const wx = side * (W - 0.18);

    for (let i = 0; i < BAYS; i++) {
      const z = bayZ(i);

      // ground floor: one tall traceried light per bay
      stoneWindow(wx, 4.1, z, 3.0, 4.6, ry);
      // guests' votives stand on the window's own ledge, built inside stoneWindow
      for (let k = -2; k <= 2; k++)
        candleSlots.push(new THREE.Vector3(side * (W - 0.62), 1.95, z + k * 0.68));

      // gallery: a pair of smaller lights per bay, portraits between bays
      stoneWindow(wx, 11.2, z - 1.7, 1.5, 3.2, ry);
      stoneWindow(wx, 11.2, z + 1.7, 1.5, 3.2, ry);
      if (i < BAYS - 1) portrait(wx, 11.0 + (side > 0 ? -0.22 : 0.14), z - BAY / 2, 2.0, 2.8, ry, MAT.portraitTex[(i + (side > 0 ? 0 : 1)) % MAT.portraitTex.length]);

      // velvet drapes flanking the gallery pairs, hung slightly loose
      for (const dz of [-3.1, 3.1]) {
        const cur = new THREE.Mesh(new THREE.BoxGeometry(0.16, 5.0, 0.78), MAT.velvet);
        cur.position.set(side * (W - 0.45), 11.0, z + dz);
        cur.rotation.x = 0.03;
        hall.add(cur);
      }

      /* THE SHAFT IS BACK, done properly (JoJo: "how come there's just a spotlight on
         the ground but we don't see the light rays come through the windows?" - a pool
         with no beam above it is illogical, he is right).
         The earlier cones failed because their opacity was FLAT, so they read as solid
         geometry standing on the floor. This one carries a vertical alpha gradient:
         strongest in the window mouth, gone before it lands, so it reads as air
         catching light rather than a shape. */
      if (i === 1 || i === 3) {
        const topY = 6.4, footY = 0.1;
        const topX = side * (W - 1.0), footX = side * (W - 4.4);
        const len = Math.hypot(topX - footX, topY - footY);
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(1.05, 2.0, len, 24, 1, true),
          new THREE.MeshBasicMaterial({
            color: C.moon, map: MAT.shaftFade, transparent: true, opacity: 0.16,
            blending: THREE.AdditiveBlending, depthWrite: false,
            side: THREE.DoubleSide, fog: false }));
        shaft.position.set((topX + footX) / 2, (topY + footY) / 2, z);
        shaft.rotation.z = -side * Math.atan2(Math.abs(topX - footX), topY - footY);
        shaft.userData.k = 1;
        shaft.renderOrder = 10;
        hall.add(shaft);
        beams.push(shaft);
      }

      /* and the light it lands in: a soft pool of lilac across the boards, angled away
         from the wall the way light through glass actually falls */
      const pool = new THREE.Mesh(
        new THREE.CircleGeometry(1, 28),
        new THREE.MeshBasicMaterial({ color: C.moon, transparent: true, opacity: 0.05,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      pool.rotation.x = -Math.PI / 2;
      pool.rotation.z = -side * 0.18;          // skewed off the wall, not a perfect stamp
      pool.scale.set(2.3, 1.5, 1);
      pool.position.set(side * (W - 3.1), 0.045, z + 0.4);
      pool.userData.k = 2.4;
      hall.add(pool);
      beams.push(pool);
      // the gallery windows above land their own longer throw, further into the room
      if (i === 1 || i === 3) {
        const pool2 = new THREE.Mesh(
          new THREE.CircleGeometry(1, 28),
          new THREE.MeshBasicMaterial({ color: C.moon, transparent: true, opacity: 0.045,
            blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
        pool2.rotation.x = -Math.PI / 2;
        pool2.rotation.z = side * 0.14;
        pool2.scale.set(3.1, 1.8, 1);
        pool2.position.set(side * (W - 7.2), 0.045, z - 0.6);
        pool2.userData.k = 2.0;
        hall.add(pool2);
        beams.push(pool2);
      }
    }

    /* the balcony gallery: slab, slender posts, balustrade. BOTH sides: the reference
       is symmetric and that symmetry is the formality JoJo asked back in. */
    const len = frontZ - FAR_Z - 2;
    const cz = (frontZ + FAR_Z) / 2;
    box(2.5, 0.4, len, MAT.woodDark, side * (W - 1.25), BALCONY_Y, cz);
    box(0.16, 0.12, len, MAT.gold, side * (W - 2.4), BALCONY_Y + 1.18, cz);   // gilt cap
    box(0.2, 0.24, len, MAT.woodDark, side * (W - 2.4), BALCONY_Y + 1.06, cz);
    box(0.18, 0.2, len, MAT.woodDark, side * (W - 2.4), BALCONY_Y + 0.24, cz);
    for (let z = frontZ - 1.6; z > FAR_Z + 1.6; z -= 1.05) {
      add(new THREE.CylinderGeometry(0.055, 0.075, 0.85, 8), MAT.woodDark,
        side * (W - 2.4), BALCONY_Y + 0.64, z);
    }
    // slender posts carrying the slab
    for (let i = 0; i <= BAYS; i++) {
      const z = Z0 - i * BAY;
      box(0.32, BALCONY_Y, 0.32, MAT.woodDark, side * (W - 2.35), BALCONY_Y / 2, z);
      box(0.5, 0.28, 0.5, MAT.gold, side * (W - 2.35), BALCONY_Y - 0.2, z);
    }
    // guests' candles line the balcony rail
    for (let z = frontZ - 2.6; z > FAR_Z + 2.6; z -= 2.1)
      candleSlots.push(new THREE.Vector3(side * (W - 2.05), BALCONY_Y + 0.62, z));
  }

  /* ---------- the far wall: stone frontispiece, grand door, window stack ---------- */
  {
    const z = FAR_Z;
    box(2 * W + 0.8, CEIL + 1, 0.7, MAT.wall, 0, (CEIL + 1) / 2, z - 0.4);
    // the frontispiece: a lighter stone mass the whole composition hangs on
    box(9.6, CEIL + 0.6, 0.9, MAT.stoneLight, 0, (CEIL + 0.6) / 2, z + 0.1);
    box(10.4, 0.5, 1.1, MAT.stoneLight, 0, CEIL - 0.6, z + 0.15);

    // THE DOOR. Arched, dark oak, iron straps: the room's scale referent and its exit.
    const doorW = 4.6, doorH = 5.6;
    box(doorW, doorH, 0.3, MAT.door, 0, doorH / 2 + 0.9, z + 0.62);
    const archTop = new THREE.Mesh(new THREE.CircleGeometry(doorW / 2, 24, 0, Math.PI), MAT.door);
    archTop.position.set(0, doorH + 0.9, z + 0.62);
    hall.add(archTop);
    box(0.14, doorH + doorW / 2 - 0.4, 0.32, MAT.iron, 0, (doorH + 1.6) / 2 + 0.4, z + 0.66); // centre seam
    for (const dy of [2.2, 4.2])
      for (const sx of [-1, 1])
        box(1.7, 0.16, 0.34, MAT.iron, sx * 1.15, dy, z + 0.66);          // strap hinges
    for (const sx of [-1, 1])
      add(new THREE.TorusGeometry(0.22, 0.05, 8, 18), MAT.iron, sx * 0.6, 3.1, z + 0.72);
    // stone arch order around the door
    const doorRing = new THREE.Mesh(new THREE.TorusGeometry(doorW / 2 + 0.3, 0.22, 10, 30, Math.PI), MAT.stoneLight);
    doorRing.position.set(0, doorH + 0.9, z + 0.5);
    hall.add(doorRing);
    for (const sx of [-1, 1])
      box(0.5, doorH + 0.9, 0.6, MAT.stoneLight, sx * (doorW / 2 + 0.32), (doorH + 0.9) / 2, z + 0.5);

    // three wide steps up to it: known-height treads the eye can count
    for (let i = 0; i < 3; i++)
      box(10 - i * 1.7, 0.3, 1.5 - i * 0.25, MAT.stoneLight, 0, 0.15 + i * 0.3, z + 3.4 - i * 0.9);
    // guests' candles on the outer step ends
    for (const sx of [-1, 1])
      for (let k = 0; k < 4; k++)
        candleSlots.push(new THREE.Vector3(sx * (3.6 + k * 0.7), 0.44 + (k % 2) * 0.3, z + 3.2 - (k % 2) * 0.9));

    /* The window stack sits CLEAR of the door arch (JoJo: "the door frame is going
       into the window above"): lancets raised, a stone string course drawn between
       the two storeys so the separation reads as architecture, and the quatrefoil
       cut - it was crowding the cornice. */
    box(9.8, 0.5, 1.0, MAT.stoneLight, 0, 9.35, z + 0.2);       // the string course
    stoneWindow(0, 11.5, z + 0.62, 1.6, 3.4, 0);
    stoneWindow(-2.35, 11.15, z + 0.62, 1.3, 2.7, 0);
    stoneWindow(2.35, 11.15, z + 0.62, 1.3, 2.7, 0);

    // flanking the frontispiece: ground portraits over the wainscot
    /* THE SPONSOR BOARDS. Nearly double size and carrying the real marks: these are
       the logo positions, and at 2.4x3.4 they read as dark nothing beside the door. */
    sponsorBoards.push({ group: portrait(-8.4, 6.8, z + 0.5, 4.3, 5.8, 0, MAT.logoTex[0]),
                         x: -8.4, y: 6.8, z: z + 0.5, w: 4.3, h: 5.8 });
    sponsorBoards.push({ group: portrait(8.4, 6.8, z + 0.5, 4.3, 5.8, 0, MAT.logoTex[1]),
                         x: 8.4, y: 6.8, z: z + 0.5, w: 4.3, h: 5.8 });
  }

  /* THE HERALD. The gilt frame over the door where the chosen guest's name appears.
     No camera move goes with it any more: it is a lighting event in a steady room. */
  const herald = (() => {
    const g = new THREE.Group();
    const w = 9.0, h = 4.6, t = 0.24;
    const rail = (bw, bh, bx, by) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.3), MAT.gold);
      m.position.set(bx, by, 0); g.add(m);
    };
    rail(w, t, 0, h / 2); rail(w, t, 0, -h / 2);
    rail(t, h, -w / 2, 0); rail(t, h, w / 2, 0);
    const crest = new THREE.Mesh(new THREE.TorusGeometry(w * 0.13, 0.14, 8, 20, Math.PI), MAT.gold);
    crest.position.set(0, h / 2 + 0.16, 0); g.add(crest);
    const inset = new THREE.Mesh(
      new THREE.PlaneGeometry(w - t, h - t),
      new THREE.MeshPhysicalMaterial({
        color: 0x5A6070, roughness: 0.18, metalness: 0.95,
        emissive: new THREE.Color(C.amber), emissiveIntensity: 0,
        side: THREE.DoubleSide,
      }));
    inset.position.z = 0.02;
    g.add(inset);
    g.name = 'herald';   // named so __screen() can measure what the chandelier must clear
    g.position.set(0, 9.2, FAR_Z + 1.35);
    hall.add(g);
    return { group: g, inset, plate: null };
  })();

  /* ---------- floor candelabra: FURNITURE, always fully lit ----------
     Two pairs flanking the rug. Every arm carries a flame from the moment the page
     loads; guests never touch these, so no stand is ever half-dressed. */
  /* staggered per side (the tell-hunt panel: twin candelabra at matching depths is
     the loudest mirrored-instancing signature in the frame) */
  for (const side of [-1, 1]) {
    for (const z of (side < 0 ? [Z0 - 3, Z0 - 26] : [Z0 - 6.5, Z0 - 22])) {
      const x = side * (side < 0 ? 7.6 : 7.9);
      add(new THREE.CylinderGeometry(0.8, 1.05, 0.28, 12), MAT.gold, x, 0.14, z);
      add(new THREE.CylinderGeometry(0.14, 0.2, 4.2, 10), MAT.gold, x, 2.2, z);
      add(new THREE.SphereGeometry(0.3, 14, 10), MAT.gold, x, 3.05, z);
      const arms = 5;
      for (let k = 0; k < arms; k++) {
        const a = (k / arms) * TAU + (side > 0 ? 0.4 : 0);
        const ax = x + Math.cos(a) * 0.9, az = z + Math.sin(a) * 0.9;
        const arm = add(new THREE.TorusGeometry(0.46, 0.065, 6, 14, Math.PI * 0.8), MAT.gold,
          (x + ax) / 2, 4.3, (z + az) / 2);
        arm.rotation.set(Math.PI / 2, 0, a);
        add(new THREE.CylinderGeometry(0.06, 0.07, 0.5, 8), MAT.wax, ax, 4.6, az);
        ambient.push(new THREE.Vector3(ax, 4.95, az));
      }
      add(new THREE.CylinderGeometry(0.065, 0.075, 0.55, 8), MAT.wax, x, 4.95, z);
      ambient.push(new THREE.Vector3(x, 5.3, z));
      standLights.push(new THREE.Vector3(x, 5.1, z));
      contact(x, z, 1.15, 0.9);
    }
  }

  /* ---------- FURNITURE ----------
     The settee is gone (JoJo: "what is that thing in the middle? a fountain?").
     A great hall is furnished like a hall: two long banquet tables flanking the rug
     with candlesticks and pewter on them, benches, chairs against the walls between
     the windows, banners off the balcony fronts, urns flanking the door steps and
     console tables under the far portraits. The centre aisle stays clear: it is the
     photo lane. RoundedBox on everything the eye lands on, because a razor edge
     catches no highlight and reads as CG. */
  const rbox = (w, h, d, r, mat, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 1, r), mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    hall.add(m);
    return m;
  };
  const velvetOx = MAT.velvet.clone();
  velvetOx.color = new THREE.Color(0x4A0E18);

  /* SOFAS, not banquet tables (JoJo: 'why those wood table and benches? why not
     those sofas?'). This is an afterparty lounge, not a dining hall: chesterfields
     and low tables, and the two sides are dressed DIFFERENTLY on purpose. The
     architecture stays formal and symmetric; the furnishing is loose, the way a
     lived-in room actually sits. */
  const sofaStandins = [];
  function sofa(x, z, ry, mat, len = 2.7) {
    const g = new THREE.Group();
    sofaStandins.push({ group: g, x, z, ry, len });
    const mk = (geo, px, py, pz, rx = 0) => {
      const o = new THREE.Mesh(geo, mat);
      o.position.set(px, py, pz);
      o.rotation.x = rx;
      g.add(o);
      return o;
    };
    mk(new RoundedBoxGeometry(len, 0.62, 1.32, 1, 0.06), 0, 0.62, 0);
    const cw = (len - 0.5) / 2;
    mk(new RoundedBoxGeometry(cw, 0.3, 1.16, 1, 0.08), -cw / 2 - 0.02, 1.02, 0.04);
    mk(new RoundedBoxGeometry(cw, 0.3, 1.16, 1, 0.08), cw / 2 + 0.02, 1.02, 0.04);
    mk(new RoundedBoxGeometry(len, 1.15, 0.34, 1, 0.07), 0, 1.42, -0.56);
    for (const bx of [-len / 3.2, 0, len / 3.2])
      mk(new RoundedBoxGeometry(len / 3.6, 0.7, 0.24, 1, 0.09), bx, 1.72, -0.46);
    for (const sx of [-1, 1]) {
      const arm = mk(new THREE.CylinderGeometry(0.21, 0.21, 1.3, 14), sx * (len / 2 - 0.08), 1.28, 0, Math.PI / 2);
      mk(new RoundedBoxGeometry(0.38, 0.62, 1.3, 1, 0.05), sx * (len / 2 - 0.08), 0.9, 0);
      const gm = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), MAT.gold);
      gm.position.set(sx * (len / 2 - 0.12), 0.14, 0.4); g.add(gm);
      const gm2 = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), MAT.gold);
      gm2.position.set(sx * (len / 2 - 0.12), 0.14, -0.4); g.add(gm2);
    }
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    hall.add(g);
    contact(x, z, len / 2 + 0.45, 0.85);
    return g;
  }
  function lowTable(x, z) {
    add(new THREE.CylinderGeometry(0.56, 0.56, 0.07, 22), MAT.woodDark, x, 0.62, z);
    add(new THREE.TorusGeometry(0.56, 0.025, 8, 26), MAT.gold, x, 0.66, z, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.09, 0.13, 0.55, 10), MAT.woodDark, x, 0.31, z);
    add(new THREE.CylinderGeometry(0.32, 0.38, 0.06, 16), MAT.woodDark, x, 0.03, z);
    add(new THREE.CylinderGeometry(0.05, 0.1, 0.4, 10), MAT.gold, x, 0.87, z);
    add(new THREE.CylinderGeometry(0.05, 0.06, 0.26, 8), MAT.wax, x, 1.15, z);
    ambient.push(new THREE.Vector3(x, 1.45, z));
    standLights.push(new THREE.Vector3(x, 1.6, z));
    contact(x, z, 0.85, 0.9);
  }
  // LEFT: one long chesterfield facing the aisle, a shorter one further down, angled
  /* The primitive sofas stay ONLY as a fallback silhouette while the real models
     stream in; the page hides them the moment place() resolves. Keeping them means a
     projector that loses the model folder still shows a furnished room rather than an
     empty one, which at a live event is the difference between a look and a failure. */
  sofa(-5.9, -3.6, Math.PI / 2 + 0.08, MAT.velvet, 6.0);
  sofa(-6.0, -14.6, Math.PI / 2 - 0.30, velvetOx, 5.2);
  lowTable(-3.6, -8.4);
  // RIGHT: two sofas angled toward each other around a table, a conversation corner
  sofa(5.9, -5.2, -Math.PI / 2 + 0.26, velvetOx, 5.4);
  sofa(6.0, -12.6, -Math.PI / 2 - 0.30, MAT.velvet, 5.4);
  lowTable(3.7, -8.1);

  // high-back chairs against the walls, between the ground windows
  for (const side of [-1, 1])
    for (const cz of (side < 0 ? [Z0 - BAY, Z0 - 2 * BAY - 0.6, Z0 - 3 * BAY + 0.4]
                                 : [Z0 - BAY + 0.5, Z0 - 2 * BAY, Z0 - 3 * BAY - 0.5])) {
      const cx = side * (W - 1.35);
      contact(cx, cz, 0.8, 0.8);
      rbox(0.85, 0.1, 0.8, 0.02, MAT.woodDark, cx, 0.86, cz);            // seat
      rbox(0.85, 1.7, 0.1, 0.02, MAT.woodDark, cx + side * 0.36, 1.6, cz, 0);
      const pad = new THREE.Mesh(new RoundedBoxGeometry(0.62, 1.2, 0.05, 1, 0.02), velvetOx);
      pad.position.set(cx + side * 0.3, 1.62, cz);
      hall.add(pad);
      for (const lx of [-1, 1]) for (const lz of [-1, 1])
        add(new THREE.CylinderGeometry(0.05, 0.06, 0.82, 8), MAT.woodDark,
          cx + lx * 0.34, 0.4, cz + lz * 0.3);
      add(new THREE.SphereGeometry(0.06, 8, 8), MAT.gold, cx + side * 0.36, 2.5, cz - 0.38);
      add(new THREE.SphereGeometry(0.06, 8, 8), MAT.gold, cx + side * 0.36, 2.5, cz + 0.38);
    }

  // banners off the balcony fronts, alternating plum and oxblood, gold-fringed
  for (const side of [-1, 1])
    [Z0 - 5, Z0 - 16, Z0 - 27, Z0 - 38].forEach((bz2, k) => {
      /* hung from the balcony FRONT, entirely below the slab: at BALCONY_Y-1.15 with
         a 2.5 drop the top edge speared straight through the deck (JoJo catch) */
      const bm = new THREE.Mesh(new RoundedBoxGeometry(1.15, 2.3, 0.06, 1, 0.02),
        k % 2 ? velvetOx : MAT.velvet);
      bm.position.set(side * (W - 2.74), BALCONY_Y - 1.5, bz2);
      hall.add(bm);
      rbox(1.15, 0.08, 0.1, 0.02, MAT.gold, side * (W - 2.74), BALCONY_Y - 2.68, bz2);
      rbox(1.28, 0.07, 0.13, 0.02, MAT.gold, side * (W - 2.74), BALCONY_Y - 0.32, bz2);
    });

  // urns on pedestals flanking the door steps, and consoles under the far portraits
  for (const side of [-1, 1]) {
    const ux = side * 5.9, uz = FAR_Z + 4.9;
    contact(ux, uz, 0.75, 0.85);
    rbox(0.78, 1.15, 0.78, 0.02, MAT.stoneLight, ux, 0.58, uz);
    add(new THREE.SphereGeometry(0.42, 18, 14), MAT.gold, ux, 1.62, uz).scale.set(1, 1.15, 1);
    add(new THREE.CylinderGeometry(0.16, 0.3, 0.3, 12), MAT.gold, ux, 2.12, uz);
    add(new THREE.CylinderGeometry(0.3, 0.2, 0.16, 12), MAT.gold, ux, 1.06, uz);

    contact(side * 8.2, FAR_Z + 1.3, 1.0, 0.7);
    rbox(1.9, 0.1, 0.55, 0.02, MAT.woodDark, side * 8.2, 1.12, FAR_Z + 1.3);
    for (const lx of [-1, 1])
      add(new THREE.CylinderGeometry(0.06, 0.08, 1.06, 8), MAT.woodDark,
        side * 8.2 + lx * 0.8, 0.56, FAR_Z + 1.3);
    add(new THREE.CylinderGeometry(0.05, 0.1, 0.44, 10), MAT.gold, side * 8.2, 1.42, FAR_Z + 1.3);
    add(new THREE.CylinderGeometry(0.05, 0.06, 0.26, 8), MAT.wax, side * 8.2, 1.72, FAR_Z + 1.3);
    ambient.push(new THREE.Vector3(side * 8.2, 2.02, FAR_Z + 1.3));
  }

  // panel moulding on the flat wall between the ground windows, behind the chairs
  for (const side of [-1, 1])
    for (const cz of [Z0 - BAY, Z0 - 2 * BAY, Z0 - 3 * BAY]) {
      const px2 = side * (W - 0.14);
      box(0.06, 2.2, 0.08, MAT.gold, px2, 3.4, cz - 0.85);
      box(0.06, 2.2, 0.08, MAT.gold, px2, 3.4, cz + 0.85);
      box(0.06, 0.08, 1.78, MAT.gold, px2, 4.5, cz);
      box(0.06, 0.08, 1.78, MAT.gold, px2, 2.3, cz);
    }

  /* seeded shuffle: guests spread across sills, rails and steps evenly, and a reload
     maps the same guests to the same candles */
  let sSeed = 424241;
  const sRand = () => (sSeed = (sSeed * 48271) % 2147483647) / 2147483647;
  for (let i = candleSlots.length - 1; i > 0; i--) {
    const j = (sRand() * (i + 1)) | 0;
    [candleSlots[i], candleSlots[j]] = [candleSlots[j], candleSlots[i]];
  }

  return { hall, wallFrames, candleSlots, herald, beams, ambient, standLights, sofaStandins, sponsorBoards };
}
