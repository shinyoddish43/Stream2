<?php
/**
 * One-page installer. Upload the folder, open install.php, fill in two fields.
 * It writes data/config.json and then locks itself out.
 */
require_once __DIR__ . '/lib/Util.php';
require_once __DIR__ . '/lib/Store.php';
require_once __DIR__ . '/lib/Auth.php';

$errors = [];
$notices = [];
$done = false;

$checks = [
    'PHP 7.4 or newer' => [version_compare(PHP_VERSION, '7.4.0', '>='), PHP_VERSION],
    'JSON extension' => [function_exists('json_encode'), 'required'],
    'XML writer (for .lss export)' => [class_exists('XMLWriter'), 'php-xml'],
    'SimpleXML (for .lss import)' => [function_exists('simplexml_load_string'), 'php-xml'],
    'OpenSSL (stream key encryption)' => [function_exists('openssl_encrypt'), 'optional, falls back'],
    'data/ directory writable' => [is_dir(sv_data_dir()) && is_writable(sv_data_dir()), sv_data_dir()],
];
$hardFail = false;
foreach ($checks as $label => $c) {
    if (!$c[0] && strpos((string)$c[1], 'optional') === false) $hardFail = true;
}

if (sv_installed()) {
    // No bypass: while a config exists this page must never be able to mint a
    // new owner account, even if the file was left on the server.
    $done = true;
    $notices[] = 'Already installed. To start over, delete data/config.json on the server first.';
}

if (!$done && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = trim((string)($_POST['username'] ?? ''));
    $pass = (string)($_POST['password'] ?? '');
    $pass2 = (string)($_POST['password2'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_.\-]{3,32}$/', $user)) $errors[] = 'Username must be 3-32 characters (letters, numbers, . _ -).';
    if (strlen($pass) < 8) $errors[] = 'Password must be at least 8 characters.';
    if ($pass !== $pass2) $errors[] = 'Passwords do not match.';
    if ($hardFail) $errors[] = 'Fix the failed environment checks first.';
    if (!$errors) {
        $store = new Store();
        $cfg = [
            'installed' => true,
            'installedAt' => sv_now(),
            'site_name' => trim((string)($_POST['site_name'] ?? 'Stream Studio')) ?: 'Stream Studio',
            'secret' => bin2hex(random_bytes(32)),
            'relay_secret' => bin2hex(random_bytes(32)),
            'overlay_token' => bin2hex(random_bytes(16)),
            'relay_url' => trim((string)($_POST['relay_url'] ?? '')),
            'users' => [[
                'name' => $user,
                'hash' => Auth::hash($pass),
                'role' => 'owner',
                'createdAt' => sv_now(),
            ]],
        ];
        try {
            $store->write('config', $cfg);
            // Guard the data dir on Apache hosts that honour .htaccess.
            @file_put_contents(sv_data_dir() . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
            @file_put_contents(sv_data_dir() . '/index.html', '');
            $done = true;
            $notices[] = 'Installed. Log in and then delete install.php from the server.';
        } catch (Throwable $e) {
            $errors[] = 'Could not write config: ' . $e->getMessage();
        }
    }
}
?><!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install · Stream Studio</title>
<link rel="stylesheet" href="assets/css/studio.css">
</head><body class="page-plain">
<main class="card">
  <h1>Stream Studio <small>installer</small></h1>
  <p class="muted">A browser stream studio with a native speedrun timer. No database, no build step.</p>

  <h2>Environment</h2>
  <ul class="checks">
    <?php foreach ($checks as $label => $c): ?>
    <li class="<?= $c[0] ? 'ok' : (strpos((string)$c[1], 'optional') !== false ? 'warn' : 'bad') ?>">
      <span><?= htmlspecialchars($label) ?></span>
      <code><?= htmlspecialchars((string)$c[1]) ?></code>
    </li>
    <?php endforeach; ?>
  </ul>
  <?php if (!is_writable(sv_data_dir())): ?>
    <p class="bad">In cPanel → File Manager, set permissions on <code>data/</code> to 0755 (or 0775) so the app can save your scenes.</p>
  <?php endif; ?>

  <?php foreach ($errors as $e): ?><p class="bad"><?= htmlspecialchars($e) ?></p><?php endforeach; ?>
  <?php foreach ($notices as $n): ?><p class="ok"><?= htmlspecialchars($n) ?></p><?php endforeach; ?>

  <?php if ($done): ?>
    <p><a class="btn primary" href="index.php">Open the studio →</a></p>
  <?php else: ?>
  <form method="post" autocomplete="off">
    <h2>Owner account</h2>
    <label>Studio name <input name="site_name" value="Stream Studio" maxlength="64"></label>
    <label>Username <input name="username" required minlength="3" maxlength="32" autocomplete="username"></label>
    <label>Password <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
    <label>Repeat password <input name="password2" type="password" required minlength="8" autocomplete="new-password"></label>
    <h2>Optional</h2>
    <label>RTMP relay WebSocket URL
      <input name="relay_url" placeholder="wss://relay.example.com/ingest" pattern="(wss?://.*)?">
      <small class="muted">Only needed for pushing to Twitch/YouTube/Kick. Leave blank to record locally or use WHIP.</small>
    </label>
    <button class="btn primary" type="submit">Install</button>
  </form>
  <?php endif; ?>
</main>
</body></html>
