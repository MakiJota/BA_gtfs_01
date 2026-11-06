# Subte Music: the Buenos Aires metro as an instrument

## Goal
Turn the Buenos Aires Subte timetable (GTFS) into music. Each line is a voice. Every time a train reaches a station, a note plays. One service day runs as a few minutes of music, with an animated map in sync.

The user can play with the system: change the **BPM**, change **how often trains run** on each line, mute or solo lines, and export the result.

## Where we are (current repo state)
| Piece | State |
|---|---|
| Live site | https://makijota.github.io/BA_gtfs_01/ (GitHub Pages, `main` branch) |
| [index.html](index.html) | Left panel (city / GTFS drop / day / transport types, play controls, per-line note + instrument + mute/solo), plus the About-me popup and the coffee widget |
| [js/gtfs.js](js/gtfs.js) + [js/csv.js](js/csv.js) | Generic GTFS loader. Streams big files, picks a day from the calendar, expands `frequencies.txt`, and builds the time-sorted arrival events ✅ |
| [js/music.js](js/music.js) | Tone.js engine: 16th grid at the BPM, per-line voices, scales, cap on notes per line ✅ |
| [BA_gtfs_01.js](BA_gtfs_01.js) | p5 map with timetable-driven trains and note flashes ✅ (the old random-dot version is in git history) |
| Cities | BA, NYC, CDMX (from `metro.zip`; the loose CDMX `stops.txt` has mismatched ids), SDC, BE (a bus sample, not the S-Bahn) |

## BA data: facts that shape the design
Checked in `assets/BA/GTFS/`:
- **Routes:** A, B, C, D, E, H (`route_type=1`) plus Premetro `PM-C` and `PM-S` (`route_type=0`). There is no Line F in the feed (it is still under construction).
- **The feed is frequency-based.** `stop_times.txt` holds only 48 *template* trips (one per line × direction × service). `frequencies.txt` holds 149 headway windows (`exact_times=1`). Real trips are **synthesised** like this: for each window, start departures at `start_time` and add `headway_secs` each time while still before `end_time`. Each stop gets the template trip's offset relative to its first arrival.
- **Services:** `5` = Mon–Fri, `6` = Sat, `7` = Sun. The feed is valid 2014–2019, so we **choose the service by hand** and don't filter by today's date.
- **Stations per trip:** A 17, B 17, C 9, D 16, E 18, H 12, PM 14/16. Direction comes from `direction_id` (trip ids `X0n` = 0, `X1n` = 1).
- **Headways:** Subte lines run every 170–515 s; Premetro every 840–1160 s. Service runs roughly 05:30–23:30.
- `transfers.txt` lists the interchanges. Use them for chords when two lines hit a shared station at the same moment.

### Density problem (do the maths before building)
A weekday has ≈ 4 directions × ~300 trips × ~15 stops per line ≈ **50–60k arrival events**.
If 18 h of service is squeezed into 4 min (270× speed), that is ~250 notes/s. That is noise, not music.
How to bring it down (combine them):
1. **Slower clock:** e.g. 1 simulated hour ≈ 1 min of audio (60×).
2. **Quantise** every note to a beat grid at the chosen BPM. Notes that fall in the same slot on the same line merge into one, and its velocity grows with how many merged.
3. **Event filter:** sound only some events. Options: terminals, interchange stations, every Nth station, or one note per train departure.
4. **Per-line voice cap:** at most N notes per line per beat.

## Musical mapping (v1 defaults; all configurable)
- **Line → pitch class**, using German note names so the letters work as written:
  A = A, **B = B♭**, C = C, D = D, E = E, **H = B♮** (H is B natural in German).
  Premetro → percussion (no pitch).
- **Station index → octave step / scale degree.** Moving along the line climbs a scale (pentatonic built on the line's root keeps things consonant).
- **Direction → stereo pan** (direction 0 left, direction 1 right). Alternative: direction 0 goes up the scale, direction 1 goes down.
- **Line → timbre / instrument**, one synth voice per line in Tone.js.
- **Interchange coincidence → accent** (or let the chord ring out).
- Mapping is kept in a new `"music"` block in `config.json`, so other cities can reuse the same engine:
  ```json
  "music": {
    "bpm": 96,
    "simSecondsPerBeat": 60,
    "scale": "pentatonic",
    "lines": { "A": { "root": "A3", "instrument": "pluck" }, "H": { "root": "B3", "instrument": "bell" } },
    "percussion": ["PM-C", "PM-S"]
  }
  ```

## User controls
| Control | What it does |
|---|---|
| Play / pause / scrub | Moves the simulated clock (05:00–24:00) |
| **BPM** | Sets the tempo of the quantisation grid. It sets *rhythm feel* separately from how fast the day passes |
| **Speed** (`simSecondsPerBeat`) | How much simulated time passes per beat, i.e. how fast the day goes by |
| **Headway multiplier per line** | Changes **frequency per line**: 0.5× runs twice as many trains, 2× runs half as many. Trips are re-expanded from `frequencies.txt` with `headway_secs × multiplier` |
| Manual headway per line | Overrides the timetable with one fixed headway (e.g. "Line C every 90 s") |
| Mute / solo per line | |
| Service day | Weekday / Saturday / Sunday |
| Event filter | All stations / interchanges only / terminals only |
| Export | MIDI file of the current settings |

## Architecture
Everything runs in the browser and builds on the existing p5 sketch. There is no backend.

```
GTFS (stop_times + frequencies + trips)
   └─► expandTrips(service, headwayMultipliers)  → trips[] with absolute stop times
         └─► buildEvents(filter)                 → sorted [{t, line, stationIdx, dir, stopId}]
               ├─► scheduler (Tone.Transport)    → notes (quantised to BPM grid)
               ├─► p5 draw()                      → trains placed on shapes by sim clock
               └─► exportMidi()                   → .mid (@tonejs/midi)
```
- **Clock:** a single sim clock, `simTime = dayStart + transportSeconds × (simSecondsPerBeat × bpm / 60)`. Sound and visuals both read it, so they stay in sync.
- **Train position:** for each active trip, find the two stops it is between at `simTime`, interpolate between them, and project onto the shape. If `shape_dist_traveled` is present, use it.
- **Libraries:** p5.js (already used), Tone.js for synthesis and scheduling, @tonejs/midi for export. Load them from cdnjs/jsdelivr with pinned versions.
- Code split: keep it simple, but move new logic into `gtfs_time.js` (expansion + events), `music.js` (mapping + Tone) and `ui.js` (controls) rather than growing the single 480-line file.

## Roadmap
**Phase 1: timetable-driven trains (no sound yet)**
- [ ] `expandTrips()` for BA: synthesise trips from `frequencies.txt` + template `stop_times`
- [ ] Sim clock with an on-screen time readout (HH:MM)
- [ ] Replace the random vagons with real trips placed by the clock
- [ ] Sanity check: count trains running per line at 08:00 and compare with headways (Line A at 174 s should show ~9 trains per direction)

**Phase 2: sound**
- [ ] Add Tone.js; a click/key starts audio (browsers block autoplay)
- [ ] `buildEvents()` + scheduler: one note per arrival, using the mapping above
- [ ] Quantise to the BPM grid, merge notes and cap voices; tune until it is listenable at 60×

**Phase 3: controls**
- [ ] DOM panel: BPM, speed, service day, per-line headway multiplier, mute/solo, event filter
- [ ] Changing a headway re-runs `expandTrips()` + `buildEvents()` live

**Phase 4: output and polish**
- [ ] MIDI export ("a day of the Subte")
- [ ] Audio recording (Tone.Recorder → webm) or a screen-recorded video, like the existing `BA.mp4`
- [ ] Generalise to the other cities. CDMX and SDC also have `frequencies.txt`; NYC and BE have full `stop_times` (skip expansion)

## Prior art (credited on [about.html](about.html))
- **Conductor** by Alexander Chen (2011, [mta.me](http://mta.me/)): the NYC subway map as a string instrument, driven by the timetable. The original precedent.
- **AMBA Trenes Sonoros** by Juan Torchia ([demo](https://amba-trenes-sonoros.vercel.app), [repo](https://github.com/JuanTorchia/amba-trenes-sonoros), [write-up](https://dev.to/jtorchia/open-data-and-creativity-how-i-made-buenos-aires-trains-play-music-obg)): Buenos Aires **commuter trains** (static GTFS from datos.gob.ar). It uses Tone.js with one PolySynth per line and the C major pentatonic scale, so simultaneous notes never clash. **The closest precedent.** Worth reading his code before Phase 2.
- **Bondi Sonoro** by Juan Torchia ([demo](https://bondi-sonoro.vercel.app), [repo](https://github.com/JuanTorchia/bondi-sonoro), [write-up](https://dev.to/jtorchia/bondi-sonoro-a-build-log-of-real-data-generative-music-and-the-mtame-mechanic-7g9)): CABA buses with live positions. A route gets plucked when a bus crosses it (the mta.me mechanic), and a global cap of 12 plucks/s answers the same density problem we have.
- **What we add:** the Subte itself (neither project covers it), line letters as note names, BPM and per-line frequency that the listener can edit, and MIDI export.

## Open questions
- Pitch by **station order** (default) or by **geography** (latitude → pitch, north is higher)? It could be a toggle.
- Live GTFS-RT version later? The BA API Transporte exposes Subte realtime and needs a client id/secret. Out of scope until v1 sounds good.
- Should the newer official Subte GTFS replace the 2019 feed? Check whether newer feeds are still frequency-based.
- Should the Premetro (PM-C/PM-S) be percussion or a low drone?

## Status (2026-11-06)
Phases 1–3 are built: timetable trains, sound, controls, any-city GTFS drop and mute/solo. Verified in headless Edge on all five bundled cities and on a dropped zip. BA Line A shows 9 trains per direction at 08:00, as expected.

## Next steps
- [ ] Per-line **headway multiplier** (more or fewer trains), which is still in the plan above
- [ ] MIDI export (@tonejs/midi)
- [ ] Test with a big regional feed (Västtrafik/Gothenburg from Trafiklab) and tune the defaults
- [ ] Event filter (interchanges only / terminals only)
- [ ] Group express variants (e.g. Santiago `L2-L2R`, `L2-L2V`) under one line
