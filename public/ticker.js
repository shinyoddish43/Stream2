// Frame clock for when the tab is hidden: worker timers are not throttled the
// way the page's own timers are. One tick at a time — the page asks for the
// next one after it has drawn — so a slow frame lowers the frame rate instead
// of piling up a backlog that would starve the stream. 0 stops it.
let timer;
onmessage = (e) => {
  clearTimeout(timer);
  if (e.data > 0) timer = setTimeout(() => postMessage(0), e.data);
};
