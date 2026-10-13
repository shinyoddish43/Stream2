const $ = (id) => document.getElementById(id);
const stamp = (seconds) => {
  if (!Number.isFinite(seconds)) return '0:00';
  const n = Math.max(0, Math.floor(seconds));
  return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};
export function mediaDefaults(saved = {}) {
  saved = saved && typeof saved === 'object' ? saved : {};
  const level = (n, fallback, max) => Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : fallback;
  const items = (Array.isArray(saved.items) ? saved.items : []).filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string' &&
    typeof t.url === 'string' && (/^\/media\/[a-f0-9]{24}\.(mp3|m4a|ogg|wav|flac|aac|mp4|webm)$/.test(t.url) || /^\/api\/audiobooks\/[\w.-]+\/audio\?file=/.test(t.url))).slice(0, 1200);
  return { items, currentId: items.some((t) => t.id === saved.currentId) ? saved.currentId : items[0]?.id || '',
    gain: level(saved.gain, 0.7, 2), muted: !!saved.muted, monitor: saved.monitor !== false,
    monitorGain: level(saved.monitorGain, 0.7, 1), repeat: !!saved.repeat };
}

export class MediaPlayer {
  constructor({ mixer, state, save, api, changed }) {
    Object.assign(this, { mixer, state, save, api, changed });
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.loadedUrl = '';
    this.request = 0;
    this.playRequest = 0;
    this.searchPage = 1;
    this.query = '';
    this.busy = false;
    this.lastPositionSave = 0;
    for (const event of ['play', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'timeupdate', 'waiting', 'playing', 'error']) {
      this.audio.addEventListener(event, () => {
        if (event === 'loadedmetadata') {
          try {
            const position = Number(localStorage.getItem(`studio-media:${this.loadedUrl}`));
            if (position > 0 && position < this.audio.duration - 1) this.audio.currentTime = position;
          } catch { /* storage may be unavailable */ }
        }
        if (event === 'timeupdate' || event === 'pause') this.rememberPosition(event === 'pause');
        if (event === 'error') this.message('This file could not play. Try Play again, or choose a browser-supported audio format.', true);
        if (event === 'waiting') this.message('Buffering…');
        if (event === 'playing') this.message('Playing · audio goes to the stream');
        if (event === 'pause' && !this.audio.ended) this.message('Paused');
        this.renderTransport();
        if (['play', 'pause', 'ended', 'error'].includes(event)) this.changed();
        if (event === 'ended') {
          try { localStorage.removeItem(`studio-media:${this.loadedUrl}`); } catch { /* unavailable */ }
          this.next(1, true);
        }
      });
    }
    $('mediaPlay').onclick = () => this.audio.paused ? this.play() : this.pause();
    $('mediaBack').onclick = () => this.seek(this.audio.currentTime - 15);
    $('mediaForward').onclick = () => this.seek(this.audio.currentTime + 15);
    $('mediaPrev').onclick = () => this.next(-1);
    $('mediaNext').onclick = () => this.next(1);
    $('mediaSeek').oninput = () => this.seek(Number($('mediaSeek').value));
    $('mediaQueue').onchange = () => this.select($('mediaQueue').value, !this.audio.paused);
    $('mediaRepeat').onchange = () => { this.state().repeat = $('mediaRepeat').checked; this.save(); this.renderTransport(); };
    $('mediaRemove').onclick = () => this.remove();
    $('mediaUpload').onclick = () => $('mediaUploadInput').click();
    $('mediaUploadInput').onchange = () => this.upload([...$('mediaUploadInput').files]);
    $('mediaLibrary').onclick = () => { $('audiobookDialog').showModal(); if (!$('audiobookResults').children.length) this.search('', 1); };
    $('audiobookClose').onclick = () => $('audiobookDialog').close();
    $('audiobookSearch').onsubmit = (event) => { event.preventDefault(); this.search($('audiobookQuery').value.trim(), 1); };
    $('audiobookPrev').onclick = () => this.search(this.query, this.searchPage - 1);
    $('audiobookNext').onclick = () => this.search(this.query, this.searchPage + 1);
    window.addEventListener('pagehide', () => { this.rememberPosition(true); this.pause(); this.mixer.monitor.stop(); });
  }

  get speakersActive() { return !!this.state()?.monitor && this.state().monitorGain > 0 && !this.audio.paused && !this.audio.ended && !this.audio.error; }
  get current() { return this.state().items.find((t) => t.id === this.state().currentId); }

  restore() {
    this.changed();
    if (!this.mixer.strips.has('media')) this.mixer.addMedia('media', this.audio, { label: 'Media player', ...this.state() });
    else this.mixer.set('media', this.state());
    const current = this.current;
    if ((current?.url || '') !== this.loadedUrl) this.load();
    this.render();
    if (!this.audio.paused && this.state().monitor) this.mixer.monitor.start().catch((e) => {
      this.mixer.set('media', { monitor: false });
      this.message(e.message, true);
      this.changed();
    });
  }

  load() {
    this.pause();
    this.loadedUrl = this.current?.url || '';
    if (this.loadedUrl) this.audio.src = this.loadedUrl;
    else this.audio.removeAttribute('src');
    this.audio.load();
    this.message(this.loadedUrl ? 'Ready · press Play to start' : 'Upload media or choose a LibriVox audiobook.');
  }

  select(id, play = false) {
    this.rememberPosition(true);
    this.state().currentId = id;
    this.load();
    this.save();
    this.render();
    if (play) this.play();
  }

  async play() {
    if (!this.current || this.busy) return;
    const request = ++this.playRequest;
    this.busy = true;
    this.renderTransport();
    this.message('Starting audio…');
    try {
      if (this.audio.error) { this.audio.load(); }
      await this.mixer.resume();
      if (this.state().monitor) await this.mixer.monitor.start();
      if (request !== this.playRequest) return;
      await this.audio.play();
    } catch (e) {
      if (request === this.playRequest) this.message(`Playback stopped: ${e.message}`, true);
    } finally {
      this.busy = false;
      this.renderTransport();
      this.changed();
    }
  }

  pause() { this.playRequest++; this.audio.pause(); }

  async setMonitor(enabled) {
    try {
      if (enabled) { await this.mixer.resume(); await this.mixer.monitor.start(); }
      this.state().monitor = enabled;
      // Gate protected microphones before opening the speaker output.
      this.changed();
      this.mixer.set('media', { monitor: enabled });
      this.save();
      this.changed();
    } catch (e) { this.message(e.message, true); this.changed(); }
  }

  next(direction, ended = false) {
    const s = this.state();
    const index = s.items.findIndex((t) => t.id === s.currentId);
    let next = index + direction;
    if (next < 0 || next >= s.items.length) {
      if (!s.repeat || !s.items.length) { if (ended) this.message('Queue finished'); return; }
      next = (next + s.items.length) % s.items.length;
    }
    this.select(s.items[next].id, ended || !this.audio.paused);
  }

  seek(value) {
    if (!Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = Math.max(0, Math.min(this.audio.duration, value));
    this.rememberPosition(true);
    this.renderTransport();
  }

  rememberPosition(force = false) {
    if (!this.loadedUrl || this.audio.ended || (!force && Date.now() - this.lastPositionSave < 5000)) return;
    // Do not replace a saved position with zero before metadata has loaded.
    if (this.audio.readyState < 1) return;
    try { localStorage.setItem(`studio-media:${this.loadedUrl}`, String(this.audio.currentTime)); } catch { /* unavailable */ }
    this.lastPositionSave = Date.now();
  }

  remove() {
    const s = this.state(), index = s.items.findIndex((t) => t.id === s.currentId);
    if (index < 0) return;
    s.items.splice(index, 1);
    this.select(s.items[Math.min(index, s.items.length - 1)]?.id || '');
  }

  message(text, error = false) {
    $('mediaStatus').textContent = text;
    $('mediaStatus').classList.toggle('error', error);
  }

  render() {
    const s = this.state();
    $('mediaQueue').replaceChildren(...s.items.map((t) => Object.assign(document.createElement('option'), { value: t.id, textContent: t.title })));
    if (!s.items.length) $('mediaQueue').append(Object.assign(document.createElement('option'), { textContent: 'Nothing queued' }));
    $('mediaQueue').value = s.currentId;
    $('mediaQueue').disabled = !s.items.length;
    $('mediaRepeat').checked = s.repeat;
    $('mediaTitle').textContent = this.current?.book || this.current?.title || 'Background audio';
    $('mediaTitle').title = $('mediaTitle').textContent;
    this.renderTransport();
  }

  renderTransport() {
    const ready = !!this.current;
    $('mediaPlay').textContent = this.busy ? 'Starting…' : this.audio.paused ? 'Play' : 'Pause';
    $('mediaPlay').disabled = !ready || this.busy;
    for (const id of ['mediaBack', 'mediaForward', 'mediaRemove']) $(id).disabled = !ready;
    const index = this.state().items.findIndex((t) => t.id === this.state().currentId);
    $('mediaPrev').disabled = !ready || (!this.state().repeat && index <= 0);
    $('mediaNext').disabled = !ready || (!this.state().repeat && index >= this.state().items.length - 1);
    const duration = this.audio.duration;
    $('mediaSeek').max = Number.isFinite(duration) ? duration : 0;
    $('mediaSeek').value = this.audio.currentTime;
    $('mediaSeek').disabled = !Number.isFinite(duration) || duration <= 0;
    $('mediaTime').textContent = `${stamp(this.audio.currentTime)} / ${stamp(duration)}`;
  }

  async upload(files) {
    $('mediaUpload').disabled = true;
    let failure = '';
    const types = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', mp4: 'video/mp4', webm: 'video/webm' };
    try {
      for (const file of files) {
        if (this.state().items.length >= 1200) throw new Error('The queue is full. Remove a track before uploading more.');
        const type = types[file.name.split('.').pop().toLowerCase()];
        if (!type || !this.audio.canPlayType(type)) throw new Error(`This browser cannot play ${file.name}. Try MP3, M4A, WAV, or WebM.`);
        this.message(`Uploading ${file.name}…`);
        const { url } = await this.api('/api/media', { method: 'POST', body: file, headers: { 'Content-Type': type } });
        const s = this.state();
        const item = { id: crypto.randomUUID(), title: file.name, url };
        s.items.push(item);
        if (!s.currentId) this.select(item.id);
        else { this.save(); this.render(); }
      }
    } catch (e) { failure = e.message; }
    finally { $('mediaUpload').disabled = false; $('mediaUploadInput').value = ''; }
    this.message(failure || 'Uploaded · choose a track and press Play', !!failure);
  }

  async search(query, page) {
    const request = ++this.request;
    this.query = query;
    this.searchPage = page;
    $('audiobookStatus').textContent = 'Searching LibriVox…';
    $('audiobookResults').replaceChildren();
    $('audiobookPrev').disabled = $('audiobookNext').disabled = true;
    try {
      const data = await this.api(`/api/audiobooks?q=${encodeURIComponent(query)}&page=${page}`);
      if (request !== this.request) return;
      $('audiobookStatus').textContent = data.books.length ? `${data.total.toLocaleString()} books · page ${page}` : 'No books found. Try a different title or author.';
      $('audiobookPrev').disabled = page <= 1;
      $('audiobookNext').disabled = page * 12 >= data.total;
      for (const book of data.books) {
        const card = document.createElement('li');
        const details = document.createElement('div');
        details.append(Object.assign(document.createElement('strong'), { textContent: book.title }), Object.assign(document.createElement('span'), { textContent: [book.author, book.language].filter(Boolean).join(' · ') }));
        const button = Object.assign(document.createElement('button'), { textContent: 'Add book' });
        button.onclick = () => this.addBook(book.id, button);
        card.append(details, button);
        $('audiobookResults').append(card);
      }
    } catch (e) { if (request === this.request) $('audiobookStatus').textContent = `${e.message} Search again to retry.`; }
  }

  async addBook(id, button) {
    button.disabled = true;
    button.textContent = 'Loading…';
    try {
      const book = await this.api(`/api/audiobooks/${encodeURIComponent(id)}`);
      const s = this.state();
      const newTracks = book.tracks.filter((t) => !s.items.some((item) => item.id === t.id));
      if (newTracks.length + s.items.length > 1200) throw new Error('The queue is full. Remove tracks before adding this book.');
      s.items.push(...newTracks.map(({ id, title, url }) => ({ id, title, url, book: book.title })));
      this.select(book.tracks[0].id);
      $('audiobookDialog').close();
      this.message(`${book.tracks.length} chapters ready · press Play`);
    } catch (e) { $('audiobookStatus').textContent = e.message; }
    finally { button.disabled = false; button.textContent = 'Add book'; }
  }
}
