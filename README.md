# Subte Musical: public transport timetables as music

**▶ Live:** https://makijota.github.io/BA_gtfs_01/

Every train that reaches a station plays a note. Each line is a voice, and a full service day plays in a few minutes, with an animated map in sync.

- Pick a bundled city: Buenos Aires Subte, New York Subway, Ciudad de México Metro, Santiago Metro, or a Berlin-area bus sample.
- **Or drop any GTFS `.zip`** (or its `.txt` files) on the page to hear your own city.
- Set the BPM, the speed (simulated minutes per beat), the scale and the melody range.
- **Play the day** (the whole service day) or **Play a moment**, which loops a 10 min – 2 h window around the time you pick, to compare 7 am with 3 pm.
- For each line, choose a **note**, an **instrument** and sound on/off. All lines start muted, so you build the music up.
- **Trains per line** (`− n +`): a timetable line shows its average number of trains around the current time. Pressing ± (or clicking the line on the map) switches it to exactly *n* evenly spaced trains all day. *Reset trains* goes back to the timetable.
- Trains travel along the real track shapes. Data gaps are skipped, never estimated: a stop with no time or no coordinates plays no note.
- **Save & share:** *Copy link* puts the whole setup in the URL, and *Save .maki* / *Load .maki* store it as a small JSON file.
- Light and dark mode. The credits page is in English and Spanish.
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
