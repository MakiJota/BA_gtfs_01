// Streaming CSV parser: reads a GTFS text file chunk by chunk, so large feeds
// (hundreds of MB of stop_times) never become one giant string.
const CSV = (() => {
  function splitQuoted(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  // chunks: (async) iterable of Uint8Array. onHeader(string[]), onRow(string[]).
  async function parse(chunks, onHeader, onRow, onProgress) {
    let dec = null; // chosen on the first chunk: UTF-8, or Windows-1252 for legacy feeds
    let rest = '';
    let header = null;
    let bytes = 0, rows = 0, sinceYield = 0;

    const handle = (rec) => {
      if (rec.charCodeAt(rec.length - 1) === 13) rec = rec.slice(0, -1);
      if (!rec) return;
      const f = rec.indexOf('"') === -1 ? rec.split(',') : splitQuoted(rec);
      if (header === null) {
        header = f.map(h => h.replace(/^﻿/, '').trim());
        onHeader(header);
        return;
      }
      rows++;
      onRow(f);
    };

    // Emit every complete record in s (newlines inside quotes don't end a record).
    const consume = (s, final) => {
      let recStart = 0, pos = 0, parity = 0;
      let nq = s.indexOf('"');
      for (;;) {
        const nl = s.indexOf('\n', pos);
        if (nl === -1) break;
        while (nq !== -1 && nq < nl) { parity ^= 1; nq = s.indexOf('"', nq + 1); }
        pos = nl + 1;
        if (!parity) { handle(s.slice(recStart, nl)); recStart = pos; }
      }
      let r = s.slice(recStart);
      if (final && r) { handle(r); r = ''; }
      return r;
    };

    for await (const chunk of chunks) {
      if (!dec) {
        let enc = 'utf-8';
        try { new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(0, Math.max(0, chunk.length - 4))); }
        catch (e) { enc = 'windows-1252'; }
        dec = new TextDecoder(enc);
      }
      bytes += chunk.length;
      sinceYield += chunk.length;
      rest = consume(rest + dec.decode(chunk, { stream: true }), false);
      if (sinceYield > (1 << 22)) {
        sinceYield = 0;
        if (onProgress) onProgress(bytes, rows);
        await new Promise(r => setTimeout(r, 0)); // let the page repaint
      }
    }
    consume(rest + (dec ? dec.decode() : ''), true);
    if (header === null) onHeader([]);
    return rows;
  }

  return { parse, splitQuoted };
})();

if (typeof module !== 'undefined') module.exports = CSV;
