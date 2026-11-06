// p5.js map: lines, stations and timetable-driven trains, synced to the music clock.
// Data comes from js/gtfs.js (App.feed); the clock comes from js/music.js (Music.simNow()).
// The previous random-dot version of this sketch is in git history.

let view = { s: 1, ox: 0, oy: 0 };   // screen = s * world + o
let world = null;                    // projected geometry of the current feed
let layer = null, layerView = null, layerDirty = true, lastInteract = 0;
let dragging = false, lastX = 0, lastY = 0;
let lastFeed = null;

function mapContainer() { return document.getElementById('map'); }

function setup() {
  const box = mapContainer();
  const c = createCanvas(box.clientWidth, box.clientHeight);
  c.parent(box);
  pixelDensity(Math.min(2, window.devicePixelRatio || 1));
  textFont('system-ui');
}

function windowResized() {
  const box = mapContainer();
  resizeCanvas(box.clientWidth, box.clientHeight);
  if (world) fitView();
  layerDirty = true;
}

// ---------- projection ----------
function buildWorld(feed, boundary) {
  const b = feed.bbox;
  const lat0 = (b.latMin + b.latMax) / 2, lon0 = (b.lonMin + b.lonMax) / 2;
  const kx = Math.cos(lat0 * Math.PI / 180) * 1000, ky = 1000;
  const P = (lat, lon) => [(lon - lon0) * kx, -(lat - lat0) * ky];
  const st = feed.stations;
  const sx = new Float32Array(st.lat.length), sy = new Float32Array(st.lat.length);
  for (let i = 0; i < sx.length; i++) { const p = P(st.lat[i], st.lon[i]); sx[i] = p[0]; sy[i] = p[1]; }
  const lines = feed.polylines.map(pls => pls.map(pl => pl.map(([la, lo]) => P(la, lo))));
  const rings = [];
  if (boundary && boundary.features) {
    for (const f of boundary.features) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) for (const ring of poly) rings.push(ring.map(([lo, la]) => P(la, lo)));
    }
  }
  // track shapes as flat arrays + cumulative length, for moving trains along the rails
  const shapes = (feed.shapes || []).map(s => {
    const n = s.pts.length;
    const x = new Float32Array(n), y = new Float32Array(n), cum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const q = P(s.pts[i][0], s.pts[i][1]);
      x[i] = q[0]; y[i] = q[1];
      if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    }
    return { line: s.line, x, y, cum };
  });
  const tl = P(b.latMax, b.lonMin), br = P(b.latMin, b.lonMax);
  return { sx, sy, lines, rings, shapes, geom: new WeakMap(), geomByKey: new Map(), minX: tl[0], minY: tl[1], maxX: br[0], maxY: br[1] };
}

// ---------- trains on the tracks ----------
// For each trip pattern, find where each of its stations sits along a track shape
// (in order). Trains then move along the shape between stations instead of in a straight line.
function reversedShape(S) {
  if (S.rev) return S.rev;
  const n = S.x.length;
  const x = new Float32Array(n), y = new Float32Array(n), cum = new Float32Array(n);
  for (let i = 0; i < n; i++) { x[i] = S.x[n - 1 - i]; y[i] = S.y[n - 1 - i]; if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]); }
  S.rev = { x, y, cum };
  return S.rev;
}

function snapStations(S, stations) {
  const n = S.x.length, m = stations.length;
  const idx = new Int32Array(m);
  let from = 0, err = 0;
  for (let k = 0; k < m; k++) {
    const px = world.sx[stations[k]], py = world.sy[stations[k]];
    let best = from, bd = Infinity;
    for (let j = from; j < n; j++) {
      const d = (S.x[j] - px) ** 2 + (S.y[j] - py) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    idx[k] = best;
    from = best;
    err += Math.sqrt(bd);
  }
  return { idx, err: err / m };
}

function patternGeom(p) {
  let g = world.geom.get(p);
  if (g !== undefined) return g;
  const key = p.line + '|' + p.shapeIdx + '|' + p.stations.join(',');
  g = world.geomByKey.get(key);
  if (g === undefined) {
    const cands = p.shapeIdx >= 0 ? [p.shapeIdx] : [];
    if (!cands.length) world.shapes.forEach((s, i) => { if (s.line === p.line) cands.push(i); });
    let best = null;
    for (const si of cands) {
      for (const S of [world.shapes[si], reversedShape(world.shapes[si])]) {
        const r = snapStations(S, p.stations);
        if (!best || r.err < best.err) best = { S, idx: r.idx, err: r.err };
      }
    }
    // ~4 world units ≈ 450 m: further than that, the shape isn't this route — fall back to straight lines
    g = best && best.err < 4 ? best : null;
    world.geomByKey.set(key, g);
    if (!g) {
      // no track shape fits (e.g. NYC's F has none in the feed): draw the route through its stations,
      // so the trains always run on a visible line
      const pl = [...p.stations].map(s => [world.sx[s], world.sy[s]]);
      world.lines[p.line].push(pl);
      layerDirty = true;
    }
  }
  world.geom.set(p, g);
  return g;
}

// position of a train between stop a and stop b (fraction u) of pattern p
function trainXY(p, a, b, u) {
  const g = patternGeom(p);
  const sa = p.stations[a], sb = p.stations[b];
  if (g) {
    const i0 = g.idx[a], i1 = g.idx[b];
    if (i1 > i0) {
      const S = g.S;
      const target = S.cum[i0] + u * (S.cum[i1] - S.cum[i0]);
      let lo = i0, hi = i1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S.cum[m] <= target) lo = m; else hi = m; }
      const seg = S.cum[hi] - S.cum[lo];
      const v = seg > 0 ? (target - S.cum[lo]) / seg : 0;
      return [S.x[lo] + (S.x[hi] - S.x[lo]) * v, S.y[lo] + (S.y[hi] - S.y[lo]) * v];
    }
  }
  return [world.sx[sa] + (world.sx[sb] - world.sx[sa]) * u, world.sy[sa] + (world.sy[sb] - world.sy[sa]) * u];
}

function fitView() {
  const pad = 40;
  const w = world.maxX - world.minX || 1, h = world.maxY - world.minY || 1;
  const s = Math.min((width - 2 * pad) / w, (height - 2 * pad - 40) / h);
  view = { s, ox: width / 2 - s * (world.minX + w / 2), oy: height / 2 + 20 - s * (world.minY + h / 2) };
  layerDirty = true;
}

// ---------- static layer (boundary, lines, stations) ----------
function renderLayer() {
  if (!layer || layer.width !== width || layer.height !== height) {
    if (layer) layer.remove();
    layer = createGraphics(width, height);
    layer.pixelDensity(pixelDensity());
  }
  const g = layer;
  g.clear();
  g.push();
  g.translate(view.ox, view.oy);
  g.scale(view.s);
  const px = 1 / view.s;
  const dark = isDark();
  // boundary
  g.noStroke();
  g.fill(dark ? 40 : 228);
  for (const ring of world.rings) {
    g.beginShape();
    for (const p of ring) g.vertex(p[0], p[1]);
    g.endShape(CLOSE);
  }
  // lines
  const cfgs = Music.lineCfg();
  const anySolo = cfgs.some(c => c.solo);
  g.noFill();
  g.strokeJoin(ROUND);
  App.feed.lines.forEach((L, i) => {
    const off = cfgs[i] && (cfgs[i].mute || (anySolo && !cfgs[i].solo));
    const c = color(L.displayColor);
    c.setAlpha(off ? 110 : 235);
    g.stroke(c);
    g.strokeWeight((off ? 2.5 : 3.5) * px);
    for (const pl of world.lines[i]) {
      g.beginShape();
      for (const p of pl) g.vertex(p[0], p[1]);
      g.endShape();
    }
  });
  // stations
  g.stroke(dark ? 230 : 40);
  g.strokeWeight(0.8 * px);
  g.fill(dark ? 30 : 255);
  for (let i = 0; i < world.sx.length; i++) g.circle(world.sx[i], world.sy[i], 4.5 * px);
  g.pop();
  layerView = { ...view };
  layerDirty = false;
}

function isDark() { return document.documentElement.dataset.theme === 'dark'; }

// ---------- draw ----------
function draw() {
  const dark = isDark();
  background(dark ? 22 : 244);
  const feed = App.feed;
  if (!feed) { drawMessage(App.status || 'Choose a city or drop a GTFS file'); return; }
  if (feed !== lastFeed) {
    lastFeed = feed;
    world = buildWorld(feed, App.boundary);
    fitView();
  }
  if (App.redrawLines) { App.redrawLines = false; layerDirty = true; }
  const idle = millis() - lastInteract > 180;
  if (!layer || layer.width !== width || layer.height !== height || (layerDirty && idle)) renderLayer();

  // static layer, re-mapped from the view it was rendered at
  const f = view.s / layerView.s;
  push();
  translate(view.ox - f * layerView.ox, view.oy - f * layerView.oy);
  scale(f);
  image(layer, 0, 0, layer.width, layer.height);
  pop();

  const t = Music.simNow();
  push();
  translate(view.ox, view.oy);
  scale(view.s);
  const px = 1 / view.s;
  drawFlashes(px);
  drawTrains(t, px, dark);
  pop();
  drawClock(t, dark);
}

function drawTrains(t, px, dark) {
  const feed = App.feed;
  const inst = feed.instances;
  const cfgs = Music.lineCfg();
  const anySolo = cfgs.some(c => c.solo);
  // first instance that could still be running: start >= t - maxDur
  let lo = 0, hi = inst.length;
  const from = t - feed.maxDur;
  while (lo < hi) { const m = (lo + hi) >> 1; if (inst[m].s < from) lo = m + 1; else hi = m; }
  stroke(dark ? 0 : 255);
  strokeWeight(1 * px);
  const counts = new Array(feed.lines.length).fill(0);
  App.activeCounts = counts;   // the panel shows these as "trains running now"
  for (let k = lo; k < inst.length && inst[k].s <= t; k++) {
    const it = inst[k];
    if (it.e < t) continue;
    const p = it.p;
    counts[p.line]++;
    const dt = t - it.s;
    const offs = p.offsets;
    let a = 0, b = offs.length - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (offs[m] <= dt) a = m; else b = m; }
    const span = offs[b] - offs[a];
    const u = span > 0 ? Math.min(1, Math.max(0, (dt - offs[a]) / span)) : 0;
    const [x, y] = trainXY(p, a, b, u);
    const off = cfgs[p.line] && (cfgs[p.line].mute || (anySolo && !cfgs[p.line].solo));
    const c = color(feed.lines[p.line].displayColor);
    if (off) c.setAlpha(110);   // muted lines keep their colour, just paler
    fill(c);
    circle(x, y, (off ? 7 : 9) * px);
  }
}

function drawFlashes(px) {
  const now = performance.now();
  noFill();
  for (const fl of Music.flashes) {
    const age = (now - fl.real) / 700;
    if (age > 1 || age < 0) continue;
    const c = color(App.feed.lines[fl.line].displayColor);
    c.setAlpha(255 * (1 - age));
    stroke(c);
    strokeWeight(2 * px);
    circle(world.sx[fl.station], world.sy[fl.station], (8 + 26 * age) * px);
  }
}

function fmtClock(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  return `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function drawClock(t, dark) {
  noStroke();
  fill(dark ? 240 : 20);
  textAlign(LEFT, TOP);
  textSize(34);
  textStyle(BOLD);
  text(fmtClock(t), 18, 14);
  textStyle(NORMAL);
  textSize(13);
  fill(dark ? 170 : 90);
  text(App.title || '', 20, 54);
  const el = document.getElementById('clock-readout');
  if (el) el.textContent = fmtClock(t);
  const sl = document.getElementById('scrub');
  // in "moment" mode the slider marks the chosen moment, so it stays put
  if (sl && !sl.matches(':active') && Music.isPlaying() && App.mode !== 'moment') sl.value = Math.round(t / 60);
}

function drawMessage(msg) {
  noStroke();
  fill(isDark() ? 200 : 60);
  textAlign(CENTER, CENTER);
  textSize(16);
  text(msg, width / 2, height / 2);
}

// ---------- interaction (only when the pointer is on the map) ----------
function onMap(e) { return e && e.target && e.target.tagName === 'CANVAS'; }

function mouseWheel(e) {
  if (!onMap(e) || !world) return;
  const k = e.delta > 0 ? 1 / 1.15 : 1.15;
  view.ox = mouseX - (mouseX - view.ox) * k;
  view.oy = mouseY - (mouseY - view.oy) * k;
  view.s *= k;
  layerDirty = true;
  lastInteract = millis();
  return false;
}
let pressX = 0, pressY = 0;
function mousePressed(e) { if (onMap(e)) { dragging = true; lastX = pressX = mouseX; lastY = pressY = mouseY; } }
function mouseReleased() {
  // a click (not a drag) on a line launches one more train on it
  if (dragging && world && Math.hypot(mouseX - pressX, mouseY - pressY) < 5) {
    const li = lineAt(mouseX, mouseY);
    if (li >= 0) { App.changeTrains(li, +1); Music.preview(li); }
  }
  dragging = false;
}

// nearest line within 10 px of a screen point, or -1
function lineAt(sx, sy) {
  const wx = (sx - view.ox) / view.s, wy = (sy - view.oy) / view.s;
  let best = -1, bestD = 10 / view.s;
  world.lines.forEach((pls, li) => {
    for (const pl of pls) for (let k = 1; k < pl.length; k++) {
      const [ax, ay] = pl[k - 1], [bx, by] = pl[k];
      const dx = bx - ax, dy = by - ay;
      const L = dx * dx + dy * dy;
      const u = L ? Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy) / L)) : 0;
      const d = Math.hypot(wx - ax - u * dx, wy - ay - u * dy);
      if (d < bestD) { bestD = d; best = li; }
    }
  });
  return best;
}
function mouseMoved(e) {
  if (!world || !onMap(e)) return;
  document.querySelector('#map canvas').style.cursor = lineAt(mouseX, mouseY) >= 0 ? 'pointer' : 'grab';
}
function mouseDragged() {
  if (!dragging) return;
  view.ox += mouseX - lastX;
  view.oy += mouseY - lastY;
  lastX = mouseX; lastY = mouseY;
  layerDirty = true;
  lastInteract = millis();
}
function keyPressed(e) {
  const el = document.activeElement;
  const typing = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|number|search)$/.test(el.type)));
  if (typing) return;
  if (el && el.tagName === 'SELECT') el.blur();   // dropdowns otherwise swallow the shortcut keys
  if (key === ' ') { App.togglePlay(); return false; }
  if (key === 'r' || key === 'R') { resetView(); return false; }
}

function resetView() { if (world) fitView(); }
