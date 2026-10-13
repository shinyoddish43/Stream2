import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { startServer, login } from './helpers.mjs';
const { createLibrary } = createRequire(import.meta.url)('../audiobooks.js');
const response = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const metadata = (extra = {}) => ({ metadata: { collection: ['librivoxaudio'], mediatype: 'audio', title: 'A book', creator: 'An author' }, files: [
  { name: 'chapter10.mp3', source: 'original', track: '10/10' },
  { name: 'chapter2.mp3', source: 'original', track: '2/10' },
  { name: 'chapter2_64kb.mp3', source: 'derivative', track: '2/10' },
  { name: 'cover.jpg', source: 'original' },
  { name: '../private.mp3', source: 'original' },
  { name: 'private.mp3', source: 'original', private: true },
], ...extra });

test('search is restricted to LibriVox, escapes user query syntax, caches, and paginates', async () => {
  let calls = 0;
  const library = createLibrary(async (url) => {
    calls++;
    assert.equal(url.hostname, 'archive.org');
    assert.match(url.searchParams.get('q'), /^collection:librivoxaudio AND mediatype:audio AND/);
    assert.ok(!url.searchParams.get('q').includes('OR collection:other'));
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('rows'), '12');
    return response({ response: { numFound: 30, docs: [{ identifier: 'book', title: 'Title', creator: ['One', 'Two'] }, { identifier: '../bad' }] } });
  });
  const result = await library.search('Alice OR collection:other', 2);
  assert.equal(result.books.length, 1);
  assert.equal(result.books[0].author, 'One, Two');
  assert.deepEqual(await library.search('Alice OR collection:other', 2), result);
  assert.equal(calls, 1);
  await assert.rejects(library.search('x'.repeat(121)), { status: 400 });
  await assert.rejects(library.search('Alice', 1.5), { status: 400 });
});

test('chapters are ordered numerically without duplicate encodings or unsafe files', async () => {
  const library = createLibrary(async () => response(metadata()));
  const book = await library.book('book');
  assert.deepEqual(book.tracks.map((t) => t.file), ['chapter2.mp3', 'chapter10.mp3']);
  assert.equal(book.tracks[0].url, '/api/audiobooks/book/audio?file=chapter2.mp3');
  await assert.rejects(library.book('../bad'), { status: 400 });
});

test('non-LibriVox, restricted, missing, and unplayable items are rejected', async () => {
  for (const value of [[], metadata({ metadata: { collection: ['opensource_audio'], mediatype: 'audio' } }), metadata({ metadata: { collection: 'librivoxaudio', mediatype: 'audio', access_restricted: 'true' } }), metadata({ files: [] })]) {
    await assert.rejects(createLibrary(async () => response(value)).book('book'), { status: 404 });
  }
});

test('library failures do not poison the cache and redirects cannot escape Archive HTTPS', async () => {
  let calls = 0;
  const library = createLibrary(async () => ++calls === 1 ? new Response('', { status: 503 }) : response(metadata()));
  await assert.rejects(library.book('book'), { status: 502 });
  assert.equal((await library.book('book')).title, 'A book');
  for (const location of ['https://archive.org.evil.test/audio', 'http://127.0.0.1/private', 'https://archive.org:8443/private', 'https://user:pass@archive.org/private']) {
    let redirects = 0;
    const blocked = createLibrary(async () => { redirects++; return new Response(null, { status: 302, headers: { location } }); });
    await assert.rejects(blocked.book('book'), { status: 502 });
    assert.equal(redirects, 1);
  }
});

test('chapter streaming preserves ranges and never accepts unlisted files or arbitrary URLs', async () => {
  let downloads = 0;
  const library = createLibrary(async (url, opts) => {
    if (url.pathname.startsWith('/metadata/')) return response(metadata());
    downloads++;
    assert.equal(url.href, 'https://archive.org/download/book/chapter2.mp3');
    assert.deepEqual(opts.headers, { Range: 'bytes=2-5' });
    return new Response('CDEF', { status: 206, headers: { 'content-length': '4', 'content-range': 'bytes 2-5/10' } });
  });
  const res = new PassThrough();
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  await library.audio({ headers: { range: 'bytes=2-5' } }, res, 'book', 'chapter2.mp3');
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], 'bytes 2-5/10');
  assert.equal(Buffer.concat(chunks).toString(), 'CDEF');
  await assert.rejects(library.audio({ headers: {} }, new PassThrough(), 'book', 'https://evil.test/a.mp3'), { status: 404 });
  await assert.rejects(library.audio({ headers: { range: 'bytes=0-1,4-5' } }, new PassThrough(), 'book', 'chapter2.mp3'), { status: 416 });
  assert.equal(downloads, 1);
});

test('audio uploads, range playback, catalog auth, and saved queue retention work through the server', async () => {
  const server = await startServer();
  try {
    const api = await login(server.url);
    assert.equal((await fetch(`${server.url}/api/audiobooks`)).status, 401);
    assert.equal((await api('/api/audiobooks?page=0')).status, 400);
    for (const [type, ext] of [['audio/mpeg', 'mp3'], ['audio/mp4', 'm4a'], ['audio/ogg', 'ogg'], ['audio/wav', 'wav'], ['audio/flac', 'flac'], ['audio/aac', 'aac'], ['video/webm', 'webm']]) {
      const upload = await api('/api/media', { method: 'POST', body: Buffer.from('0123456789'), headers: { 'Content-Type': type } });
      assert.equal(upload.status, 200);
      const { url } = await upload.json();
      assert.ok(url.endsWith(`.${ext}`));
      const part = await api(url, { headers: { Range: 'bytes=2-5' } });
      assert.equal(part.status, 206);
      assert.equal(await part.text(), '2345');
      const { layouts } = await (await api('/api/state')).json();
      assert.equal((await api('/api/layouts', { method: 'PUT', body: JSON.stringify({ layouts: [{ id: 'a', sources: [] }], revision: layouts?.revision || 0, media: { items: [{ id: ext, title: ext, url }] } }) })).status, 200);
      assert.equal((await (await api('/api/state')).json()).layouts.media.items[0].url, url);
    }
  } finally { server.stop(); }
});
