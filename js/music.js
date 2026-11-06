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
    perLine: 1,            // max notes per line per 16th
    volume: -6,
  };

  let feed = null, lineCfg = [];   // lineCfg[i] = {midi, instrument, mute, solo}
  let voices = [];                 // per line: {inst, channel, kind}
  let master = null, ready = false, playing = false, repeatId = null;
  let simCursor = 0, evPtr = 0;
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

  function ensureVoice(i) {
    const cfg = lineCfg[i];
    let v = voices[i];
    if (v && v.kind === cfg.instrument) return v;
    if (v) { v.inst.dispose(); v.channel.dispose(); }
    const n = lineCfg.length;
    const channel = new Tone.Channel({ volume: 0, pan: n > 1 ? -0.6 + 1.2 * (i / (n - 1)) : 0 }).connect(master);
    const inst = makeInstrument(cfg.instrument);
    inst.connect(channel);
    v = voices[i] = { inst, channel, kind: cfg.instrument };
    return v;
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
  function noteFor(i, pos) {
    const cfg = lineCfg[i];
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
      const off = ((ev.t[i] - from) / simPerStep()) * stepSeconds() * 0.25; // a little human swing inside the step
      v.inst.trigger(Tone.Frequency(midi + v.inst.shift, 'midi').toNote(), v.inst.dur, time + off, vel);
      hits.push([ev.station[i], li]);
    }
    simCursor = to;
    if (simCursor > feed.dayEnd) { simCursor = feed.dayStart; evPtr = lowerBound(simCursor); }
    Tone.Draw.schedule(() => {
      const now = performance.now();
      anchor = { sim: from, real: now, playing: true };
      for (const [st, li] of hits) { flashes.push({ station: st, line: li, real: now }); lineLevel[li] = 1; }
      if (flashes.length > 400) flashes.splice(0, flashes.length - 400);
    }, time);
  }

  async function play() {
    if (!feed) return;
    await init();
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
    voices.forEach(v => { if (v) { v.inst.dispose(); v.channel.dispose(); } });
    voices = [];
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
  function updateLine(i, patch) {
    Object.assign(lineCfg[i], patch);
  }
  function preview(i) {
    init().then(() => {
      const v = ensureVoice(i);
      v.inst.trigger(Tone.Frequency(lineCfg[i].midi + v.inst.shift, 'midi').toNote(), v.inst.dur, Tone.now() + 0.02, 0.8);
    });
  }
  function onChange(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(fn => fn()); }

  return {
    NOTE_NAMES, NOTE_LABELS, SCALES, INSTRUMENTS, settings: S,
    play, pause, seek, simNow, setFeed, set, updateLine, preview, onChange,
    isPlaying: () => playing, flashes, lineLevel, lineCfg: () => lineCfg,
  };
})();
