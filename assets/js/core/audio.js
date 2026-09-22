// Audio mixer.
//
// Every audio track — desktop capture, microphone, media files — lands on its
// own strip with a gain node, a mute, and a meter, and they sum into one
// MediaStreamTrack that the recorder or the stream consumes. The meters run
// off a single analyser poll at 15 Hz rather than one rAF loop per strip,
// because on a weak CPU the metering is otherwise the most expensive thing on
// the page.

import { bus, clamp, uid } from './util.js';

const METER_HZ = 15;

export class Mixer {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.destination = null;
    this.strips = new Map();     // id -> strip
    this.meterHandle = null;
    this.buffer = null;
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('This browser has no Web Audio support.');
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.destination = this.ctx.createMediaStreamDestination();
    this.master.connect(this.destination);
    this.buffer = new Float32Array(1024);
    this.startMetering();
    return this.ctx;
  }

  resume() {
    // Browsers suspend audio until a gesture; call this from a click handler.
    if (this.ctx && this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  }

  get outputTrack() {
    this.ensureContext();
    return this.destination.stream.getAudioTracks()[0] || null;
  }

  /** Add a live MediaStream (mic, desktop audio, media element) as a strip. */
  addStream(stream, { id, name = 'Audio', kind = 'input', gain = 1, muted = false } = {}) {
    this.ensureContext();
    const tracks = stream.getAudioTracks();
    if (!tracks.length) return null;
    const stripId = id || uid('au');
    this.removeStrip(stripId);
    const source = this.ctx.createMediaStreamSource(new MediaStream([tracks[0]]));
    return this.wire(stripId, source, { name, kind, gain, muted, stream });
  }

  /** Add a <video>/<audio> element's output as a strip. */
  addElement(element, { id, name = 'Media', gain = 1, muted = false } = {}) {
    this.ensureContext();
    const stripId = id || uid('au');
    this.removeStrip(stripId);
    let source;
    try {
      source = this.ctx.createMediaElementSource(element);
    } catch (e) {
      // An element can only be wired once; reuse the existing strip if so.
      return this.strips.get(stripId) || null;
    }
    return this.wire(stripId, source, { name, kind: 'media', gain, muted, element });
  }

  wire(id, node, meta) {
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = meta.muted ? 0 : clamp(meta.gain, 0, 2);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    node.connect(gainNode);
    gainNode.connect(analyser);
    gainNode.connect(this.master);
    const strip = {
      id, node, gainNode, analyser,
      name: meta.name, kind: meta.kind,
      gain: clamp(meta.gain, 0, 2), muted: !!meta.muted,
      peak: 0, rms: 0, stream: meta.stream, element: meta.element,
    };
    this.strips.set(id, strip);
    bus.emit('mixer:changed', this.list());
    return strip;
  }

  removeStrip(id) {
    const strip = this.strips.get(id);
    if (!strip) return;
    try { strip.node.disconnect(); strip.gainNode.disconnect(); strip.analyser.disconnect(); } catch (e) {}
    if (strip.stream) for (const track of strip.stream.getTracks()) track.stop();
    this.strips.delete(id);
    bus.emit('mixer:changed', this.list());
  }

  setGain(id, value) {
    const strip = this.strips.get(id);
    if (!strip) return;
    strip.gain = clamp(Number(value), 0, 2);
    if (!strip.muted) strip.gainNode.gain.setTargetAtTime(strip.gain, this.ctx.currentTime, 0.01);
    bus.emit('mixer:changed', this.list());
  }

  setMuted(id, muted) {
    const strip = this.strips.get(id);
    if (!strip) return;
    strip.muted = !!muted;
    strip.gainNode.gain.setTargetAtTime(strip.muted ? 0 : strip.gain, this.ctx.currentTime, 0.01);
    bus.emit('mixer:changed', this.list());
  }

  rename(id, name) {
    const strip = this.strips.get(id);
    if (strip) { strip.name = name; bus.emit('mixer:changed', this.list()); }
  }

  setMaster(value) {
    this.ensureContext();
    this.master.gain.setTargetAtTime(clamp(Number(value), 0, 2), this.ctx.currentTime, 0.01);
  }

  list() {
    return Array.from(this.strips.values()).map((s) => ({
      id: s.id, name: s.name, kind: s.kind, gain: s.gain, muted: s.muted, peak: s.peak, rms: s.rms,
    }));
  }

  startMetering() {
    if (this.meterHandle) return;
    this.meterHandle = setInterval(() => {
      if (!this.strips.size) return;
      const levels = [];
      for (const strip of this.strips.values()) {
        strip.analyser.getFloatTimeDomainData(this.buffer);
        let peak = 0;
        let sum = 0;
        for (let i = 0; i < this.buffer.length; i += 2) {   // every other sample is plenty
          const v = Math.abs(this.buffer[i]);
          if (v > peak) peak = v;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / (this.buffer.length / 2));
        // Decay the peak rather than snapping, so the meter is readable.
        strip.peak = Math.max(peak, strip.peak * 0.82);
        strip.rms = rms;
        levels.push({ id: strip.id, peak: strip.peak, rms, db: toDb(strip.peak) });
      }
      bus.emit('mixer:levels', levels);
    }, 1000 / METER_HZ);
  }

  stop() {
    clearInterval(this.meterHandle);
    this.meterHandle = null;
    for (const id of Array.from(this.strips.keys())) this.removeStrip(id);
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
  }
}

export const toDb = (amplitude) => (amplitude <= 0.0001 ? -Infinity : 20 * Math.log10(amplitude));
export const dbToAmp = (db) => Math.pow(10, db / 20);

export async function listAudioInputs() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

export async function openMicrophone(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,     // a stream mic wants the raw signal
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
}

export const mixer = new Mixer();
