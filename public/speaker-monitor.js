// A local WebRTC receive track gives the browser's echo canceller a playback
// reference, including browsers that do not cancel ordinary Web Audio output.
// No signaling server, STUN server, or remote peer is used. Only media enters
// this monitor; microphone audio is never connected to the speakers.
export class SpeakerMonitor {
  constructor(stream) {
    this.stream = stream;
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.audio.setAttribute('playsinline', '');
    this.ready = null;
  }

  async start() {
    if (!this.ready) this.ready = this.connect().catch((e) => { this.stop(); throw e; });
    await this.ready;
    await this.audio.play();
  }

  async connect() {
    const sender = this.sender = new RTCPeerConnection({ iceServers: [] });
    const receiver = this.receiver = new RTCPeerConnection({ iceServers: [] });
    const pendingSender = [], pendingReceiver = [];
    sender.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      if (receiver.remoteDescription) receiver.addIceCandidate(candidate).catch(() => {});
      else pendingReceiver.push(candidate);
    };
    receiver.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      if (sender.remoteDescription) sender.addIceCandidate(candidate).catch(() => {});
      else pendingSender.push(candidate);
    };
    receiver.ontrack = ({ streams }) => { this.audio.srcObject = streams[0]; };
    for (const track of this.stream.getAudioTracks()) sender.addTrack(track, this.stream);
    let timer;
    try {
      await Promise.race([
        (async () => {
          await sender.setLocalDescription(await sender.createOffer());
          await receiver.setRemoteDescription(sender.localDescription);
          for (const candidate of pendingReceiver) await receiver.addIceCandidate(candidate);
          await receiver.setLocalDescription(await receiver.createAnswer());
          await sender.setRemoteDescription(receiver.localDescription);
          for (const candidate of pendingSender) await sender.addIceCandidate(candidate);
          await new Promise((resolve, reject) => {
            receiver.onconnectionstatechange = () => {
              if (receiver.connectionState === 'connected') resolve();
              else if (['failed', 'closed'].includes(receiver.connectionState)) reject(new Error('Speaker monitoring could not connect.'));
            };
            receiver.onconnectionstatechange();
          });
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Speaker monitoring timed out. Try Play again, or turn speakers off.')), 8000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  stop() {
    this.audio.pause();
    this.audio.srcObject = null;
    this.sender?.close();
    this.receiver?.close();
    this.ready = null;
  }
}
