<?php
/**
 * Post-deploy self-check.
 *
 * Open this after uploading to a live host: it tells you whether the studio
 * will actually work there, including the things that are easy to get wrong
 * on shared hosting — an unwritable data directory, a data directory the web
 * server happily serves to the world, missing extensions, or plain HTTP where
 * screen capture is not allowed.
 *
 * Requires a login once the studio is installed, because the answers describe
 * your server.
 */
require_once __DIR__ . '/lib/Util.php';
require_once __DIR__ . '/lib/Auth.php';
require_once __DIR__ . '/lib/Store.php';

Auth::start();
if (sv_installed() && !Auth::user()) {
    header('Location: login.php');
    exit;
}

$checks = [];
$add = function ($label, $state, $detail, $fix = '') use (&$checks) {
    $checks[] = ['label' => $label, 'state' => $state, 'detail' => $detail, 'fix' => $fix];
};

// --- PHP itself
$add('PHP version', version_compare(PHP_VERSION, '7.4', '>=') ? 'ok' : 'bad', PHP_VERSION,
    'cPanel → Select PHP Version → 8.0 or newer.');
foreach (['json' => 'required', 'SimpleXML' => 'reading .lss files', 'XMLWriter' => 'writing .lss files'] as $ext => $why) {
    $loaded = extension_loaded(strtolower($ext)) || class_exists($ext) || function_exists('simplexml_load_string');
    $add("Extension: $ext", $loaded ? 'ok' : 'bad', $loaded ? 'loaded' : "missing — $why",
        'cPanel → Select PHP Version → Extensions.');
}
$add('OpenSSL', function_exists('openssl_encrypt') ? 'ok' : 'warn',
    function_exists('openssl_encrypt') ? 'stream keys use AES-256' : 'missing — keys fall back to a keyed stream cipher',
    'Optional, but ask your host to enable it.');

// --- writability
$dataDir = sv_data_dir();
$writable = is_dir($dataDir) && is_writable($dataDir);
$add('Data directory writable', $writable ? 'ok' : 'bad', $dataDir,
    'In File Manager, set that folder to 0755 (0775 if the host runs PHP as another user).');

if ($writable) {
    $probe = $dataDir . '/.health-probe';
    $wrote = @file_put_contents($probe, 'ok') !== false;
    @unlink($probe);
    $add('Can create files there', $wrote ? 'ok' : 'bad', $wrote ? 'yes' : 'no',
        'Check the directory owner as well as its permissions.');
}

// --- HTTPS, without which there is no screen capture
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
$localhost = in_array($_SERVER['SERVER_NAME'] ?? '', ['localhost', '127.0.0.1'], true);
$add('HTTPS', $https || $localhost ? 'ok' : 'bad',
    $https ? 'on' : ($localhost ? 'localhost is exempt' : 'off — screen capture and cameras will not start'),
    'cPanel → SSL/TLS Status → Run AutoSSL, then force HTTPS on the domain.');

// --- is the data directory exposed to the world?
$exposed = null;
$selfBase = ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost')
    . rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/');
// Compare with a trailing separator, or "/app-data" looks like it lives
// inside "/app".
$insideWebRoot = strpos(rtrim($dataDir, '/') . '/', rtrim(__DIR__, '/') . '/') === 0;
if ($insideWebRoot) {
    // The data lives under the web root, so the deny rules have to be working.
    $url = $selfBase . '/data/config.json';
    $context = stream_context_create(['http' => ['timeout' => 4, 'ignore_errors' => true],
        'ssl' => ['verify_peer' => false, 'verify_peer_name' => false]]);
    $body = @file_get_contents($url, false, $context);
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) $status = (int)$m[1];
    }
    if ($status === 0) {
        $add('Data directory not public', 'warn', 'could not check from here — test it yourself',
            'Open ' . $url . ' in a browser. It must not return JSON.');
    } else {
        $exposed = $status < 400 && strpos((string)$body, '"installed"') !== false;
        $add('Data directory not public', $exposed ? 'bad' : 'ok',
            $exposed ? "SERVED YOUR CONFIG over HTTP ($status)" : "blocked (HTTP $status)",
            'Your server ignores .htaccess. Copy config.sample.php to config.php and set STUDIO_DATA_DIR '
            . 'to a path outside the web root, or deny /data/ in the server config.');
    }
} else {
    $add('Data directory not public', 'ok', 'kept outside the web root (' . $dataDir . ')');
    // Moving the data does not remove what was left behind.
    $leftover = __DIR__ . '/data/config.json';
    if (is_file($leftover)) {
        $add('No leftover data in the web root', 'bad', 'data/config.json is still there',
            'Delete the old data/ directory: it still holds your hashed password and encrypted keys.');
    }
}

// --- leftovers that should not be on a live site
$add('Installer removed', is_file(__DIR__ . '/install.php') ? 'warn' : 'ok',
    is_file(__DIR__ . '/install.php') ? 'install.php is still here' : 'gone',
    'It refuses to run twice, but delete it anyway once you have your account.');
$add('Version control not published', is_dir(__DIR__ . '/.git') ? 'warn' : 'ok',
    is_dir(__DIR__ . '/.git') ? '.git is in the web root' : 'none',
    'Deploy without .git, or deny it in the server config.');

// --- optional pieces
$cfg = sv_config();
if (!empty($cfg['relay_url'])) {
    $parts = parse_url($cfg['relay_url']);
    $host = $parts['host'] ?? '';
    $port = $parts['port'] ?? (($parts['scheme'] ?? '') === 'wss' ? 443 : 80);
    $socket = @fsockopen(($parts['scheme'] ?? '') === 'wss' ? 'ssl://' . $host : $host, $port, $errno, $errstr, 4);
    $add('Relay reachable', $socket ? 'ok' : 'warn', $socket ? "$host:$port answers" : "$host:$port — $errstr",
        'Start the relay, or clear the relay URL in Settings → Server if you are not using it.');
    if ($socket) fclose($socket);
} else {
    $add('Relay', 'ok', 'not configured (recording and WHIP still work)');
}

$worst = 'ok';
foreach ($checks as $check) {
    if ($check['state'] === 'bad') { $worst = 'bad'; break; }
    if ($check['state'] === 'warn') $worst = 'warn';
}

if (($_GET['format'] ?? '') === 'json') {
    sv_json(['ok' => $worst !== 'bad', 'status' => $worst, 'checks' => $checks]);
}
?><!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Health check · Stream Studio</title>
<link rel="stylesheet" href="assets/css/studio.css">
</head><body class="page-plain">
<main class="card">
  <h1>Health check <small><?= htmlspecialchars($_SERVER['HTTP_HOST'] ?? '') ?></small></h1>
  <p class="<?= $worst === 'ok' ? 'ok' : ($worst === 'warn' ? 'muted' : 'bad') ?>">
    <?= $worst === 'ok' ? 'Everything the studio needs is in place.'
      : ($worst === 'warn' ? 'Usable, with some things worth tidying.'
      : 'Something here will stop the studio working.') ?>
  </p>
  <ul class="checks">
    <?php foreach ($checks as $check): ?>
      <li class="<?= $check['state'] === 'ok' ? 'ok' : ($check['state'] === 'warn' ? 'warn' : 'bad') ?>">
        <span>
          <?= htmlspecialchars($check['label']) ?>
          <?php if ($check['state'] !== 'ok' && $check['fix']): ?>
            <br><small class="muted"><?= htmlspecialchars($check['fix']) ?></small>
          <?php endif; ?>
        </span>
        <code><?= htmlspecialchars($check['detail']) ?></code>
      </li>
    <?php endforeach; ?>
  </ul>
  <p><a class="btn primary" href="index.php">Open the studio</a>
     <a class="btn" href="?format=json">JSON</a></p>
  <p class="muted">Machine-readable at <code>health.php?format=json</code> — handy for a deploy script.</p>
</main>
</body></html>
