// Sound engine: Tone.js. A 16th-note grid at the chosen BPM walks through the day;
// each step plays the station arrivals that fall inside its slice of simulated time.
const Music = (() => {
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NOTE_LABELS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const SCALES = {
    'Major pentatonic': [0, 2, 4, 7, 9],
    'Minor pentatonic': [0, 3, 5, 7, 10],
    'Major': [0, 2, 4, 5, 7, 9, 11],
    'Natural minor': [0, 2, 3, 5, 7, 8, 10],
    'Dorian': [0, 2, 3, 5, 7, 9, 10],
    'Blues': [0, 3, 5, 6, 7, 10],
    'Whole tone': [0, 2, 4, 6, 8, 10],
    'Chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  const INSTRUMENTS = {
    marimba: 'Marimba', pluck: 'Pluck', bell: 'Bell', chip: 'Chiptune', pad: 'Pad',
    bass: 'Bass', organ: 'Organ', drum: 'Drum', hat: 'Hi-hat',
  };

  const S = {
    bpm: 100,
    minutesPerBeat: 2,     // simulated minutes per beat
    scale: 'Major pentatonic',
    range: 7,              // scale steps from first to last station (1 = one note per line)
    perLine: 2,            // max notes per line per 16th
    volume: -6,
  };

  let feed = null, lineCfg = [];   // lineCfg[i] = {midi, instrument, mute, solo}
  const voices = new Map();        // 'L3' / 'S3' -> {inst, channel, kind}
  let master = null, ready = false, playing = false, repeatId = null;
  let simCursor = 0, evPtr = 0;
  let loop = null;                 // [start, end] in sim seconds: "play a moment"; null = the whole day
  let anchor = { sim: 0, real: 0, playing: false };
  const flashes = [];              // for the sketch: {station, line, real}
  const lineLevel = [];            // recent activity per line (0..1) for the UI meters
  const listeners = [];

  const simPerStep = () => S.minutesPerBeat * 60 / 4;
  const stepSeconds = () => 60 / S.bpm / 4;

  function lowerBound(t) {
    if (!feed) return 0;
    const a = feed.events.t;
    let lo = 0, hi = feed.events.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t) lo = m + 1; else hi = m; }
    return lo;
  }

  // ---------- instruments ----------
  function pool(make, n) {
    const items = Array.from({ length: n }, make);
    let k = 0;
    return {
      nodes: items,
      trigger(note, dur, time, vel) { const v = items[k++ % n]; try { v.triggerAttackRelease(note, dur, time, vel); } catch (e) { /* voice busy */ } },
      connect(dest) { items.forEach(v => v.connect(dest)); },
      dispose() { items.forEach(v => v.dispose()); },
    };
  }
  function poly(voice, opts, volume) {
    const p = new Tone.PolySynth(voice, opts);
    p.maxPolyphony = 24;
    p.volume.value = volume || 0;
    return {
      trigger(note, dur, time, vel) { try { p.triggerAttackRelease(note, dur, time, vel); } catch (e) { /* polyphony */ } },
      connect(dest) { p.connect(dest); },
      dispose() { p.dispose(); },
    };
  }
  function makeInstrument(kind) {
    switch (kind) {
      case 'pluck': return { ...pool(() => new Tone.PluckSynth({ attackNoise: 1.2, dampening: 3500, resonance: 0.92 }), 6), dur: '8n', shift: 0 };
      case 'bell': return { ...poly(Tone.FMSynth, { harmonicity: 3.01, modulationIndex: 12, envelope: { attack: 0.001, decay: 1.2, sustain: 0, release: 1.2 }, modulationEnvelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.4 } }, -10), dur: '4n', shift: 12 };
      case 'chip': return { ...poly(Tone.Synth, { oscillator: { type: 'square' }, envelope: { attack: 0.002, decay: 0.12, sustain: 0.05, release: 0.08 } }, -16), dur: '16n', shift: 0 };
      case 'pad': return { ...poly(Tone.AMSynth, { harmonicity: 2, envelope: { attack: 0.35, decay: 0.6, sustain: 0.3, release: 2 } }, -12), dur: '2n', shift: 0 };
      case 'bass': return { ...poly(Tone.MonoSynth, { oscillator: { type: 'sawtooth' }, filter: { Q: 2, type: 'lowpass' }, filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.2, release: 0.4, baseFrequency: 120, octaves: 2.5 }, envelope: { attack: 0.01, decay: 0.3, sustain: 0.2, release: 0.4 } }, -12), dur: '8n', shift: -12 };
      case 'organ': return { ...poly(Tone.Synth, { oscillator: { type: 'fatsine', count: 3, spread: 18 }, envelope: { attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.4 } }, -14), dur: '8n', shift: 0 };
      case 'drum': return { ...pool(() => new Tone.MembraneSynth({ pitchDecay: 0.03, octaves: 4, envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.2 } }), 4), dur: '8n', shift: -24 };
      case 'hat': return { ...pool(() => { const m = new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.08, release: 0.05 }, harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5 }); m.volume.value = -22; return m; }, 4), dur: '32n', shift: 0 };
      default: return { ...poly(Tone.Synth, { oscillator: { type: 'triangle' }, envelope: { attack: 0.004, decay: 0.35, sustain: 0, release: 0.3 } }, -6), dur: '8n', shift: 0 };
    }
  }

  // one voice per line per tab ('L' = listen, 'S' = sample), created on first use
  function ensureVoice(i, tab = 'L') {
    const cfg = tab === 'S' ? sample.lines[i] : lineCfg[i];
    const key = tab + i;
    let v = voices.get(key);
    if (v && v.kind === cfg.instrument) return v;
    if (v) { v.inst.dispose(); v.channel.dispose(); }
    const n = Math.max(lineCfg.length, sample.lines.length);
    const channel = new Tone.Channel({ volume: 0, pan: n > 1 ? -0.6 + 1.2 * (i / (n - 1)) : 0 }).connect(master);
    const inst = makeInstrument(cfg.instrument);
    inst.connect(channel);
    v = { inst, channel, kind: cfg.instrument };
    voices.set(key, v);
    return v;
  }
  function disposeVoices() {
    voices.forEach(v => { v.inst.dispose(); v.channel.dispose(); });
    voices.clear();
  }

  async function init() {
    if (ready) return;
    await Tone.start();
    const limiter = new Tone.Limiter(-2).toDestination();
    const reverb = new Tone.Reverb({ decay: 2.4, wet: 0.22 }).connect(limiter);
    master = new Tone.Gain(0.8).connect(reverb);
    Tone.Destination.volume.value = S.volume;
    Tone.Transport.bpm.value = S.bpm;
    ready = true;
  }

  // ---------- scheduling ----------
  function noteFor(i, pos, cfg = lineCfg[i]) {
    const sc = SCALES[S.scale];
    const deg = S.range > 1 ? Math.round(pos * (S.range - 1)) : 0;
    return cfg.midi + sc[deg % sc.length] + 12 * Math.floor(deg / sc.length);
  }

  function step(time) {
    if (!feed) return;
    const ev = feed.events;
    const from = simCursor, to = simCursor + simPerStep();
    const anySolo = lineCfg.some(c => c.solo);
    const perLine = new Map();
    let total = 0;
    const hits = [];
    while (evPtr < ev.n && ev.t[evPtr] < to) {
      const i = evPtr++;
      const li = ev.line[i];
      const cfg = lineCfg[li];
      if (!cfg || cfg.mute || (anySolo && !cfg.solo)) continue;
      const midi = noteFor(li, ev.pos[i]);
      let used = perLine.get(li);
      if (!used) { used = new Set(); perLine.set(li, used); }
      if (used.size >= S.perLine || used.has(midi) || total >= 24) continue;
      used.add(midi);
      total++;
      const v = ensureVoice(li);
      const vel = ev.term[i] ? 0.9 : 0.55 + Math.random() * 0.2;
      // the note sounds at the exact moment the train reaches the station (not snapped to the grid)
      const off = ((ev.t[i] - from) / simPerStep()) * stepSeconds();
      v.inst.trigger(Tone.Frequency(midi + v.inst.shift, 'midi').toNote(), v.inst.dur, time + off, vel);
      hits.push([ev.station[i], li, off]);
    }
    simCursor = to;
    const [lo, hi] = loop || [feed.dayStart, feed.dayEnd];
    if (simCursor >= hi || simCursor < lo) { simCursor = lo; evPtr = lowerBound(simCursor); }
    // the visual clock and the flashes are stamped with the wall-clock time this step sounds
    const real = performance.now() + Math.max(0, time - Tone.context.currentTime) * 1000;
    for (const [st, li, off] of hits) pushFlash(st, li, real + off * 1000);
    Tone.Draw.schedule(() => { anchor = { sim: from, real: performance.now(), playing: true }; }, time);
  }

  // ---------- the sampler (tab 2) ----------
  // Each line runs `n` trains from its first to its last station, one station per beat at the line's
  // own BPM, then back to the start (one silent beat for the return). Every station reached = a note.
  // Lines keep their own position (xRef at TRef), so a BPM change doesn't make trains jump.
  const sample = { lines: [], playing: false, Tbase: 0, audioBase: 0, cursorT: 0, timer: null };
  const ctxNow = () => Tone.context.currentTime;
  function sampleT(audio = ctxNow()) { return sample.playing ? sample.Tbase + (audio - sample.audioBase) : sample.Tbase; }
  function sampleX(L, T) { return L.xRef + (T - L.TRef) * L.bpm / 60; }

  function setSampleLines(lines) {
    sample.lines = lines.map(L => ({ xRef: 0, TRef: 0, ...L }));
    sample.Tbase = 0; sample.cursorT = 0;
  }
  function updateSampleLine(i, patch) {
    const L = sample.lines[i];
    if (!L) return;
    if ('bpm' in patch) { const T = sampleT(); L.xRef = sampleX(L, T); L.TRef = T; }
    Object.assign(L, patch);
  }
  function sampleTick() {
    const now = ctxNow();
    const fromT = sample.cursorT, toT = sampleT(now + 0.15);   // schedule 150 ms ahead
    if (toT <= fromT) return;
    const hits = [];
    sample.lines.forEach((L, i) => {
      if (!L.on || !(L.n > 0) || L.S < 2 || !(L.bpm > 0)) return;
      const per = L.S;                          // S stations + the return beat
      for (let k = 0; k < L.n; k++) {
        const off = k * per / L.n;
        const x0 = sampleX(L, fromT) + off, x1 = sampleX(L, toT) + off;
        for (let m = Math.floor(x0) + 1; m <= Math.floor(x1); m++) {
          const idx = ((m % per) + per) % per;  // station index along the trip
          const st = L.invert ? L.S - 1 - idx : idx;
          const T = L.TRef + (m - off - L.xRef) * 60 / L.bpm;
          const when = Math.max(now + 0.01, sample.audioBase + (T - sample.Tbase));
          const v = ensureVoice(i, 'S');
          const midi = noteFor(i, st / (L.S - 1), L);
          const vel = (idx === 0 || idx === L.S - 1) ? 0.9 : 0.6;
          v.inst.trigger(Tone.Frequency(midi + v.inst.shift, 'midi').toNote(), v.inst.dur, when, vel);
          hits.push([L.stations[st], i, when]);
        }
      }
    });
    sample.cursorT = toT;
    // flashes carry the wall-clock moment their note sounds; the map skips them until then.
    // (Tone.Draw would drop them on a slow frame, e.g. a big network on a phone.)
    const nowReal = performance.now();
    for (const [station, line, when] of hits) pushFlash(station, line, nowReal + (when - now) * 1000);
  }
  function pushFlash(station, line, real) {
    flashes.push({ station, line, real });
    if (flashes.length > 600) flashes.splice(0, flashes.length - 600);
  }
  async function playSample() {
    await init();
    if (playing) pause();               // only one tab plays at a time
    if (sample.playing) return;
    const now = ctxNow();
    sample.audioBase = now + 0.05;
    sample.cursorT = sample.Tbase;
    sample.playing = true;
    sample.timer = setInterval(sampleTick, 25);
    sampleTick();
    emit();
  }
  function pauseSample() {
    if (!sample.playing) return;
    sample.Tbase = sampleT();
    sample.playing = false;
    clearInterval(sample.timer);
    emit();
  }
  // where every sampler train is now, for the map: [{line, a, u}] (between stop a and a+1, fraction u)
  // The map reads the same clock the notes are scheduled on, minus the device's output delay,
  // so a train is drawn at a station exactly when you hear that station's note.
  function sampleTrains() {
    const raw = Tone.context.rawContext;
    const latency = (raw.outputLatency || 0) + (raw.baseLatency || 0);
    const T = sampleT(ctxNow() - latency);
    const out = [];
    sample.lines.forEach((L, i) => {
      if (!(L.n > 0) || L.S < 2) return;
      for (let k = 0; k < L.n; k++) {
        const x = sampleX(L, T) + k * L.S / L.n;
        const m = ((x % L.S) + L.S) % L.S;
        const a = Math.floor(m);
        // last beat of the loop: the train waits at the terminal, then reappears at the first
        // station exactly when that station's note plays
        if (a >= L.S - 1) out.push({ line: i, a: L.S - 2, u: 1, invert: L.invert, on: L.on });
        else out.push({ line: i, a, u: m - a, invert: L.invert, on: L.on });
      }
    });
    return out;
  }

  async function play() {
    if (!feed) return;
    await init();
    if (sample.playing) pauseSample();
    if (playing) return;
    if (repeatId === null) repeatId = Tone.Transport.scheduleRepeat(step, '16n');
    evPtr = lowerBound(simCursor);
    Tone.Transport.start('+0.05');
    playing = true;
    emit();
  }
  function pause() {
    if (!playing) return;
    Tone.Transport.pause();
    playing = false;
    anchor = { sim: simCursor, real: performance.now(), playing: false };
    emit();
  }
  function seek(t) {
    simCursor = t;
    evPtr = lowerBound(t);
    anchor = { sim: t, real: performance.now(), playing: false };
    if (playing) anchor.playing = true;
  }
  // Simulated "now" for the visuals, interpolated between audio steps.
  function simNow() {
    if (!anchor.playing || !playing) return anchor.sim;
    const rate = simPerStep() / stepSeconds();
    return anchor.sim + Math.min((performance.now() - anchor.real) / 1000 * rate, simPerStep() * 1.5);
  }

  function setFeed(f, cfgs) {
    const wasPlaying = playing;
    if (playing) pause();
    pauseSample();
    disposeVoices();
    feed = f;
    lineCfg = cfgs;
    lineLevel.length = 0;
    flashes.length = 0;
    seek(Math.max(f.dayStart, Math.min(f.dayEnd, 7 * 3600)));
    if (wasPlaying) play();
  }
  function set(key, val) {
    S[key] = val;
    if (key === 'bpm' && ready) Tone.Transport.bpm.rampTo(val, 0.1);
    if (key === 'volume' && ready) Tone.Destination.volume.rampTo(val, 0.1);
  }
  function setLoop(start, end) { loop = start == null ? null : [start, end]; }
  // the feed's events were rebuilt (e.g. a line's frequency changed): re-find our place in time
  function refresh() { evPtr = lowerBound(simCursor); }
  function updateLine(i, patch) {
    Object.assign(lineCfg[i], patch);
  }
  function preview(i, tab = 'L') {
    init().then(() => {
      const v = ensureVoice(i, tab);
      const cfg = tab === 'S' ? sample.lines[i] : lineCfg[i];
      v.inst.trigger(Tone.Frequency(cfg.midi + v.inst.shift, 'midi').toNote(), v.inst.dur, Tone.now() + 0.02, 0.8);
    });
  }
  function onChange(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(fn => fn()); }

  return {
    NOTE_NAMES, NOTE_LABELS, SCALES, INSTRUMENTS, settings: S,
    play, pause, seek, simNow, setFeed, set, updateLine, refresh, preview, onChange, setLoop,
    getLoop: () => loop,
    setSampleLines, updateSampleLine, playSample, pauseSample, sampleTrains,
    sampleLines: () => sample.lines, isSamplePlaying: () => sample.playing,
    isPlaying: () => playing, flashes, lineLevel, lineCfg: () => lineCfg,
  };
})();
