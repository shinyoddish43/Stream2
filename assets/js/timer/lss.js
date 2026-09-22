// LiveSplit .lss in the browser: parse what LiveSplit wrote, write back
// something LiveSplit will happily open again.

export function parseLssTime(text) {
  if (!text) return null;
  let s = String(text).trim();
  if (!s) return null;
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1); }
  let days = 0;
  const dayMatch = /^(\d+)\.(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  if (dayMatch) { days = parseInt(dayMatch[1], 10); s = dayMatch[2]; }
  let total = 0;
  for (const part of s.split(':')) total = total * 60 + parseFloat(part || '0');
  if (!isFinite(total)) return null;
  return sign * (total + days * 86400);
}

export function formatLssTime(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return null;
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = (sec < 10 ? '0' : '') + sec.toFixed(7);
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${secStr}`;
}

const text = (node, tag) => {
  const child = node && node.getElementsByTagName(tag)[0];
  return child ? child.textContent : '';
};

/** XML string -> the studio's run shape. Throws on anything that is not a Run. */
export function parseLss(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('that file is not valid XML');
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'Run') throw new Error('not a LiveSplit splits file (<Run> expected)');

  const metadata = root.getElementsByTagName('Metadata')[0];
  const variables = {};
  if (metadata) {
    const varsHost = metadata.getElementsByTagName('Variables')[0];
    if (varsHost) {
      for (const v of Array.from(varsHost.getElementsByTagName('Variable'))) {
        variables[v.getAttribute('name') || ''] = v.textContent;
      }
    }
  }

  const segments = [];
  const segHost = root.getElementsByTagName('Segments')[0];
  if (segHost) {
    for (const seg of Array.from(segHost.getElementsByTagName('Segment'))) {
      const comparisons = {};
      let pb = null;
      const splitHost = seg.getElementsByTagName('SplitTimes')[0];
      if (splitHost) {
        for (const st of Array.from(splitHost.getElementsByTagName('SplitTime'))) {
          const name = st.getAttribute('name') || '';
          const value = parseLssTime(text(st, 'RealTime'));
          if (name === 'Personal Best') pb = value;
          else if (value !== null) comparisons[name] = value;
        }
      }
      const bestHost = seg.getElementsByTagName('BestSegmentTime')[0];
      segments.push({
        name: text(seg, 'Name') || `Split ${segments.length + 1}`,
        pb,
        best: bestHost ? parseLssTime(text(bestHost, 'RealTime')) : null,
        comparisons,
      });
    }
  }

  const history = [];
  const histHost = root.getElementsByTagName('AttemptHistory')[0];
  if (histHost) {
    for (const att of Array.from(histHost.getElementsByTagName('Attempt'))) {
      history.push({
        id: parseInt(att.getAttribute('id') || '0', 10),
        started: att.getAttribute('started') || '',
        ended: att.getAttribute('ended') || '',
        real: parseLssTime(text(att, 'RealTime')),
      });
    }
  }

  const run = {
    game: text(root, 'GameName'),
    category: text(root, 'CategoryName'),
    offset: parseLssTime(text(root, 'Offset')) || 0,
    attempts: parseInt(text(root, 'AttemptCount') || '0', 10) || 0,
    platform: metadata ? text(metadata, 'Platform') : '',
    region: metadata ? text(metadata, 'Region') : '',
    variables,
    segments,
    history: history.slice(-500),
  };
  run.pbTime = segments.length ? segments[segments.length - 1].pb : null;
  return run;
}

/** The studio's run shape -> .lss XML text. */
export function buildLss(run) {
  const doc = document.implementation.createDocument('', 'Run', null);
  const root = doc.documentElement;
  root.setAttribute('version', '1.7.0');

  const add = (parent, tag, value) => {
    const node = doc.createElement(tag);
    if (value !== null && value !== undefined && value !== '') node.textContent = String(value);
    parent.appendChild(node);
    return node;
  };

  add(root, 'GameIcon', '');
  add(root, 'GameName', run.game || '');
  add(root, 'CategoryName', run.category || '');

  const meta = add(root, 'Metadata', '');
  add(meta, 'Run', '').setAttribute('id', '');
  const platform = add(meta, 'Platform', run.platform || '');
  platform.setAttribute('usesEmulator', 'False');
  add(meta, 'Region', run.region || '');
  const vars = add(meta, 'Variables', '');
  for (const [k, v] of Object.entries(run.variables || {})) {
    add(vars, 'Variable', v).setAttribute('name', k);
  }

  add(root, 'Offset', formatLssTime(run.offset || 0));
  add(root, 'AttemptCount', String(run.attempts || 0));

  const history = add(root, 'AttemptHistory', '');
  for (const att of run.history || []) {
    const node = doc.createElement('Attempt');
    node.setAttribute('id', String(att.id || 0));
    if (att.started) { node.setAttribute('started', att.started); node.setAttribute('isStartedSynced', 'True'); }
    if (att.ended) { node.setAttribute('ended', att.ended); node.setAttribute('isEndedSynced', 'True'); }
    if (att.real !== null && att.real !== undefined) add(node, 'RealTime', formatLssTime(att.real));
    history.appendChild(node);
  }

  const segments = add(root, 'Segments', '');
  for (const seg of run.segments || []) {
    const node = doc.createElement('Segment');
    add(node, 'Name', seg.name || '');
    add(node, 'Icon', '');
    const splits = add(node, 'SplitTimes', '');
    const entries = [['Personal Best', seg.pb]].concat(Object.entries(seg.comparisons || {}));
    for (const [name, value] of entries) {
      const st = doc.createElement('SplitTime');
      st.setAttribute('name', name);
      if (value !== null && value !== undefined) add(st, 'RealTime', formatLssTime(value));
      splits.appendChild(st);
    }
    const best = add(node, 'BestSegmentTime', '');
    if (seg.best !== null && seg.best !== undefined) add(best, 'RealTime', formatLssTime(seg.best));
    add(node, 'SegmentHistory', '');
    segments.appendChild(node);
  }
  add(root, 'AutoSplitterSettings', '');

  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(doc);
}

/** A blank run so the timer is usable before anyone imports anything. */
export function emptyRun(segmentNames = ['Split 1', 'Split 2', 'Final split']) {
  return {
    game: 'New game',
    category: 'Any%',
    offset: 0,
    attempts: 0,
    platform: '',
    region: '',
    variables: {},
    segments: segmentNames.map((name) => ({ name, pb: null, best: null, comparisons: {} })),
    history: [],
    pbTime: null,
  };
}
