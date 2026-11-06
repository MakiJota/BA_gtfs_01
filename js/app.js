// App glue: city list, GTFS drop, left panel controls, per-line mapping.
const CITIES = [
  { id: 'BA', name: 'Buenos Aires · Subte', gtfs: 'assets/BA/GTFS/', boundary: 'assets/BA/limit.geojson', colors: 'assets/BA/config.json',
    lines: { 'PM-C': { instrument: 'drum' }, 'PM-S': { instrument: 'hat' } } },
  { id: 'NYC', name: 'New York · Subway', gtfs: 'assets/NYC/GTFS/', boundary: 'assets/NYC/limit.geojson', colors: 'assets/NYC/NYC.json' },
  { id: 'CDMX', name: 'Ciudad de México · Metro', zip: 'assets/CDMX/GTFS/metro.zip', boundary: 'assets/CDMX/limit.geojson' },
  { id: 'SDC', name: 'Santiago de Chile · Metro', gtfs: 'assets/SDC/GTFS/', boundary: 'assets/SDC/limit.geojson' },
  { id: 'BE', name: 'Berlin area · bus sample', gtfs: 'assets/BE/GTFS/', boundary: 'assets/BE/limit.geojson' },
];
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000', '#808000', '#000075', '#e6a700', '#aa6e9f'];
const GERMAN = { A: 9, B: 10, C: 0, D: 2, E: 4, F: 5, G: 7, H: 11 }; // B = B♭, H = B natural
const PENTA = [0, 2, 4, 7, 9];
const INST_BY_GROUP = {
  metro: ['marimba', 'pluck', 'bell', 'chip', 'organ'], rail: ['organ', 'marimba', 'pluck', 'bell'],
  tram: ['bell', 'pluck', 'marimba'], ferry: ['pad'], bus: ['chip', 'marimba'], cable: ['hat'], other: ['marimba'],
};

const App = {
  feed: null, meta: null, boundary: null, city: null, status: '', title: '', redrawLines: false,
  mode: 'day',   // 'day' = play the whole day; 'moment' = loop a window around the chosen time
  togglePlay() { Music.isPlaying() ? Music.pause() : startMode(App.mode); },
  changeTrains: (i, d) => changeTrains(i, d),
};

const $ = (id) => document.getElementById(id);
const setStatus = (msg) => { App.status = msg; $('status').textContent = msg; };

// ---------- loading ----------
async function loadCity(city) {
  setStatus(`Loading ${city.name}…`);
  try {
    let source;
    if (city.zip) {
      const res = await fetch(city.zip);
      if (!res.ok) throw new Error(`Could not fetch ${city.zip}`);
      source = await GTFS.zipSource(await res.blob(), city.name);
    } else source = GTFS.urlSource(city.gtfs);
    const [boundary, colors] = await Promise.all([
      city.boundary ? fetch(city.boundary).then(r => r.ok ? r.json() : null).catch(() => null) : null,
      city.colors ? fetch(city.colors).then(r => r.ok ? r.json() : null).catch(() => null) : null,
    ]);
    await openFeed(source, { ...city, colorMap: colors && colors.colors }, boundary);
  } catch (e) { fail(e); }
}

async function loadDropped(files) {
  files = [...files];
  if (!files.length) return;
  const maki = files.find(f => /\.(maki|json)$/i.test(f.name));
  if (maki) { loadMakiFile(maki); return; }
  $('city').value = '';
  try {
    const zip = files.find(f => /\.zip$/i.test(f.name));
    let source, name;
    if (zip) {
      setStatus(`Unzipping ${zip.name} (${(zip.size / 1e6).toFixed(1)} MB)…`);
      source = await GTFS.zipSource(zip, zip.name);
      name = zip.name.replace(/\.zip$/i, '');
    } else {
      source = GTFS.filesSource(files.filter(f => /\.txt$/i.test(f.name)));
      name = 'Your GTFS';
    }
    await openFeed(source, { id: 'custom', name }, null);
  } catch (e) { fail(e); }
}

function fail(e) {
  console.error(e);
  setStatus('⚠️ ' + (e.message || e));
}

async function openFeed(source, city, boundary) {
  Music.pause();
  App.feed = null;
  App.city = city;
  App.boundary = boundary;
  App.meta = await GTFS.loadMeta(source, setStatus);
  // day + transport-type controls
  const daySel = $('day');
  daySel.innerHTML = '';
  if (!App.meta.days.length) daySel.add(new Option('All services', ''));
  for (const d of App.meta.days) daySel.add(new Option(`${d.label}  (${d.trips.toLocaleString()} trips)`, d.date));
  if (App.meta.defaultDate) daySel.value = App.meta.defaultDate;
  // a shared setup waiting to be applied picks the day / types / max lines it was made with
  const P = App.pending;
  if (P && P.date && [...daySel.options].some(o => o.value === String(P.date))) daySel.value = String(P.date);
  if (P && P.maxLines) $('maxlines').value = P.maxLines;
  const wanted = P && Array.isArray(P.groups) && P.groups.some(g => App.meta.groups.find(x => x.id === g)) ? new Set(P.groups) : App.meta.defaultGroups;
  const box = $('types');
  box.innerHTML = '';
  for (const g of App.meta.groups) {
    const lab = document.createElement('label');
    lab.className = 'chk';
    lab.innerHTML = `<input type="checkbox" value="${g.id}" ${wanted.has(g.id) ? 'checked' : ''}> ${g.label} <small>${g.trips.toLocaleString()}</small>`;
    lab.querySelector('input').addEventListener('change', rebuild);
    box.appendChild(lab);
  }
  await rebuild();
}

async function rebuild() {
  if (!App.meta) return;
  const groups = new Set([...document.querySelectorAll('#types input:checked')].map(i => i.value));
  if (!groups.size) { setStatus('Tick at least one transport type'); return; }
  const dayVal = $('day').value;
  const wasPlaying = Music.isPlaying();
  Music.pause();
  try {
    const feed = await GTFS.build(App.meta, {
      date: dayVal ? parseInt(dayVal, 10) : null,
      groups,
      maxLines: parseInt($('maxlines').value, 10) || 60,
    }, setStatus);
    const cm = App.city.colorMap || {};
    feed.lines.forEach((L, i) => { L.displayColor = cm[L.name] || L.color || PALETTE[i % PALETTE.length]; });
    const cfgs = feed.lines.map((L, i) => defaultLineCfg(L, i));
    const P = App.pending;
    App.pending = null;
    if (P && P.lines) feed.lines.forEach((L, i) => {
      const s = P.lines[L.name];
      if (!s) return;
      const midi = parseNote(s.note);
      if (midi !== null) cfgs[i].midi = midi;
      if (s.instrument && Music.INSTRUMENTS[s.instrument]) cfgs[i].instrument = s.instrument;
      cfgs[i].mute = s.mute !== undefined ? !!s.mute : false;
      if (Number.isInteger(s.fixedTrains) && s.fixedTrains >= 0) cfgs[i].fixed = s.fixedTrains;
    });
    if (cfgs.some(c => c.fixed != null)) GTFS.schedule(feed, cfgs.map(c => c.fixed));
    App.feed = feed;
    App.title = App.city.name;
    App.activeCounts = [];
    Music.setFeed(feed, cfgs);
    if (P && typeof P.time === 'number') Music.seek(Math.max(feed.dayStart, Math.min(feed.dayEnd, P.time)));
    renderLines();
    const sc = $('scrub');
    sc.min = Math.floor(feed.dayStart / 60);
    sc.max = Math.ceil(feed.dayEnd / 60);
    sc.value = Math.round(Music.simNow() / 60);
    if (P && (P.mode === 'day' || P.mode === 'moment')) App.mode = P.mode;
    if (P && P.window) $('window').value = String(P.window);
    if (App.mode === 'moment') applyLoop(false); else Music.setLoop(null);
    paintModes();
    showStats();
    setStatus(feed.events.n ? (P ? `Loaded shared setup${P.title ? ` “${P.title}”` : ''} — press Play` : '') : 'No trains found for this selection');
    dayLen();
    if (wasPlaying) Music.play();
  } catch (e) { fail(e); }
}

function defaultLineCfg(L, i) {
  let midi;
  const letter = L.name.trim().toUpperCase();
  // A3 B♭3 B3(H) C4 D4 E4 F4 G4
  if (letter.length === 1 && GERMAN[letter] !== undefined) midi = ('ABH'.includes(letter) ? 48 : 60) + GERMAN[letter];
  else midi = 48 + PENTA[i % 5] + 12 * (Math.floor(i / 5) % 3);
  const pool = INST_BY_GROUP[L.group] || INST_BY_GROUP.other;
  // every line starts muted: you switch on the voices you want to hear
  const cfg = { midi, instrument: pool[i % pool.length], mute: true, solo: false, fixed: null };
  const ov = App.city.lines && App.city.lines[L.name];
  return ov ? { ...cfg, ...ov } : cfg;
}

// ---------- lines list ----------
function renderLines() {
  const list = $('lines');
  list.innerHTML = '';
  const cfgs = Music.lineCfg();
  App.feed.lines.forEach((L, i) => {
    const cfg = cfgs[i];
    const row = document.createElement('div');
    row.className = 'line-row';
    const textCol = contrast(L.displayColor);
    row.innerHTML = `
      <button class="swatch" title="${esc(L.long || L.name)} — click to launch a train" style="background:${L.displayColor};color:${textCol}">${esc(short(L.name))}</button>
      <select class="note" title="Note">${Music.NOTE_LABELS.map((n, k) => `<option value="${k}">${n}</option>`).join('')}</select>
      <select class="oct" title="Octave">${[1, 2, 3, 4, 5, 6].map(o => `<option>${o}</option>`).join('')}</select>
      <select class="inst" title="Instrument">${Object.entries(Music.INSTRUMENTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <span class="trains" title="Trains running on this line right now">
        <button class="step minus" aria-label="One train less">−</button><b class="count">–</b><button class="step plus" aria-label="One train more">+</button>
      </span>
      <button class="spk" aria-label="Sound on/off"></button>`;
    const note = row.querySelector('.note'), oct = row.querySelector('.oct'), inst = row.querySelector('.inst');
    note.value = cfg.midi % 12;
    oct.value = Math.floor(cfg.midi / 12) - 1;
    inst.value = cfg.instrument;
    const setMidi = () => { Music.updateLine(i, { midi: (parseInt(oct.value, 10) + 1) * 12 + parseInt(note.value, 10) }); Music.preview(i); };
    note.addEventListener('change', setMidi);
    oct.addEventListener('change', setMidi);
    inst.addEventListener('change', () => { Music.updateLine(i, { instrument: inst.value }); Music.preview(i); });
    row.querySelector('.swatch').addEventListener('click', () => { changeTrains(i, +1); Music.preview(i); });
    row.querySelector('.plus').addEventListener('click', () => changeTrains(i, +1));
    row.querySelector('.minus').addEventListener('click', () => changeTrains(i, -1));
    const spk = row.querySelector('.spk');
    const paint = () => { spk.innerHTML = cfgs[i].mute ? SPEAKER_OFF : SPEAKER_ON; spk.classList.toggle('off', cfgs[i].mute); spk.title = cfgs[i].mute ? 'Sound off — click to turn on' : 'Sound on — click to mute'; };
    paint();
    spk.addEventListener('click', () => { Music.updateLine(i, { mute: !cfgs[i].mute, solo: false }); paint(); App.redrawLines = true; });
    list.appendChild(row);
  });
  updateCounts();
}

const SPEAKER_ON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SPEAKER_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// ---------- trains per line ----------
// Timetable lines show the average number of trains running over the next/last 15 minutes
// (a steady number, not one that flickers as trains come and go).
// Touching + / − / the line switches it to a FIXED number of trains: exactly N run all day.
const SMOOTH_WINDOW = 1800;
function smoothedCounts() {
  const f = App.feed;
  const counts = new Array(f.lines.length).fill(0);
  const t = Music.simNow(), a = t - SMOOTH_WINDOW / 2, b = t + SMOOTH_WINDOW / 2;
  const inst = f.instances;
  let lo = 0, hi = inst.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (inst[m].s < a - f.maxDur) lo = m + 1; else hi = m; }
  for (let k = lo; k < inst.length && inst[k].s <= b; k++) {
    const it = inst[k];
    const overlap = Math.min(it.e, b) - Math.max(it.s, a);
    if (overlap > 0) counts[it.p.line] += overlap / SMOOTH_WINDOW;
  }
  return counts;
}

let rescheduleTimer = null;
function changeTrains(i, delta) {
  if (!App.feed) return;
  const cfg = Music.lineCfg()[i];
  const now = cfg.fixed != null ? cfg.fixed : Math.round(smoothedCounts()[i]);
  const N = Math.max(0, Math.min(80, now + delta));
  Music.updateLine(i, { fixed: N });
  updateCounts();
  clearTimeout(rescheduleTimer);
  rescheduleTimer = setTimeout(reschedule, 120);
  setStatus(`Line ${App.feed.lines[i].name}: ${N === 0 ? 'no trains' : `${N} train${N > 1 ? 's' : ''}, evenly spaced, all day`} — Reset trains goes back to the timetable`);
}
function reschedule() {
  try {
    GTFS.schedule(App.feed, Music.lineCfg().map(c => c.fixed));
    Music.refresh();
    showStats();
  } catch (e) { fail(e); }
}
function resetTrains() {
  Music.lineCfg().forEach((c, i) => Music.updateLine(i, { fixed: null }));
  reschedule();
  updateCounts();
  setStatus('Back to the timetable');
}
function updateCounts() {
  if (!App.feed) return;
  const rows = document.querySelectorAll('#lines .line-row');
  const cfgs = Music.lineCfg();
  const avg = smoothedCounts();
  rows.forEach((row, i) => {
    const fixed = cfgs[i] && cfgs[i].fixed != null;
    const c = row.querySelector('.count');
    c.textContent = fixed ? cfgs[i].fixed : Math.round(avg[i]);
    c.classList.toggle('changed', fixed);
    row.querySelector('.trains').title = fixed
      ? `${cfgs[i].fixed} trains, evenly spaced, all day (Reset trains = back to the timetable)`
      : 'Trains running on average around this time (from the timetable)';
  });
}
function showStats() {
  const s = App.feed.stats;
  $('stats').textContent = `${s.lines} lines · ${s.trips.toLocaleString()} trains · ${s.notes.toLocaleString()} station arrivals` +
    (s.droppedLines ? ` · ${s.droppedLines} quieter lines hidden` : '') + (s.usedAllServices ? ' · (calendar didn’t match, using all services)' : '');
}
// label that fits the colour button: "L2-L2R" -> "L2R"; short names like "PM-C" stay as they are
function short(n) {
  if (n.length <= 5) return n;
  const tail = n.split(/[-\s]/).filter(Boolean).pop();
  return tail && tail.length <= 5 ? tail : n.slice(0, 5);
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function contrast(hex) {
  const h = hex.replace('#', '');
  if (h.length < 6) return '#000';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#000' : '#fff';
}
function setAllMute(m) {
  const cfgs = Music.lineCfg();
  cfgs.forEach((c, i) => Music.updateLine(i, { mute: m, solo: false }));
  renderLines();
  App.redrawLines = true;
}

// ---------- wiring ----------
function initUI() {
  // light / dark: remembered choice, else the system setting
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) { /* private mode */ }
  const sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  setTheme(saved || sys);
  $('theme').addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(t);
    try { localStorage.setItem('theme', t); } catch (e) { /* ignore */ }
  });

  const citySel = $('city');
  citySel.add(new Option('— choose a city —', ''));
  for (const c of CITIES) citySel.add(new Option(c.name, c.id));
  citySel.addEventListener('change', () => { const c = CITIES.find(x => x.id === citySel.value); if (c) loadCity(c); });

  $('file').addEventListener('change', e => loadDropped(e.target.files));
  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  // drop anywhere on the page
  let depth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); depth = 0; document.body.classList.remove('dragging'); loadDropped(e.dataTransfer.files); });

  $('day').addEventListener('change', rebuild);
  $('maxlines').addEventListener('change', rebuild);

  // two ways to play: the whole day, or a loop around one moment
  $('play-day').addEventListener('click', () => (Music.isPlaying() && App.mode === 'day') ? Music.pause() : startMode('day'));
  $('play-moment').addEventListener('click', () => (Music.isPlaying() && App.mode === 'moment') ? Music.pause() : startMode('moment'));
  Music.onChange(paintModes);
  $('scrub').addEventListener('input', e => {
    Music.seek(parseInt(e.target.value, 10) * 60);
    if (App.mode === 'moment') applyLoop(true);
  });
  $('window').addEventListener('change', () => { if (App.mode === 'moment') applyLoop(true); });
  $('reset-view').addEventListener('click', () => resetView());
  // dropdowns keep keyboard focus after a choice, which would swallow Space / R
  document.addEventListener('change', e => { if (e.target.tagName === 'SELECT') e.target.blur(); });

  const bind = (id, key, parse, label) => {
    const el = $(id);
    const out = $(id + '-out');
    const apply = () => { const v = parse(el.value); Music.set(key, v); if (out) out.textContent = label ? label(v) : v; };
    el.addEventListener('input', apply);
    el.value = Music.settings[key];
    apply();
  };
  bind('bpm', 'bpm', v => parseInt(v, 10));
  bind('speed', 'minutesPerBeat', v => parseFloat(v), v => `${v} min/beat`);
  bind('range', 'range', v => parseInt(v, 10), v => (v === 1 ? 'one note' : `${v} steps`));
  bind('perline', 'perLine', v => parseInt(v, 10));
  bind('volume', 'volume', v => parseInt(v, 10), v => `${v} dB`);
  const scaleSel = $('scale');
  for (const s of Object.keys(Music.SCALES)) scaleSel.add(new Option(s, s));
  scaleSel.value = Music.settings.scale;
  scaleSel.addEventListener('change', () => Music.set('scale', scaleSel.value));

  ['bpm', 'speed'].forEach(id => $(id).addEventListener('input', dayLen));

  $('mute-all').addEventListener('click', () => setAllMute(true));
  $('unmute-all').addEventListener('click', () => setAllMute(false));
  $('reset-trains').addEventListener('click', resetTrains);
  setInterval(updateCounts, 400);
  // a share link pasted into an already-open tab only changes the #hash
  window.addEventListener('hashchange', () => { const s = readShareHash(); if (s) applySetup(s); });

  // About modal
  $('about-btn').addEventListener('click', () => $('about-modal').classList.add('open'));
  $('about-modal').addEventListener('click', e => { if (e.target.id === 'about-modal' || e.target.classList.contains('close')) $('about-modal').classList.remove('open'); });

  // save / share / load
  $('share').addEventListener('click', copyShareLink);
  $('save').addEventListener('click', saveMaki);
  $('load').addEventListener('click', () => $('maki-file').click());
  $('maki-file').addEventListener('change', e => { if (e.target.files[0]) loadMakiFile(e.target.files[0]); e.target.value = ''; });

  // start from a shared link (#s=…), else ?city=XX, else Buenos Aires
  const shared = readShareHash();
  if (shared) { applySetup(shared); return; }
  const want = new URLSearchParams(location.search).get('city');
  const first = CITIES.find(c => want && c.id.toLowerCase() === want.toLowerCase()) || CITIES[0];
  citySel.value = first.id;
  loadCity(first);
  citySel.addEventListener('change', () => {
    const u = new URL(location.href);
    if (citySel.value) u.searchParams.set('city', citySel.value); else u.searchParams.delete('city');
    u.hash = '';
    history.replaceState(null, '', u);
  });
}

// ---------- play modes ----------
function startMode(mode) {
  if (!App.feed) return;
  App.mode = mode;
  if (mode === 'moment') applyLoop(true);
  else Music.setLoop(null);
  Music.play();
  paintModes();
  const anyOn = Music.lineCfg().some(c => !c.mute);
  if (!anyOn) setStatus('All lines are muted — turn some on with 🔇 (or Unmute all) to hear them');
}
// loop [time, time + window]; jump=true also moves the playhead to the loop start
function applyLoop(jump) {
  const start = parseInt($('scrub').value, 10) * 60;
  const end = Math.min(App.feed.dayEnd, start + parseInt($('window').value, 10) * 60);
  Music.setLoop(start, end);
  if (jump) Music.seek(start);
  paintModes();
}
function paintModes() {
  const playing = Music.isPlaying();
  const day = $('play-day'), mom = $('play-moment');
  day.classList.toggle('on', playing && App.mode === 'day');
  mom.classList.toggle('on', playing && App.mode === 'moment');
  day.textContent = playing && App.mode === 'day' ? '❚❚ Pause' : '▶ Play the day';
  mom.textContent = playing && App.mode === 'moment' ? '❚❚ Pause' : '⟳ Play a moment';
  const loop = Music.getLoop();
  const fmt = s => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
  $('mode-note').textContent = App.mode === 'moment' && loop
    ? `looping ${fmt(loop[0])}–${fmt(loop[1])}`
    : App.feed ? `whole day ${fmt(App.feed.dayStart)}–${fmt(App.feed.dayEnd)}` : '';
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').textContent = t === 'dark' ? '☀️' : '🌙';
  App.redrawLines = true;   // the map's static layer re-renders in the new colours
}

// ---------- setups: share links and .maki files ----------
// A setup is plain JSON. The same object is saved as a .maki file or packed into the link (#s=base64url).
const SETTING_INPUTS = { bpm: 'bpm', minutesPerBeat: 'speed', range: 'range', perLine: 'perline', volume: 'volume' };

function midiName(m) { return Music.NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1); }
function parseNote(n) {
  if (typeof n === 'number') return n;
  const m = /^([A-G]#?)(-?\d)$/.exec(String(n || '').trim());
  if (!m) return null;
  return (parseInt(m[2], 10) + 1) * 12 + Music.NOTE_NAMES.indexOf(m[1]);
}

function currentSetup() {
  if (!App.feed) return null;
  const cfgs = Music.lineCfg();
  const lines = {};
  App.feed.lines.forEach((L, i) => {
    const c = cfgs[i];
    lines[L.name] = { note: midiName(c.midi), instrument: c.instrument };
    if (c.solo) lines[L.name].solo = true;
    lines[L.name].mute = !!c.mute;
    if (c.fixed != null) lines[L.name].fixedTrains = c.fixed;
  });
  const S = Music.settings;
  return {
    maki: 1,
    app: 'Subte Musical',
    title: App.city.name,
    city: CITIES.some(c => c.id === App.city.id) ? App.city.id : null,
    feedName: App.city.name,
    date: $('day').value ? parseInt($('day').value, 10) : null,
    groups: [...document.querySelectorAll('#types input:checked')].map(i => i.value),
    maxLines: parseInt($('maxlines').value, 10) || 60,
    time: App.mode === 'moment' && Music.getLoop() ? Music.getLoop()[0] : Math.round(Music.simNow()),
    mode: App.mode,
    window: parseInt($('window').value, 10),
    settings: { bpm: S.bpm, minutesPerBeat: S.minutesPerBeat, scale: S.scale, range: S.range, perLine: S.perLine, volume: S.volume },
    lines,
  };
}

function applySettings(s) {
  if (!s) return;
  for (const [key, id] of Object.entries(SETTING_INPUTS)) {
    if (s[key] === undefined) continue;
    $(id).value = s[key];
    $(id).dispatchEvent(new Event('input'));
  }
  if (s.scale && Music.SCALES[s.scale]) { $('scale').value = s.scale; Music.set('scale', s.scale); }
}

async function applySetup(setup) {
  if (!setup || setup.maki !== 1) { setStatus('⚠️ Not a valid .maki setup'); return; }
  Music.pause();
  applySettings(setup.settings);
  App.pending = setup;
  const city = CITIES.find(c => c.id === setup.city);
  if (city) {
    $('city').value = city.id;
    await loadCity(city);
  } else if (App.meta && App.city && App.city.name === setup.feedName) {
    await openFeed(App.meta.source, App.city, App.boundary);   // same custom feed is already open
  } else {
    setStatus(`This setup was made for “${setup.feedName || 'a custom GTFS'}”. Drop that GTFS file to hear it.`);
  }
}

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function readShareHash() {
  const m = /[#&]s=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return null;
  try { return JSON.parse(fromBase64Url(m[1])); } catch (e) { console.warn('Bad share link', e); return null; }
}

async function copyShareLink() {
  const s = currentSetup();
  if (!s) return;
  const u = new URL(location.href);
  u.search = '';
  u.hash = 's=' + toBase64Url(JSON.stringify(s));
  history.replaceState(null, '', u);   // replaceState doesn't fire hashchange, so no reload loop
  let note = 'Link copied — anyone who opens it hears this exact setup';
  if (!s.city) note = 'Link copied — they’ll need to drop the same GTFS file to hear it';
  try { await navigator.clipboard.writeText(u.href); setStatus(note); }
  catch (e) { window.prompt('Copy this link:', u.href); }
}

function saveMaki() {
  const s = currentSetup();
  if (!s) return;
  const slug = (s.title || 'setup').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hhmm = new Date().toTimeString().slice(0, 5).replace(':', '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' }));
  a.download = `${slug}-${hhmm}.maki`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  setStatus(`Saved ${a.download}`);
}

async function loadMakiFile(file) {
  try { await applySetup(JSON.parse(await file.text())); }
  catch (e) { setStatus('⚠️ Could not read ' + file.name + ' — is it a .maki file?'); }
}

// "a full day lasts ~X min" helper
function dayLen() {
  if (!App.feed) return;
  const beats = (App.feed.dayEnd - App.feed.dayStart) / 60 / Music.settings.minutesPerBeat;
  $('daylen').textContent = `A full service day ≈ ${(beats / Music.settings.bpm).toFixed(1)} min of music`;
}

window.addEventListener('DOMContentLoaded', initUI);
