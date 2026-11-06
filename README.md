# Subte Musical: public transport timetables as music

**▶ Live:** https://makijota.github.io/BA_gtfs_01/

Every train that reaches a station plays a note. Each line is a voice, and a full service day plays in a few minutes, with an animated map in sync.

- Pick a bundled city: Buenos Aires Subte, New York Subway, Ciudad de México Metro, Santiago Metro, or a Berlin-area bus sample.
- **Or drop any GTFS `.zip`** (or its `.txt` files) on the page to hear your own city.
- Set the BPM, the speed (simulated minutes per beat), the scale and the melody range.
- For each line, choose a **note**, an **instrument**, **mute** or **solo**.
- You can link straight to a city, e.g. `?city=NYC`, `?city=CDMX`, `?city=SDC`, `?city=BE`.

## How it works
| File | Role |
|---|---|
| [js/gtfs.js](js/gtfs.js) | Loads a GTFS feed and picks a day from the calendar. Expands `frequencies.txt` into real trips, then builds a time-sorted list of station arrivals. Large files are streamed (see [js/csv.js](js/csv.js)) |
| [js/music.js](js/music.js) | Tone.js engine. A 16th-note grid at your BPM walks through the day, and each step plays the arrivals in its slice of time. Pitch = the line's note plus the station's position along the line, mapped onto the scale |
| [BA_gtfs_01.js](BA_gtfs_01.js) | p5.js map: lines, stations and trains placed by the timetable, with a ring flashing at every note |
| [js/app.js](js/app.js) | Left panel, city list, GTFS drop |

Everything runs in the browser and nothing is uploaded.

### Big regional feeds (e.g. Västtrafik / Gothenburg)
Regional feeds include every bus in the region. After loading, buses are unticked by default, and only the busiest 60 lines are kept (change this under *Large feed options*). Gothenburg's trams and ferries make a good orchestra.

## Credits
Built on ideas from [Conductor (mta.me)](http://mta.me/) by Alexander Chen and [AMBA Trenes Sonoros](https://amba-trenes-sonoros.vercel.app) / [Bondi Sonoro](https://bondi-sonoro.vercel.app) by Juan Torchia. See [about.html](about.html).

Made by Jonathan Cohen ([nodalworks.se](https://nodalworks.se/)). If you enjoy it, there's a ☕ coffee button on the site.
