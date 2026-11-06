// App glue: city list, GTFS drop, the two tabs (Listen / Sample), save & share.
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
const SAMPLE_DEFAULT = { n: 2, invert: false };

const App = {
  feed: null, meta: null, boundary: null, city: null, status: '', title: '', redrawLines: false,
  tab: 'listen',   // 'listen' = the real timetable; 'sample' = every line is a loop you design
  mode: 'day',     // listen tab: 'day' = whole day; 'moment' = loop a window around the chosen time
  routes: [],      // per line: the pattern the sampler runs on
  togglePlay() {
    if (App.tab === 'sample') Music.isSamplePlaying() ? Music.pauseSample() : startSample();
    else Music.isPlaying() ? Music.pause() : startMode(App.mode);
  },
  clickLine: (i) => clickLine(i),
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
  Music.pauseSample();
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
  Music.pause();
  Music.pauseSample();
  try {
    const feed = await GTFS.build(App.meta, {
      date: dayVal ? parseInt(dayVal, 10) : null,
      groups,
      maxLines: parseInt($('maxlines').value, 10) || 60,
    }, setStatus);
    const cm = App.city.colorMap || {};
    feed.lines.forEach((L, i) => { L.displayColor = cm[L.name] || L.color || PALETTE[i % PALETTE.length]; });
    const P = App.pending;
    App.pending = null;

    // --- tab 1: listen ---
    const cfgs = feed.lines.map((L, i) => defaultLineCfg(L, i));
    const PL = P && P.lines;
    if (PL) feed.lines.forEach((L, i) => {
      const s = PL[L.name];
      if (!s) return;
      const midi = parseNote(s.note);
      if (midi !== null) cfgs[i].midi = midi;
      if (s.instrument && Music.INSTRUMENTS[s.instrument]) cfgs[i].instrument = s.instrument;
      cfgs[i].mute = s.mute !== undefined ? !!s.mute : false;
    });
    App.feed = feed;
    App.title = App.city.name;
    Music.setFeed(feed, cfgs);
    if (P && typeof P.time === 'number') Music.seek(Math.max(feed.dayStart, Math.min(feed.dayEnd, P.time)));

    // --- tab 2: sample — each line runs on its longest route ---
    App.routes = feed.lines.map((L, i) => {
      let best = null;
      for (const p of feed.patterns) if (p.line === i && (!best || p.stations.length > best.stations.length || (p.stations.length === best.stations.length && p.dir < best.dir))) best = p;
      return best;
    });
    const sampleBpm = parseInt($('sample-bpm').value, 10) || 90;
    const PS = P && P.sample && P.sample.lines;
    Music.setSampleLines(feed.lines.map((L, i) => {
      const r = App.routes[i];
      const base = { midi: cfgs[i].midi, instrument: cfgs[i].instrument, on: false, n: SAMPLE_DEFAULT.n, bpm: sampleBpm, invert: SAMPLE_DEFAULT.invert, S: r ? r.stations.length : 0, stations: r ? [...r.stations] : [] };
      const s = PS && PS[L.name];
      if (s) {
        const midi = parseNote(s.note);
        if (midi !== null) base.midi = midi;
        if (s.instrument && Music.INSTRUMENTS[s.instrument]) base.instrument = s.instrument;
        base.on = !!s.on;
        if (Number.isInteger(s.trains) && s.trains >= 0) base.n = s.trains;
        if (s.bpm > 0) base.bpm = s.bpm;
        base.invert = !!s.invert;
      }
      return base;
    }));

    renderLines();
    renderSampleLines();
    const sc = $('scrub');
    sc.min = Math.floor(feed.dayStart / 60);
    sc.max = Math.ceil(feed.dayEnd / 60);
    sc.value = Math.round(Music.simNow() / 60);
    if (P && (P.mode === 'day' || P.mode === 'moment')) App.mode = P.mode;
    if (P && P.window) $('window').value = String(P.window);
    if (App.mode === 'moment') applyLoop(false); else Music.setLoop(null);
    if (P && (P.tab === 'listen' || P.tab === 'sample')) setTab(P.tab); else setTab(App.tab);
    paintModes();
    showStats();
    setStatus(feed.events.n ? (P ? `Loaded shared setup${P.title ? ` “${P.title}”` : ''} — press Play` : '') : 'No trains found for this selection');
    dayLen();
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
  const cfg = { midi, instrument: pool[i % pool.length], mute: true, solo: false };
  const ov = App.city.lines && App.city.lines[L.name];
  return ov ? { ...cfg, ...ov } : cfg;
}

// ---------- shared row parts ----------
const SPEAKER_ON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SPEAKER_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// swatch | note | octave | instrument | speaker — the same in both tabs
function soundRow(L, cfg, { onNote, onInst, onSwatch, isOn, onToggle, title }) {
  const row = document.createElement('div');
  row.className = 'line-row listen';
  row.innerHTML = `
    <button class="swatch" title="${esc(title)}" style="background:${L.displayColor};color:${contrast(L.displayColor)}">${esc(short(L.name))}</button>
    <select class="note" title="Note">${Music.NOTE_LABELS.map((n, k) => `<option value="${k}">${n}</option>`).join('')}</select>
    <select class="oct" title="Octave">${[1, 2, 3, 4, 5, 6].map(o => `<option>${o}</option>`).join('')}</select>
    <select class="inst" title="Instrument">${Object.entries(Music.INSTRUMENTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    <button class="spk" aria-label="Sound on/off"></button>`;
  const note = row.querySelector('.note'), oct = row.querySelector('.oct'), inst = row.querySelector('.inst');
  note.value = cfg.midi % 12;
  oct.value = Math.floor(cfg.midi / 12) - 1;
  inst.value = cfg.instrument;
  const setMidi = () => onNote((parseInt(oct.value, 10) + 1) * 12 + parseInt(note.value, 10));
  note.addEventListener('change', setMidi);
  oct.addEventListener('change', setMidi);
  inst.addEventListener('change', () => onInst(inst.value));
  row.querySelector('.swatch').addEventListener('click', onSwatch);
  const spk = row.querySelector('.spk');
  row.paint = () => {
    const on = isOn();
    spk.innerHTML = on ? SPEAKER_ON : SPEAKER_OFF;
    spk.classList.toggle('off', !on);
    spk.title = on ? 'Sound on — click to mute' : 'Sound off — click to turn on';
  };
  row.paint();
  spk.addEventListener('click', () => { onToggle(); row.paint(); App.redrawLines = true; });
  return row;
}

// ---------- tab 1: listen ----------
function renderLines() {
  const list = $('lines');
  list.innerHTML = '';
  const cfgs = Music.lineCfg();
  App.feed.lines.forEach((L, i) => {
    const row = soundRow(L, cfgs[i], {
      title: `${L.long || L.name} — click to hear`,
      onNote: m => { Music.updateLine(i, { midi: m }); Music.preview(i); },
      onInst: v => { Music.updateLine(i, { instrument: v }); Music.preview(i); },
      onSwatch: () => Music.preview(i),
      isOn: () => !cfgs[i].mute,
      onToggle: () => Music.updateLine(i, { mute: !cfgs[i].mute, solo: false }),
    });
    list.appendChild(row);
  });
}
function setAllMute(m) {
  Music.lineCfg().forEach((c, i) => Music.updateLine(i, { mute: m, solo: false }));
  renderLines();
  App.redrawLines = true;
}

// ---------- tab 2: sample ----------
function renderSampleLines() {
  const list = $('sample-lines');
  list.innerHTML = '';
  const SL = Music.sampleLines();
  App.feed.lines.forEach((L, i) => {
    const s = SL[i];
    const wrap = document.createElement('div');
    wrap.className = 's-row';
    const row = soundRow(L, s, {
      title: `${L.long || L.name} — click to launch one more train`,
      onNote: m => { Music.updateSampleLine(i, { midi: m }); Music.preview(i, 'S'); },
      onInst: v => { Music.updateSampleLine(i, { instrument: v }); Music.preview(i, 'S'); },
      onSwatch: () => { sampleTrains(i, +1); Music.preview(i, 'S'); },
      isOn: () => s.on,
      onToggle: () => Music.updateSampleLine(i, { on: !s.on }),
    });
    wrap.appendChild(row);
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    ctl.innerHTML = `
      <span class="hint" style="margin:0">${s.S} st.</span>
      <span class="trains" title="Trains on this line">
        <button class="step minus" aria-label="One train less">−</button><b class="count">${s.n}</b><button class="step plus" aria-label="One train more">+</button>
      </span>
      <label class="bpm">BPM <input type="number" class="sbpm" min="10" max="400" step="1" value="${s.bpm}"></label>
      <button class="inv ${s.invert ? 'on' : ''}" title="Run the trains the other way">⇄</button>`;
    ctl.querySelector('.plus').addEventListener('click', () => sampleTrains(i, +1));
    ctl.querySelector('.minus').addEventListener('click', () => sampleTrains(i, -1));
    const bpm = ctl.querySelector('.sbpm');
    bpm.addEventListener('change', () => {
      const v = Math.max(10, Math.min(400, parseInt(bpm.value, 10) || s.bpm));
      bpm.value = v;
      Music.updateSampleLine(i, { bpm: v });
    });
    const inv = ctl.querySelector('.inv');
    inv.addEventListener('click', () => { Music.updateSampleLine(i, { invert: !s.invert }); inv.classList.toggle('on', s.invert); });
    if (!s.S) ctl.querySelector('.hint').textContent = 'no route';
    wrap.appendChild(ctl);
    wrap.paintAll = () => { row.paint(); ctl.querySelector('.count').textContent = s.n; bpm.value = s.bpm; inv.classList.toggle('on', s.invert); };
    list.appendChild(wrap);
  });
}
function sampleTrains(i, delta) {
  const s = Music.sampleLines()[i];
  if (!s) return;
  const n = Math.max(0, Math.min(64, s.n + delta));
  Music.updateSampleLine(i, { n });
  if (delta > 0 && !s.on) Music.updateSampleLine(i, { on: true });   // launching a train = you want to hear it
  const wrap = $('sample-lines').children[i];
  if (wrap && wrap.paintAll) wrap.paintAll();
  setStatus(`Line ${App.feed.lines[i].name}: ${n} train${n === 1 ? '' : 's'}`);
}
function sampleAll(patch) {
  Music.sampleLines().forEach((s, i) => Music.updateSampleLine(i, patch(s)));
  [...$('sample-lines').children].forEach(w => w.paintAll && w.paintAll());
  App.redrawLines = true;
}

// map click on a line: listen tab toggles its sound; sample tab launches one more train
function clickLine(i) {
  if (App.tab === 'sample') { sampleTrains(i, +1); Music.preview(i, 'S'); return; }
  const c = Music.lineCfg()[i];
  Music.updateLine(i, { mute: !c.mute });
  renderLines();
  App.redrawLines = true;
  if (!c.mute) Music.preview(i);
  setStatus(`Line ${App.feed.lines[i].name}: sound ${c.mute ? 'off' : 'on'}`);
}

function setTab(tab) {
  if (tab !== App.tab) { Music.pause(); Music.pauseSample(); }
  App.tab = tab;
  $('tab-listen').classList.toggle('on', tab === 'listen');
  $('tab-sample').classList.toggle('on', tab === 'sample');
  $('tab-listen').setAttribute('aria-selected', tab === 'listen');
  $('tab-sample').setAttribute('aria-selected', tab === 'sample');
  $('pane-listen').hidden = tab !== 'listen';
  $('pane-sample').hidden = tab !== 'sample';
  App.redrawLines = true;
  paintModes();
}

function showStats() {
  const s = App.feed.stats;
  const sk = s.skipped || {};
  const skippedStops = (sk.noTime || 0) + (sk.noCoords || 0) + (sk.backwards || 0);
  $('stats').textContent = `${s.lines} lines · ${s.trips.toLocaleString()} trains · ${s.notes.toLocaleString()} station arrivals` +
    (s.droppedLines ? ` · ${s.droppedLines} quieter lines hidden` : '') +
    (skippedStops ? ` · ${skippedStops.toLocaleString()} stops without usable data skipped` : '') +
    (s.usedAllServices ? ' · (calendar didn’t match, using all services)' : '');
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

  // tabs
  $('tab-listen').addEventListener('click', () => setTab('listen'));
  $('tab-sample').addEventListener('click', () => setTab('sample'));

  // tab 1: two ways to play — the whole day, or a loop around one moment
  $('play-day').addEventListener('click', () => (Music.isPlaying() && App.mode === 'day') ? Music.pause() : startMode('day'));
  $('play-moment').addEventListener('click', () => (Music.isPlaying() && App.mode === 'moment') ? Music.pause() : startMode('moment'));
  Music.onChange(paintModes);
  $('scrub').addEventListener('input', e => {
    Music.seek(parseInt(e.target.value, 10) * 60);
    if (App.mode === 'moment') applyLoop(true);
  });
  $('window').addEventListener('change', () => { if (App.mode === 'moment') applyLoop(true); });
  $('mute-all').addEventListener('click', () => setAllMute(true));
  $('unmute-all').addEventListener('click', () => setAllMute(false));

  // tab 2: the sampler
  $('play-sample').addEventListener('click', () => Music.isSamplePlaying() ? Music.pauseSample() : startSample());
  const sbpm = $('sample-bpm');
  sbpm.addEventListener('input', () => { $('sample-bpm-out').textContent = sbpm.value; sampleAll(() => ({ bpm: parseInt(sbpm.value, 10) })); });
  $('s-mute-all').addEventListener('click', () => sampleAll(() => ({ on: false })));
  $('s-unmute-all').addEventListener('click', () => sampleAll(() => ({ on: true })));
  $('s-reset').addEventListener('click', () => {
    sampleAll(() => ({ n: SAMPLE_DEFAULT.n, bpm: parseInt(sbpm.value, 10), invert: SAMPLE_DEFAULT.invert }));
    setStatus('Sample reset: 2 trains per line, same BPM, normal direction');
  });

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

  citySel.addEventListener('change', () => {
    const u = new URL(location.href);
    if (citySel.value) u.searchParams.set('city', citySel.value); else u.searchParams.delete('city');
    u.hash = '';
    history.replaceState(null, '', u);
  });

  // start from a shared link (#s=…), else ?city=XX, else Buenos Aires
  const shared = readShareHash();
  if (shared) { applySetup(shared); return; }
  const want = new URLSearchParams(location.search).get('city');
  const first = CITIES.find(c => want && c.id.toLowerCase() === want.toLowerCase()) || CITIES[0];
  citySel.value = first.id;
  loadCity(first);
}

// ---------- play ----------
function startMode(mode) {
  if (!App.feed) return;
  App.mode = mode;
  if (mode === 'moment') applyLoop(true);
  else Music.setLoop(null);
  Music.play();
  paintModes();
  if (!Music.lineCfg().some(c => !c.mute)) setStatus('All lines are muted — turn some on (or Unmute all) to hear them');
}
function startSample() {
  if (!App.feed) return;
  Music.playSample();
  if (!Music.sampleLines().some(s => s.on && s.n > 0)) setStatus('All sample lines are off — turn some on (or All on) to hear them');
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
  const day = $('play-day'), mom = $('play-moment'), smp = $('play-sample');
  day.classList.toggle('on', playing && App.mode === 'day');
  mom.classList.toggle('on', playing && App.mode === 'moment');
  day.textContent = playing && App.mode === 'day' ? '❚❚ Pause' : '▶ Play the day';
  mom.textContent = playing && App.mode === 'moment' ? '❚❚ Pause' : '⟳ Play a moment';
  const sp = Music.isSamplePlaying();
  smp.classList.toggle('on', sp);
  smp.textContent = sp ? '❚❚ Pause the sample' : '▶ Play the sample';
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
  const SL = Music.sampleLines();
  const lines = {}, sampleLines = {};
  App.feed.lines.forEach((L, i) => {
    const c = cfgs[i];
    lines[L.name] = { note: midiName(c.midi), instrument: c.instrument, mute: !!c.mute };
    const s = SL[i];
    if (s) sampleLines[L.name] = { note: midiName(s.midi), instrument: s.instrument, on: !!s.on, trains: s.n, bpm: s.bpm, invert: !!s.invert };
  });
  const S = Music.settings;
  return {
    maki: 1,
    app: 'Subte Musical',
    title: App.city.name,
    city: CITIES.some(c => c.id === App.city.id) ? App.city.id : null,
    feedName: App.city.name,
    tab: App.tab,
    date: $('day').value ? parseInt($('day').value, 10) : null,
    groups: [...document.querySelectorAll('#types input:checked')].map(i => i.value),
    maxLines: parseInt($('maxlines').value, 10) || 60,
    time: App.mode === 'moment' && Music.getLoop() ? Music.getLoop()[0] : Math.round(Music.simNow()),
    mode: App.mode,
    window: parseInt($('window').value, 10),
    settings: { bpm: S.bpm, minutesPerBeat: S.minutesPerBeat, scale: S.scale, range: S.range, perLine: S.perLine, volume: S.volume },
    lines,
    sample: { bpm: parseInt($('sample-bpm').value, 10), lines: sampleLines },
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
  Music.pauseSample();
  applySettings(setup.settings);
  if (setup.sample && setup.sample.bpm > 0) { $('sample-bpm').value = setup.sample.bpm; $('sample-bpm-out').textContent = setup.sample.bpm; }
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
  a.download = `${slug}-${s.tab}-${hhmm}.maki`;
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
