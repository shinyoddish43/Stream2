// Audio mixer: every input gets a gain, a mute and a meter, and they all sum
// into the one audio track that goes out with the stream.

export class Mixer {
  constructor() {
    this.ctx = new AudioContext();
    this.out = this.ctx.createMediaStreamDestination();
    this.strips = new Map();
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
    const gainNode = this.ctx.createGain();   // the volume slider
    const muteNode = this.ctx.createGain();   // the mute button
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    // The meter reads after the volume but before the mute, so a muted input
    // still shows that it is alive.
    source.connect(gainNode);
    gainNode.connect(analyser);
    gainNode.connect(muteNode);
    muteNode.connect(this.out);
    const strip = { id, label, gain, muted, source, gainNode, muteNode, analyser, track, owned, peak: 0 };
    this.strips.set(id, strip);
    this.apply(strip);
    return strip;
  }

  remove(id) {
    const strip = this.strips.get(id);
    if (!strip) return;
    strip.source.disconnect();
    strip.gainNode.disconnect();
    strip.muteNode.disconnect();
    if (strip.owned) strip.track.stop();
    this.strips.delete(id);
  }

  set(id, { gain, muted }) {
    const strip = this.strips.get(id);
    if (!strip) return;
    if (gain !== undefined) strip.gain = gain;
    if (muted !== undefined) strip.muted = muted;
    this.apply(strip);
  }

  apply(strip) {
    strip.gainNode.gain.setTargetAtTime(strip.gain, this.ctx.currentTime, 0.01);
    strip.muteNode.gain.setTargetAtTime(strip.muted ? 0 : 1, this.ctx.currentTime, 0.01);
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

/** Open an audio input with nothing applied: capture-card audio and a stream
 *  mic both want the raw signal, not a video-call filter. "default" is the
 *  default microphone of this browser and device, whichever that is. Other
 *  device ids differ between browsers and devices, so one saved elsewhere is
 *  found by its name; never by guessing, which could put the wrong microphone
 *  on stream. */
export async function openAudioInput(deviceId, label) {
  const open = (id) => navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: id ? { exact: id } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    },
  });
  if (!deviceId || deviceId === 'default') return open(undefined);
  try {
    return await open(deviceId);
  } catch (e) {
    if (!deviceId || !label || !['OverconstrainedError', 'NotFoundError'].includes(e.name)) throw e;
    const same = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.label === label && d.deviceId !== deviceId);
    if (!same) throw e;
    return open(same.deviceId);
  }
}
