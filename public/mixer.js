// Audio mixer: every input gets a gain, a mute and a meter, and they all sum
// into the one audio track that goes out with the stream.

import { SpeakerMonitor } from './speaker-monitor.js';

export class Mixer {
  constructor() {
    this.ctx = new AudioContext();
    this.out = this.ctx.createMediaStreamDestination();
    this.strips = new Map();
    this.monitorOut = this.ctx.createMediaStreamDestination();
    this.monitor = new SpeakerMonitor(this.monitorOut.stream);
    this.elementSources = new WeakMap();
    this.buffer = new Float32Array(1024);
  }

  /** Audio can only start after a click; call this from one. */
  resume() {
    return this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
  }

  get track() { return this.out.stream.getAudioTracks()[0]; }

  /**
   * Add a stream's audio. `owned` means the mixer opened it and may stop it;
   * a screen share's audio belongs to the screen share, which keeps its video.
   */
  add(id, stream, { label, gain = 1, muted = false, owned = true } = {}) {
    this.remove(id);
    const track = stream.getAudioTracks()[0];
    if (!track) return null;
    const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    return this.addSource(id, source, { label, gain, muted, track, owned });
  }

  addMedia(id, element, options = {}) {
    let source = this.elementSources.get(element);
    if (!source) {
      source = this.ctx.createMediaElementSource(element);
      this.elementSources.set(element, source);
    }
    this.remove(id);
    return this.addSource(id, source, { ...options, owned: false, media: true });
  }

  addSource(id, source, { label, gain = 1, muted = false, track, owned = false, media = false, monitorGain = 0.7, monitor = true }) {
    const gainNode = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(gainNode);
    gainNode.connect(analyser);
    gainNode.connect(this.out);
    const strip = { id, label, gain, muted, source, gainNode, analyser, track, owned, peak: 0, media, blocked: false };
    if (media) {
      strip.monitorGain = monitorGain;
      strip.monitor = monitor;
      strip.monitorNode = this.ctx.createGain();
      source.connect(strip.monitorNode);
      strip.monitorNode.connect(this.monitorOut);
    }
    this.strips.set(id, strip);
    this.apply(strip);
    return strip;
  }

  remove(id) {
    const strip = this.strips.get(id);
    if (!strip) return;
    strip.source.disconnect();
    strip.gainNode.disconnect();
    strip.analyser.disconnect();
    strip.monitorNode?.disconnect();
    if (strip.owned) strip.track.stop();
    this.strips.delete(id);
  }

  set(id, { gain, muted, monitorGain, monitor, blocked }) {
    const strip = this.strips.get(id);
    if (!strip) return;
    if (gain !== undefined) strip.gain = gain;
    if (muted !== undefined) strip.muted = muted;
    if (monitorGain !== undefined) strip.monitorGain = monitorGain;
    if (monitor !== undefined) strip.monitor = monitor;
    if (blocked !== undefined) strip.blocked = blocked;
    this.apply(strip);
  }

  apply(strip) {
    strip.monitorNode?.gain.setTargetAtTime(strip.monitor ? strip.monitorGain : 0, this.ctx.currentTime, 0.01);
    strip.gainNode.gain.setTargetAtTime((strip.muted || strip.blocked) ? 0 : strip.gain, this.ctx.currentTime, 0.01);
  }

  /** Peak level per strip, 0..1, decaying so the meters are readable. */
  levels() {
    const out = {};
    for (const strip of this.strips.values()) {
      strip.analyser.getFloatTimeDomainData(this.buffer);
      let peak = 0;
      for (let i = 0; i < this.buffer.length; i += 2) peak = Math.max(peak, Math.abs(this.buffer[i]));
      strip.peak = Math.max(peak, strip.peak * 0.85);
      out[strip.id] = strip.peak;
    }
    return out;
  }
}

/** Echo cancellation is for microphones; select Raw for a capture card. */
export function openAudioInput(deviceId, mode = 'echo') {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: mode !== 'raw', noiseSuppression: mode !== 'raw', autoGainControl: false,
    },
  });
}
