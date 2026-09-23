<?php
require_once __DIR__ . '/lib/Util.php';
require_once __DIR__ . '/lib/Auth.php';
if (!sv_installed()) { header('Location: install.php'); exit; }
Auth::start();
if (!Auth::user()) { header('Location: login.php'); exit; }
$cfg = sv_config();
$boot = [
    'user' => Auth::user(),
    'csrf' => Auth::csrf(),
    'siteName' => $cfg['site_name'] ?? 'Stream Studio',
    'overlayToken' => $cfg['overlay_token'] ?? '',
    'relayUrl' => $cfg['relay_url'] ?? '',
    'version' => '1.0.0',
];
?><!doctype html>
<html lang="en" data-theme="dark"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title><?= htmlspecialchars($boot['siteName']) ?></title>
<link rel="stylesheet" href="assets/css/studio.css?v=<?= $boot['version'] ?>">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='%23e2464a'/></svg>">
</head>
<body class="app-shell">
<script>window.STUDIO_BOOT = <?= json_encode($boot, JSON_UNESCAPED_SLASHES) ?>;</script>

<header class="menubar">
  <div class="brand">
    <span class="dot"></span>
    <strong><?= htmlspecialchars($boot['siteName']) ?></strong>
  </div>
  <nav class="menu" role="menubar">
    <button class="mb" data-action="open-settings">Settings</button>
    <button class="mb" data-action="open-splits">Splits</button>
    <button class="mb" data-action="open-destinations">Destinations</button>
    <button class="mb" data-action="open-overlays">Overlays</button>
    <button class="mb" data-action="open-hotkeys">Hotkeys</button>
    <button class="mb" data-action="open-help">Help</button>
  </nav>
  <div class="statusbar">
    <span class="pill" id="statLive" data-state="off">OFFLINE</span>
    <span class="stat" title="Compositor frames per second"><b id="statFps">0</b> fps</span>
    <span class="stat" title="Frames the compositor could not draw in time"><b id="statDropped">0</b> skipped</span>
    <span class="stat" title="Measured output bitrate"><b id="statBitrate">0</b> kb/s</span>
    <span class="stat" title="Time on air" id="statUptime">00:00:00</span>
    <span class="stat cpu" title="Render cost per frame"><b id="statRender">0.0</b> ms</span>
    <a class="mb" href="api/index.php?r=session/logout" id="logoutLink" title="Sign out" aria-label="Sign out">⎋</a>
  </div>
</header>

<main class="stage" id="stage">
  <section class="viewers">
    <figure class="view" id="viewPreview" hidden>
      <figcaption>Preview</figcaption>
      <div class="canvas-holder"><canvas id="previewCanvas" width="1280" height="720"></canvas></div>
    </figure>
    <figure class="view program">
      <figcaption id="programLabel">Program</figcaption>
      <div class="canvas-holder" id="programHolder">
        <canvas id="programCanvas" width="1280" height="720"></canvas>
        <div class="edit-layer" id="editLayer" aria-hidden="true"></div>
      </div>
    </figure>
  </section>

  <aside class="dock dock-side" id="timerDock">
    <header class="dock-head">
      <h2>Speedrun timer</h2>
      <div class="dock-tools">
        <button class="icon" data-action="timer-settings" title="Timer settings" aria-label="Timer settings">⚙</button>
        <button class="icon" data-action="timer-popout" title="Open as browser source" aria-label="Open as browser source">⧉</button>
      </div>
    </header>
    <div class="dock-body" id="timerPanel">
      <div class="ls-title">
        <div class="ls-game" id="lsGame">No splits loaded</div>
        <div class="ls-category" id="lsCategory">—</div>
        <div class="ls-attempts"><span id="lsAttempts">0</span></div>
      </div>
      <ol class="ls-splits" id="lsSplits"></ol>
      <div class="ls-clock">
        <span class="ls-time" id="lsClock">0.00</span>
      </div>
      <div class="ls-info" id="lsInfo">
        <div class="row"><span>Previous segment</span><b id="lsPrevSeg">—</b></div>
        <div class="row"><span>Sum of best</span><b id="lsSob">—</b></div>
        <div class="row"><span>Best possible</span><b id="lsBpt">—</b></div>
        <div class="row"><span>Personal best</span><b id="lsPb">—</b></div>
      </div>
      <div class="ls-buttons">
        <button class="btn" data-action="timer-split" id="btnSplit">Start</button>
        <button class="btn" data-action="timer-undo" title="Undo split">↶</button>
        <button class="btn" data-action="timer-skip" title="Skip split">↷</button>
        <button class="btn" data-action="timer-pause" title="Pause">⏸</button>
        <button class="btn danger" data-action="timer-reset" title="Reset">⟲</button>
      </div>
      <div class="ls-compare">
        <label for="lsComparison">Compare to</label>
        <select id="lsComparison" title="Which times the deltas are measured against"></select>
        <button class="link" data-action="timer-history" title="Attempt history">History</button>
      </div>
      <div class="ls-link" id="lsLink">
        <span class="conn" id="lsConn" data-state="off">local timer</span>
        <button class="link" data-action="timer-connect">Connect LiveSplit…</button>
      </div>
    </div>
  </aside>
</main>

<footer class="docks">
  <section class="dock">
    <header class="dock-head"><h2>Scenes</h2></header>
    <div class="dock-body list" id="sceneList"></div>
    <footer class="dock-foot">
      <button class="icon" data-action="scene-add" title="Add scene" aria-label="Add scene">＋</button>
      <button class="icon" data-action="scene-remove" title="Remove scene" aria-label="Remove scene">－</button>
      <button class="icon" data-action="scene-dup" title="Duplicate scene" aria-label="Duplicate scene">⧉</button>
      <button class="icon" data-action="scene-up" title="Move up" aria-label="Move up">▲</button>
      <button class="icon" data-action="scene-down" title="Move down" aria-label="Move down">▼</button>
      <button class="icon" data-action="scene-starter" title="Add a ready-made speedrunning layout" aria-label="Add a ready-made speedrunning layout">✦</button>
    </footer>
  </section>

  <section class="dock wide">
    <header class="dock-head"><h2>Sources</h2></header>
    <div class="dock-body list" id="sourceList"></div>
    <footer class="dock-foot">
      <button class="icon" data-action="source-add" title="Add source" aria-label="Add source">＋</button>
      <button class="icon" data-action="source-remove" title="Remove source" aria-label="Remove source">－</button>
      <button class="icon" data-action="source-props" title="Properties" aria-label="Properties">⚙</button>
      <button class="icon" data-action="source-up" title="Move up" aria-label="Move up">▲</button>
      <button class="icon" data-action="source-down" title="Move down" aria-label="Move down">▼</button>
      <button class="icon" data-action="source-fit" title="Fit to screen" aria-label="Fit to screen">⤢</button>
    </footer>
  </section>

  <section class="dock wide">
    <header class="dock-head"><h2>Audio mixer</h2></header>
    <div class="dock-body" id="mixerList"></div>
    <footer class="dock-foot">
      <button class="icon" data-action="mixer-add" title="Add audio input" aria-label="Add audio input">＋</button>
      <span class="foot-note">Click a meter name to rename · drag the slider for gain</span>
    </footer>
  </section>

  <section class="dock">
    <header class="dock-head"><h2>Transitions</h2></header>
    <div class="dock-body" id="transitionPanel">
      <label class="field"><span>Type</span>
        <select id="transitionType">
          <option value="cut">Cut</option>
          <option value="fade">Fade</option>
          <option value="fade_black">Fade to black</option>
          <option value="slide">Slide</option>
        </select>
      </label>
      <label class="field"><span>Duration</span>
        <input type="range" id="transitionDuration" min="0" max="2000" step="50" value="300">
        <output id="transitionDurationOut">300 ms</output>
      </label>
      <label class="check"><input type="checkbox" id="studioModeToggle"> Studio mode</label>
      <button class="btn wide-btn" data-action="do-transition" id="btnTransition">Transition</button>
    </div>
  </section>

  <section class="dock">
    <header class="dock-head"><h2>Controls</h2></header>
    <div class="dock-body controls">
      <button class="btn primary" data-action="toggle-stream" id="btnStream">Start streaming</button>
      <button class="btn" data-action="toggle-record" id="btnRecord">Start recording</button>
      <button class="btn" data-action="open-settings">Settings</button>
      <button class="btn" data-action="toggle-lowpower" id="btnLowPower" title="Halves the render rate and disables filters">Low power: off</button>
      <div class="hint" id="outputHint">Recording saves straight to your computer. Streaming needs a relay or a WHIP URL.</div>
    </div>
  </section>
</footer>

<div class="modal-root" id="modalRoot" hidden>
  <div class="modal-backdrop" data-action="modal-close"></div>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <header class="modal-head">
      <h2 id="modalTitle">Dialog</h2>
      <button class="icon" data-action="modal-close" aria-label="Close">✕</button>
    </header>
    <div class="modal-body" id="modalBody"></div>
    <footer class="modal-foot" id="modalFoot"></footer>
  </div>
</div>

<div class="toasts" id="toasts" aria-live="polite"></div>

<script type="module" src="assets/js/main.js?v=<?= $boot['version'] ?>"></script>
<noscript><p class="bad" style="padding:2rem">Stream Studio needs JavaScript.</p></noscript>
</body></html>
