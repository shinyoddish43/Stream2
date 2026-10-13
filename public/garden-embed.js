// Garden receives only bounded session status. All capture/broadcast controls
// remain deliberate interactions in this owner-authenticated studio.
export const GARDEN_ORIGIN = 'https://mognet.six7.pw';
export const PROTOCOL = 'garden-fstream-v1';
export function validGardenMessage(event, parent, origin, session) {
  const m = event.data;
  return origin === GARDEN_ORIGIN && event.origin === origin && event.source === parent &&
    m?.type === PROTOCOL && ['hello','status','visibility'].includes(m.kind) &&
    typeof m.session === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(m.session) &&
    (!session ? m.kind === 'hello' : m.session === session) && (m.kind !== 'visibility' || typeof m.visible === 'boolean') && Object.keys(m).every(k => ['type','kind','session',...(m.kind === 'visibility' ? ['visible'] : [])].includes(k));
}
export function createGardenEmbed({origin, getStatus, onVisibility = () => {}, win = window}) {
  if (origin !== GARDEN_ORIGIN || win.parent === win || new URLSearchParams(win.location.search).get('garden') !== '1') return {destroy(){}};
  let session = '', timer;
  const send = () => {
    if (!session) return;
    const s = getStatus();
    win.parent.postMessage({type:PROTOCOL,kind:'status',session,
      capture:!!s.capture,broadcast:!!s.broadcast,audio:!!s.audio,
      state:['ready','connecting','live','offline','error','auth-required'].includes(s.state)?s.state:'ready',
      seconds:Math.max(0,Math.min(1e9-1,Number(s.seconds)||0)),kbps:Math.max(0,Math.min(1e7-1,Number(s.kbps)||0))}, origin);
  };
  const receive = event => {
    if (!validGardenMessage(event,win.parent,origin,session)) return;
    session = event.data.session;
    if (event.data.kind === 'visibility') onVisibility(event.data.visible);
    send();
    if (!timer) timer = win.setInterval(send,2000);
  };
  win.addEventListener('message',receive);
  return {destroy(){win.removeEventListener('message',receive);if(timer)win.clearInterval(timer);}};
}
