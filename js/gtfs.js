// GTFS loading + model building.
// Stage 1 (loadMeta): small/medium tables -> routes, trips, stops, calendars, frequencies.
// Stage 2 (build):    pick a day + transport types -> stream stop_times/shapes for the kept
//                     trips only -> patterns, train instances and a time-sorted note-event list.
const CSVlib = (typeof CSV !== 'undefined') ? CSV : require('./csv.js');

const GTFS = (() => {
  const CHUNK = 1 << 22;
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ---------- helpers ----------
  function parseTime(s) {
    if (!s) return NaN;
    s = s.trim();
    if (!s) return NaN;
    const p = s.split(':');
    return (+p[0]) * 3600 + (+p[1]) * 60 + (+(p[2] || 0));
  }
  function ymdToDate(n) { return new Date(Date.UTC(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100)); }
  function dateToYmd(d) { return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); }
  function addDays(n, k) { const d = ymdToDate(n); d.setUTCDate(d.getUTCDate() + k); return dateToYmd(d); }
  function weekdayIdx(n) { return (ymdToDate(n).getUTCDay() + 6) % 7; } // Mon=0 … Sun=6
  function fmtYmd(n) { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`; }

  function typeGroup(t) {
    if (t === 3 || t === 11 || (t >= 200 && t < 300) || (t >= 700 && t < 800)) return 'bus';
    if (t === 4 || t === 1200 || (t >= 1000 && t < 1100)) return 'ferry';
    if (t === 0 || (t >= 900 && t < 1000)) return 'tram';
    if (t === 1 || (t >= 400 && t < 500)) return 'metro';
    if (t === 2 || t === 12 || (t >= 100 && t < 200) || (t >= 300 && t < 400)) return 'rail';
    if (t === 5 || t === 6 || t === 7 || (t >= 1300 && t < 1500)) return 'cable';
    return 'other';
  }
  const GROUP_LABELS = { metro: 'Metro / Subway', tram: 'Tram / Light rail', rail: 'Rail', bus: 'Bus', ferry: 'Ferry', cable: 'Cable / Funicular', other: 'Other' };

  function* sliceIter(buf) { for (let i = 0; i < buf.length; i += CHUNK) yield buf.subarray(i, i + CHUNK); }

  // ---------- sources: anything with open(name) -> iterable of Uint8Array (or null) ----------
  function urlSource(base) {
    return {
      label: base,
      async open(name) {
        let res;
        try { res = await fetch(base + name); } catch (e) { return null; }
        if (!res.ok) return null;
        if (!res.body || !res.body.getReader) return sliceIter(new Uint8Array(await res.arrayBuffer()));
        const reader = res.body.getReader();
        return (async function* () {
          for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; }
        })();
      }
    };
  }

  async function zipSource(blob, label) {
    const zip = await JSZip.loadAsync(blob);
    const entries = {};
    const nested = [];
    zip.forEach((path, entry) => {
      if (entry.dir || path.includes('__MACOSX')) return;
      const base = path.split('/').pop().toLowerCase();
      if (base.endsWith('.zip')) nested.push(entry);
      if (!entries[base] || path.length < entries[base].name.length) entries[base] = entry;
    });
    if (!entries['stop_times.txt'] && nested.length) {   // zip inside a zip
      return zipSource(await nested[0].async('blob'), label);
    }
    return {
      label: label || blob.name || 'zip',
      async open(name) {
        const e = entries[name];
        if (!e) return null;
        return sliceIter(await e.async('uint8array'));
      }
    };
  }

  function filesSource(files) {
    const byName = {};
    for (const f of files) byName[f.name.toLowerCase()] = f;
    return {
      label: `${files.length} files`,
      async open(name) {
        const f = byName[name];
        if (!f) return null;
        return sliceIter(new Uint8Array(await f.arrayBuffer()));
      }
    };
  }

  // ---------- table reading ----------
  async function readCSV(source, name, onHeader, onRow, onProgress) {
    const it = await source.open(name);
    if (!it) return false;
    await CSVlib.parse(it, onHeader, onRow, onProgress);
    return true;
  }

  async function readTable(source, name) {
    let header = [];
    const rows = [];
    const ok = await readCSV(source, name, h => { header = h; }, f => rows.push(f));
    if (!ok) return null;
    const idx = {};
    header.forEach((h, i) => { idx[h] = i; });
    const get = (row, col) => { const i = idx[col]; return i === undefined || row[i] === undefined ? '' : row[i].trim(); };
    return { header, rows, get };
  }

  // ---------- stage 1 ----------
  async function loadMeta(source, progress = () => {}) {
    progress('Reading routes…');
    const R = await readTable(source, 'routes.txt');
    if (!R) throw new Error('routes.txt not found — is this a GTFS feed?');
    const routes = R.rows.map(r => ({
      id: R.get(r, 'route_id'),
      short: R.get(r, 'route_short_name'),
      long: R.get(r, 'route_long_name'),
      type: parseInt(R.get(r, 'route_type'), 10),
      color: R.get(r, 'route_color'),
      textColor: R.get(r, 'route_text_color'),
    }));
    const routeIdx = new Map(routes.map((r, i) => [r.id, i]));

    progress('Reading trips…');
    const T = await readTable(source, 'trips.txt');
    if (!T) throw new Error('trips.txt not found');
    const trips = new Map();
    for (const r of T.rows) {
      const ri = routeIdx.get(T.get(r, 'route_id'));
      if (ri === undefined) continue;
      trips.set(T.get(r, 'trip_id'), { r: ri, s: T.get(r, 'service_id'), d: parseInt(T.get(r, 'direction_id'), 10) || 0, sh: T.get(r, 'shape_id') });
    }

    progress('Reading stops…');
    const S = await readTable(source, 'stops.txt');
    if (!S) throw new Error('stops.txt not found');
    const stops = new Map();
    for (const r of S.rows) {
      stops.set(S.get(r, 'stop_id'), {
        lat: parseFloat(S.get(r, 'stop_lat')), lon: parseFloat(S.get(r, 'stop_lon')),
        name: S.get(r, 'stop_name'), parent: S.get(r, 'parent_station'),
      });
    }
    for (const s of stops.values()) {
      if ((isNaN(s.lat) || isNaN(s.lon)) && s.parent && stops.has(s.parent)) {
        const p = stops.get(s.parent); s.lat = p.lat; s.lon = p.lon;
      }
    }

    progress('Reading calendars…');
    const C = await readTable(source, 'calendar.txt');
    const calendar = C ? C.rows.map(r => ({
      id: C.get(r, 'service_id'),
      days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => C.get(r, d) === '1'),
      start: parseInt(C.get(r, 'start_date'), 10), end: parseInt(C.get(r, 'end_date'), 10),
    })) : [];
    const CD = await readTable(source, 'calendar_dates.txt');
    const calDates = new Map();
    if (CD) for (const r of CD.rows) {
      const d = parseInt(CD.get(r, 'date'), 10);
      if (!calDates.has(d)) calDates.set(d, []);
      calDates.get(d).push({ s: CD.get(r, 'service_id'), t: CD.get(r, 'exception_type') });
    }

    const F = await readTable(source, 'frequencies.txt');
    const freq = new Map();
    if (F) for (const r of F.rows) {
      const id = F.get(r, 'trip_id');
      const w = { start: parseTime(F.get(r, 'start_time')), end: parseTime(F.get(r, 'end_time')), headway: parseInt(F.get(r, 'headway_secs'), 10) };
      if (!(w.headway > 0) || isNaN(w.start) || isNaN(w.end)) continue;
      if (!freq.has(id)) freq.set(id, []);
      freq.get(id).push(w);
    }

    const meta = { source, routes, trips, stops, calendar, calDates, freq };
    meta.days = computeDays(meta);

    // trips per transport group (on the default day) so the UI can offer checkboxes
    const defaultDay = meta.days.length ? meta.days.reduce((a, b) => (b.trips > a.trips ? b : a)) : null;
    meta.defaultDate = defaultDay ? defaultDay.date : null;
    const act = servicesFor(meta, meta.defaultDate);
    const groups = {};
    for (const t of trips.values()) {
      if (act && !act.has(t.s)) continue;
      const g = typeGroup(routes[t.r].type);
      groups[g] = (groups[g] || 0) + 1;
    }
    meta.groups = Object.keys(groups).map(g => ({ id: g, label: GROUP_LABELS[g], trips: groups[g] })).sort((a, b) => b.trips - a.trips);
    const nonBus = meta.groups.filter(g => g.id !== 'bus');
    meta.defaultGroups = new Set((nonBus.length ? nonBus : meta.groups).map(g => g.id));
    return meta;
  }

  function servicesFor(meta, date) {
    if (date == null) return null;
    const set = new Set();
    const wd = weekdayIdx(date);
    for (const c of meta.calendar) if (c.days[wd] && date >= c.start && date <= c.end) set.add(c.id);
    for (const e of meta.calDates.get(date) || []) {
      if (e.t === '1') set.add(e.s); else if (e.t === '2') set.delete(e.s);
    }
    return set;
  }

  // A week of selectable dates inside the feed's validity (today if possible).
  function computeDays(meta) {
    let lo = Infinity, hi = -Infinity;
    for (const c of meta.calendar) { if (c.start < lo) lo = c.start; if (c.end > hi) hi = c.end; }
    for (const d of meta.calDates.keys()) { if (d < lo) lo = d; if (d > hi) hi = d; }
    if (!isFinite(lo)) return [];
    let ref = dateToYmd(new Date());
    if (ref < lo) ref = lo;
    if (ref > hi) ref = hi;
    if (addDays(ref, 6) > hi) ref = Math.max(lo, addDays(hi, -6));
    // weight = trains a trip really produces (frequency-based trips expand to many)
    const weight = new Map();
    for (const [id, ws] of meta.freq) weight.set(id, ws.reduce((a, w) => a + Math.ceil((w.end - w.start) / w.headway), 0));
    const days = [];
    for (let k = 0; k < 7; k++) {
      const date = addDays(ref, k);
      const act = servicesFor(meta, date);
      let n = 0;
      for (const [id, t] of meta.trips) if (act.has(t.s)) n += weight.get(id) || 1;
      days.push({ date, trips: n, label: `${DAY_NAMES[weekdayIdx(date)]} ${fmtYmd(date)}` });
    }
    return days;
  }

  // ---------- stage 2 ----------
  async function build(meta, settings, progress = () => {}) {
    const { routes, trips, stops, freq } = meta;
    const date = settings.date !== undefined ? settings.date : meta.defaultDate;
    const groups = settings.groups || meta.defaultGroups;
    const maxLines = settings.maxLines || 60;
    let active = servicesFor(meta, date);

    const pickTrips = (act) => {
      const lineCount = new Map();
      for (const t of trips.values()) {
        if (act && !act.has(t.s)) continue;
        const r = routes[t.r];
        if (!groups.has(typeGroup(r.type))) continue;
        const key = r.short || r.long || r.id;
        lineCount.set(key, (lineCount.get(key) || 0) + 1);
      }
      return lineCount;
    };
    let lineCount = pickTrips(active);
    if (lineCount.size === 0 && active) { active = null; lineCount = pickTrips(null); } // calendar mismatch: use everything

    const keys = [...lineCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxLines).map(e => e[0]);
    const dropped = lineCount.size - keys.length;
    keys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const lineIdx = new Map(keys.map((k, i) => [k, i]));
    const lines = keys.map(k => ({ key: k, name: k, color: '', type: 0, group: '', long: '', trips: lineCount.get(k) }));

    const kept = new Map(); // trip_id -> {line, dir, shape}
    for (const [id, t] of trips) {
      if (active && !active.has(t.s)) continue;
      const r = routes[t.r];
      if (!groups.has(typeGroup(r.type))) continue;
      const li = lineIdx.get(r.short || r.long || r.id);
      if (li === undefined) continue;
      kept.set(id, { line: li, dir: t.d, shape: t.sh });
      const L = lines[li];
      if (!L.color && r.color) L.color = '#' + r.color.replace('#', '');
      L.type = r.type; L.group = typeGroup(r.type);
      if (!L.long && r.long) L.long = r.long;
    }

    // --- stream stop_times for kept trips only ---
    progress('Reading stop_times…');
    const st = new Map();
    let ci = {};
    let rowsSeen = 0;
    const ok = await readCSV(meta.source, 'stop_times.txt',
      h => { ci = { trip: h.indexOf('trip_id'), arr: h.indexOf('arrival_time'), dep: h.indexOf('departure_time'), stop: h.indexOf('stop_id'), seq: h.indexOf('stop_sequence') }; },
      f => {
        rowsSeen++;
        let id = f[ci.trip];
        if (id === undefined) return;
        if (!kept.has(id)) { id = id.trim(); if (!kept.has(id)) return; }
        let a = st.get(id);
        if (!a) { a = []; st.set(id, a); }
        const arr = parseTime(f[ci.arr]);
        a.push([parseInt(f[ci.seq], 10), isNaN(arr) ? parseTime(f[ci.dep]) : arr, (f[ci.stop] || '').trim()]);
      },
      (bytes) => progress(`Reading stop_times… ${(bytes / 1e6).toFixed(0)} MB`));
    if (!ok) throw new Error('stop_times.txt not found');

    // --- stations + patterns ---
    progress('Building trains…');
    const stationIdx = new Map();
    const stLat = [], stLon = [], stName = [];
    const stationOf = (stopId) => {
      const s = stops.get(stopId);
      if (!s || isNaN(s.lat) || isNaN(s.lon)) return -1;
      const key = (s.parent && stops.has(s.parent)) ? s.parent : stopId;
      let i = stationIdx.get(key);
      if (i === undefined) {
        const p = stops.get(key);
        const lat = isNaN(p.lat) ? s.lat : p.lat, lon = isNaN(p.lon) ? s.lon : p.lon;
        i = stLat.length; stationIdx.set(key, i);
        stLat.push(lat); stLon.push(lon); stName.push(p.name || s.name);
      }
      return i;
    };

    const patterns = new Map();
    for (const [id, rows] of st) {
      rows.sort((a, b) => a[0] - b[0]);
      // fill missing times by linear interpolation along the sequence
      const n = rows.length;
      let last = -1;
      for (let k = 0; k < n; k++) {
        if (!isNaN(rows[k][1])) {
          if (last >= 0 && k - last > 1) for (let j = last + 1; j < k; j++) rows[j][1] = rows[last][1] + (rows[k][1] - rows[last][1]) * (j - last) / (k - last);
          last = k;
        }
      }
      const sts = [], times = [];
      for (const r of rows) {
        if (isNaN(r[1])) continue;
        const si = stationOf(r[2]);
        if (si < 0 || sts[sts.length - 1] === si) continue;
        sts.push(si); times.push(r[1]);
      }
      if (sts.length < 2) continue;
      const t0 = times[0];
      const offs = times.map(t => t - t0);
      const info = kept.get(id);
      const key = info.line + '|' + sts.join(',') + '|' + offs.join(',');
      let p = patterns.get(key);
      if (!p) {
        p = { line: info.line, dir: info.dir, stations: Int32Array.from(sts), offsets: Float32Array.from(offs), shape: info.shape, starts: [] };
        patterns.set(key, p);
      }
      const w = freq.get(id);
      if (w) { for (const win of w) for (let s = win.start; s < win.end; s += win.headway) p.starts.push(s); }
      else p.starts.push(t0);
    }
    const pats = [...patterns.values()];

    // --- station rank along each line (same station => same pitch in both directions) ---
    const rank = lines.map(() => new Map());
    for (let li = 0; li < lines.length; li++) {
      let ref = null;
      for (const p of pats) {
        if (p.line !== li) continue;
        if (!ref || p.stations.length > ref.stations.length || (p.stations.length === ref.stations.length && p.dir < ref.dir)) ref = p;
      }
      if (!ref) continue;
      const n = ref.stations.length;
      ref.stations.forEach((s, k) => rank[li].set(s, n > 1 ? k / (n - 1) : 0));
    }

    // --- pitch position of every stop of every pattern ---
    for (const p of pats) {
      const n = p.stations.length;
      const pos = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const r = rank[p.line].get(p.stations[k]);
        pos[k] = r !== undefined ? r : (p.dir ? 1 - k / (n - 1) : k / (n - 1));
      }
      p.pos = pos;
      p.starts.sort((a, b) => a - b);
    }
    progress('Sorting notes…');

    // --- geometry: shapes if present, else station sequences ---
    progress('Reading shapes…');
    const wantShapes = new Map(); // shape_id -> line
    for (const p of pats) if (p.shape && !wantShapes.has(p.shape)) wantShapes.set(p.shape, p.line);
    const shapePts = new Map();
    if (wantShapes.size) {
      let sc = {};
      await readCSV(meta.source, 'shapes.txt',
        h => { sc = { id: h.indexOf('shape_id'), lat: h.indexOf('shape_pt_lat'), lon: h.indexOf('shape_pt_lon'), seq: h.indexOf('shape_pt_sequence') }; },
        f => {
          let id = f[sc.id];
          if (id === undefined) return;
          if (!wantShapes.has(id)) { id = id.trim(); if (!wantShapes.has(id)) return; }
          let a = shapePts.get(id);
          if (!a) { a = []; shapePts.set(id, a); }
          a.push([parseFloat(f[sc.seq]), parseFloat(f[sc.lat]), parseFloat(f[sc.lon])]);
        });
    }
    const polylines = lines.map(() => []);
    const lineHasShape = new Set();
    for (const [id, pts] of shapePts) {
      pts.sort((a, b) => a[0] - b[0]);
      const li = wantShapes.get(id);
      polylines[li].push(pts.filter(q => !isNaN(q[1]) && !isNaN(q[2])).map(q => [q[1], q[2]]));
      lineHasShape.add(li);
    }
    const seenSeq = new Set();
    for (const p of pats) {
      if (lineHasShape.has(p.line)) continue;
      const k = p.line + ':' + p.stations.join(',');
      if (seenSeq.has(k)) continue;
      seenSeq.add(k);
      polylines[p.line].push([...p.stations].map(s => [stLat[s], stLon[s]]));
    }

    // --- bounding box (trimmed so a few far-away stops don't shrink the map) ---
    const lats = [...stLat].sort((a, b) => a - b), lons = [...stLon].sort((a, b) => a - b);
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(f * (arr.length - 1))))];
    const trim = lats.length > 60 ? 0.01 : 0;
    const bbox = { latMin: q(lats, trim), latMax: q(lats, 1 - trim), lonMin: q(lons, trim), lonMax: q(lons, 1 - trim) };

    progress('');
    const feed = {
      date, lines, patterns: pats, polylines,
      stations: { lat: Float64Array.from(stLat), lon: Float64Array.from(stLon), name: stName },
      bbox,
      stats: { lines: lines.length, droppedLines: dropped, stopTimeRows: rowsSeen, usedAllServices: !active && date != null },
    };
    schedule(feed, null);
    feed.dayStart = feed.span.start;   // the day's range stays fixed, whatever the frequencies
    feed.dayEnd = feed.span.end;
    return feed;
  }

  // Re-space a pattern's departures so the line runs `f` times as often (f=2: twice as many trains).
  // Departures are interpolated inside each service run; long gaps (e.g. the night) are never filled.
  // deps: departures of one line+direction, sorted [{s, p}]. Each new departure reuses the pattern
  // (route + running times) of the nearest original one.
  function warp(deps, f) {
    if (f === 1) return deps;
    if (f <= 0) return [];
    const out = [];
    const gaps = [];
    for (let i = 1; i < deps.length; i++) gaps.push(deps[i].s - deps[i - 1].s);
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[gaps.length >> 1] : 0;
    const breakGap = Math.max(1800, median * 3);
    const flush = (a, b) => { // deps[a..b] is one continuous run
      const n = b - a + 1;
      if (n === 1) { if (f >= 0.5) out.push(deps[a]); return; }
      const total = (n - 1) * f;
      for (let k = 0; k <= total + 1e-9; k++) {
        const x = k / f;
        const i = Math.min(n - 2, Math.floor(x));
        const u = x - i;
        const A = deps[a + i], B = deps[a + i + 1];
        out.push({ s: A.s + (B.s - A.s) * u, p: u < 0.5 ? A.p : B.p });
      }
    };
    let runStart = 0;
    for (let i = 1; i <= deps.length; i++) {
      if (i === deps.length || deps[i].s - deps[i - 1].s > breakGap) { flush(runStart, i - 1); runStart = i; }
    }
    return out;
  }

  // (Re)build train instances and the time-sorted note events. freq[line] = frequency factor (default 1).
  function schedule(feed, freq) {
    const pats = feed.patterns;
    const groups = new Map();
    for (const p of pats) {
      const key = p.line + '|' + p.dir;
      if (!groups.has(key)) groups.set(key, []);
      const g = groups.get(key);
      for (const s of p.starts) g.push({ s, p });
    }
    const deps = [];
    for (const g of groups.values()) {
      g.sort((a, b) => a.s - b.s);
      const f = freq && freq[g[0].p.line] !== undefined ? freq[g[0].p.line] : 1;
      for (const d of warp(g, f)) deps.push(d);
    }
    let total = 0;
    for (const d of deps) total += d.p.stations.length;
    if (total > 4e6) throw new Error(`This selection has ${(total / 1e6).toFixed(1)}M stops — too many. Untick some transport types or lower "max lines".`);
    const evT = new Float64Array(total), evLine = new Uint16Array(total), evPos = new Float32Array(total), evSt = new Uint32Array(total), evTerm = new Uint8Array(total);
    const instances = [];
    let e = 0, start = Infinity, end = -Infinity, maxDur = 0;
    for (const { s, p } of deps) {
      const n = p.stations.length;
      const dur = p.offsets[n - 1];
      if (dur > maxDur) maxDur = dur;
      instances.push({ p, s, e: s + dur });
      if (s < start) start = s;
      if (s + dur > end) end = s + dur;
      for (let k = 0; k < n; k++, e++) {
        evT[e] = s + p.offsets[k]; evLine[e] = p.line; evPos[e] = p.pos[k]; evSt[e] = p.stations[k];
        evTerm[e] = (k === 0 || k === n - 1) ? 1 : 0;
      }
    }
    const order = new Uint32Array(total);
    for (let i = 0; i < total; i++) order[i] = i;
    order.sort((a, b) => evT[a] - evT[b]);
    const events = { n: total, t: new Float64Array(total), line: new Uint16Array(total), pos: new Float32Array(total), station: new Uint32Array(total), term: new Uint8Array(total) };
    for (let i = 0; i < total; i++) {
      const j = order[i];
      events.t[i] = evT[j]; events.line[i] = evLine[j]; events.pos[i] = evPos[j]; events.station[i] = evSt[j]; events.term[i] = evTerm[j];
    }
    instances.sort((a, b) => a.s - b.s);
    feed.events = events;
    feed.instances = instances;
    feed.maxDur = maxDur;
    feed.span = { start: isFinite(start) ? start : 0, end: isFinite(end) ? end : 86400 };
    feed.stats.trips = instances.length;
    feed.stats.notes = total;
    return feed;
  }

  return { urlSource, zipSource, filesSource, loadMeta, build, schedule, servicesFor, typeGroup, parseTime, GROUP_LABELS };
})();

if (typeof module !== 'undefined') module.exports = GTFS;
