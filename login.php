<?php
require_once __DIR__ . '/lib/Util.php';
require_once __DIR__ . '/lib/Auth.php';
if (!sv_installed()) { header('Location: install.php'); exit; }
Auth::start();
if (Auth::user()) { header('Location: index.php'); exit; }
$cfg = sv_config();
?><!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · <?= htmlspecialchars($cfg['site_name'] ?? 'Stream Studio') ?></title>
<link rel="stylesheet" href="assets/css/studio.css">
</head><body class="page-plain">
<main class="card narrow">
  <h1><?= htmlspecialchars($cfg['site_name'] ?? 'Stream Studio') ?></h1>
  <p class="muted">Sign in to open the studio.</p>
  <form id="loginForm" autocomplete="on">
    <label>Username <input name="username" required autocomplete="username" autofocus></label>
    <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn primary" type="submit">Sign in</button>
    <p class="bad" id="loginError" hidden></p>
  </form>
</main>
<script>
document.getElementById('loginForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  var err = document.getElementById('loginError');
  err.hidden = true;
  var fd = new FormData(e.target);
  try {
    var res = await fetch('api/index.php?r=session/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') })
    });
    var data = await res.json();
    if (!data.ok) throw new Error(data.error || 'sign in failed');
    location.href = 'index.php';
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});
</script>
</body></html>
