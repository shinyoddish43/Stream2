'use strict';

// Only the public LibriVox collection is exposed. No client-supplied upstream
// URLs or credentials are forwarded; audio is streamed, never buffered in RAM.
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v) => (Array.isArray(v) ? v.join(', ') : String(v || '')).slice(0, 500);

function createLibrary(fetcher = fetch) {
  const cache = new Map();
  async function cached(key, get) {
    const old = cache.get(key);
    if (old && old.expires > Date.now()) return old.value;
    const entry = { expires: Date.now() + 5 * 60e3, value: Promise.resolve().then(get) };
    cache.set(key, entry);
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    try { return await entry.value; } catch (e) { if (cache.get(key) === entry) cache.delete(key); throw e; }
  }
  async function request(url, options = {}) {
    // Archive downloads redirect to its storage hosts. Validate every hop.
    for (let i = 0; i < 6; i++) {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.port || u.username || u.password ||
          !(u.hostname === 'archive.org' || u.hostname.endsWith('.archive.org'))) throw fail(502, 'Invalid library redirect.');
      let res;
      try { res = await fetcher(u, { ...options, redirect: 'manual' }); }
      catch { throw fail(502, 'The audiobook library is unavailable. Try again shortly.'); }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const location = res.headers.get('location');
        if (!location) throw fail(502, 'Invalid library redirect.');
        url = new URL(location, u).href;
        continue;
      }
      return res;
    }
    throw fail(502, 'Too many library redirects.');
  }
  async function json(url) {
    const res = await request(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { await res.body?.cancel(); throw fail(502, 'The audiobook library is unavailable. Try again shortly.'); }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('Library response too large');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch { throw fail(502, 'Could not read the audiobook library. Try again.'); }
  }
  async function search(query = '', page = 1) {
    if (query.length > 120 || !Number.isInteger(page) || page < 1 || page > 1000) throw fail(400, 'Invalid audiobook search.');
    const words = query.match(/[\p{L}\p{N}]+/gu) || [];
    const q = 'collection:librivoxaudio AND mediatype:audio' + words.map((w) => ` AND (title:${w}* OR creator:${w}*)`).join('');
    const url = new URL('https://archive.org/advancedsearch.php');
    url.search = new URLSearchParams({ q, output: 'json', rows: '12', page: String(page) });
    for (const field of ['identifier', 'title', 'creator', 'language']) url.searchParams.append('fl[]', field);
    url.searchParams.append('sort[]', query.trim() ? 'downloads desc' : 'addeddate desc');
    return cached(url.href, async () => {
      const data = await json(url);
      if (!Array.isArray(data.response?.docs)) throw fail(502, 'Could not read the audiobook catalog.');
      return { total: Number(data.response.numFound) || 0, page, books: data.response.docs.filter((b) => ID.test(b.identifier)).map((b) => ({
        id: b.identifier, title: text(b.title) || b.identifier, author: text(b.creator), language: text(b.language),
      })) };
    });
  }
  async function book(id) {
    if (!ID.test(id)) throw fail(400, 'Invalid audiobook.');
    return cached(`book:${id}`, async () => {
      const data = await json(`https://archive.org/metadata/${encodeURIComponent(id)}`);
      const meta = data.metadata || {};
      const collections = [].concat(meta.collection || []);
      if (!collections.includes('librivoxaudio') || meta.mediatype !== 'audio' || meta.access_restricted === true || meta.access_restricted === 'true') throw fail(404, 'This public-domain audiobook is unavailable.');
      let files = (data.files || []).filter((f) => typeof f.name === 'string' && /\.mp3$/i.test(f.name) && !f.private && !f.name.split('/').some((part) => part === '..' || part === '.') && !/[\\\x00-\x1f]/.test(f.name));
      // Prefer the original MP3 edition to avoid playing a second, derived copy
      // of every chapter (for example both 64 kbps and 128 kbps files).
      const originals = files.filter((f) => f.source === 'original');
      if (originals.length) files = originals;
      else {
        const format = files.some((f) => f.format === '128Kbps MP3') ? '128Kbps MP3' : files[0]?.format;
        files = files.filter((f) => f.format === format);
      }
      files.sort((a, b) => {
        const aTrack = parseInt(a.track), bTrack = parseInt(b.track);
        return (Number.isFinite(aTrack) && Number.isFinite(bTrack) && aTrack - bTrack) || a.name.localeCompare(b.name, 'en', { numeric: true });
      });
      if (!files.length) throw fail(404, 'This audiobook has no playable MP3 chapters.');
      return { id, title: text(meta.title) || id, author: text(meta.creator), source: `https://archive.org/details/${id}`,
        tracks: files.slice(0, 1000).map((f, index) => ({ id: `${id}:${index}`, title: text(f.title) || f.name.replace(/\.mp3$/i, '').replace(/_/g, ' '),
          file: f.name, url: `/api/audiobooks/${encodeURIComponent(id)}/audio?file=${encodeURIComponent(f.name)}` })) };
    });
  }
  async function audio(req, res, id, file) {
    const details = await book(id);
    if (!details.tracks.some((t) => t.file === file)) throw fail(404, 'Chapter not found.');
    if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range)) throw fail(416, 'Invalid audio range.');
    const abort = new AbortController();
    const close = () => abort.abort();
    res.once('close', close);
    const timeout = setTimeout(close, 20000);
    try {
      const url = `https://archive.org/download/${encodeURIComponent(id)}/${file.split('/').map(encodeURIComponent).join('/')}`;
      const upstream = await request(url, { signal: abort.signal, headers: req.headers.range ? { Range: req.headers.range } : {} });
      clearTimeout(timeout);
      if (![200, 206, 416].includes(upstream.status)) { await upstream.body?.cancel(); throw fail(502, 'This chapter could not be loaded. Try again.'); }
      const headers = { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes' };
      for (const h of ['content-length', 'content-range']) if (upstream.headers.has(h)) headers[h] = upstream.headers.get(h);
      res.writeHead(upstream.status, headers);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
      else res.end();
    } catch (e) {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) throw e;
    } finally { clearTimeout(timeout); res.off('close', close); }
  }
  return { search, book, audio };
}
module.exports = { createLibrary };
