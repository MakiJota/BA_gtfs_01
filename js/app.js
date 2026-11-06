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
  togglePlay() { Music.isPlaying() ? Music.pause() : Music.play(); },
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
  const box = $('types');
  box.innerHTML = '';
  for (const g of App.meta.groups) {
    const lab = document.createElement('label');
    lab.className = 'chk';
    lab.innerHTML = `<input type="checkbox" value="${g.id}" ${App.meta.defaultGroups.has(g.id) ? 'checked' : ''}> ${g.label} <small>${g.trips.toLocaleString()}</small>`;
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
    App.feed = feed;
    App.title = App.city.name;
    Music.setFeed(feed, cfgs);
    renderLines();
    const sc = $('scrub');
    sc.min = Math.floor(feed.dayStart / 60);
    sc.max = Math.ceil(feed.dayEnd / 60);
    sc.value = Math.round(Music.simNow() / 60);
    const s = feed.stats;
    $('stats').textContent = `${s.lines} lines · ${s.trips.toLocaleString()} trains · ${s.notes.toLocaleString()} station arrivals` +
      (s.droppedLines ? ` · ${s.droppedLines} quieter lines hidden` : '') + (s.usedAllServices ? ' · (calendar didn’t match, using all services)' : '');
    setStatus(feed.events.n ? '' : 'No trains found for this selection');
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
  const cfg = { midi, instrument: pool[i % pool.length], mute: false, solo: false };
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
      <button class="swatch" title="${esc(L.long || L.name)} — click to hear" style="background:${L.displayColor};color:${textCol}">${esc(short(L.name))}</button>
      <select class="note" title="Note">${Music.NOTE_LABELS.map((n, k) => `<option value="${k}">${n}</option>`).join('')}</select>
      <select class="oct" title="Octave">${[1, 2, 3, 4, 5, 6].map(o => `<option>${o}</option>`).join('')}</select>
      <select class="inst" title="Instrument">${Object.entries(Music.INSTRUMENTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <button class="tog mute" title="Mute">M</button>
      <button class="tog solo" title="Solo">S</button>`;
    const note = row.querySelector('.note'), oct = row.querySelector('.oct'), inst = row.querySelector('.inst');
    note.value = cfg.midi % 12;
    oct.value = Math.floor(cfg.midi / 12) - 1;
    inst.value = cfg.instrument;
    const setMidi = () => { Music.updateLine(i, { midi: (parseInt(oct.value, 10) + 1) * 12 + parseInt(note.value, 10) }); Music.preview(i); };
    note.addEventListener('change', setMidi);
    oct.addEventListener('change', setMidi);
    inst.addEventListener('change', () => { Music.updateLine(i, { instrument: inst.value }); Music.preview(i); });
    row.querySelector('.swatch').addEventListener('click', () => Music.preview(i));
    const mute = row.querySelector('.mute'), solo = row.querySelector('.solo');
    mute.classList.toggle('on', cfg.mute);
    solo.classList.toggle('on', cfg.solo);
    mute.addEventListener('click', () => { Music.updateLine(i, { mute: !cfgs[i].mute }); mute.classList.toggle('on', cfgs[i].mute); App.redrawLines = true; });
    solo.addEventListener('click', () => { Music.updateLine(i, { solo: !cfgs[i].solo }); solo.classList.toggle('on', cfgs[i].solo); App.redrawLines = true; });
    list.appendChild(row);
  });
}
function short(n) { return n.length > 5 ? n.slice(0, 5) : n; }
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
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';

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

  const playBtn = $('play');
  playBtn.addEventListener('click', () => App.togglePlay());
  Music.onChange(() => { playBtn.textContent = Music.isPlaying() ? '❚❚ Pause' : '▶ Play'; playBtn.classList.toggle('on', Music.isPlaying()); });

  $('scrub').addEventListener('input', e => Music.seek(parseInt(e.target.value, 10) * 60));

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

  // About modal
  $('about-btn').addEventListener('click', () => $('about-modal').classList.add('open'));
  $('about-modal').addEventListener('click', e => { if (e.target.id === 'about-modal' || e.target.classList.contains('close')) $('about-modal').classList.remove('open'); });

  // start with ?city=XX if given (shareable links), else Buenos Aires
  const want = new URLSearchParams(location.search).get('city');
  const first = CITIES.find(c => want && c.id.toLowerCase() === want.toLowerCase()) || CITIES[0];
  citySel.value = first.id;
  loadCity(first);
  citySel.addEventListener('change', () => {
    const u = new URL(location.href);
    if (citySel.value) u.searchParams.set('city', citySel.value); else u.searchParams.delete('city');
    history.replaceState(null, '', u);
  });
}

// "a full day lasts ~X min" helper
function dayLen() {
  if (!App.feed) return;
  const beats = (App.feed.dayEnd - App.feed.dayStart) / 60 / Music.settings.minutesPerBeat;
  $('daylen').textContent = `A full service day ≈ ${(beats / Music.settings.bpm).toFixed(1)} min of music`;
}

window.addEventListener('DOMContentLoaded', initUI);
