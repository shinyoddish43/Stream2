<?php
/**
 * Stream Studio API — one file, no rewrites required.
 * Routes are selected with ?r=<route>, which works on every cPanel host
 * regardless of whether mod_rewrite or .htaccess overrides are allowed.
 */
declare(strict_types=1);

require_once __DIR__ . '/../lib/Util.php';
require_once __DIR__ . '/../lib/Store.php';
require_once __DIR__ . '/../lib/Auth.php';
require_once __DIR__ . '/../lib/Lss.php';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

$route = (string)($_GET['r'] ?? '');
$method = sv_method();
$store = new Store();

if ($method === 'OPTIONS') { http_response_code(204); exit; }

if (!sv_installed() && !in_array($route, ['health', 'session/me'], true)) {
    sv_fail('not installed - open install.php', 503);
}

switch ($route) {

case 'health':
    sv_json([
        'ok' => true,
        'app' => 'stream-studio',
        'version' => '1.0.0',
        'installed' => sv_installed(),
        'php' => PHP_VERSION,
        'writable' => is_writable(sv_data_dir()),
        'time' => sv_now(),
    ]);

case 'session/login': {
    if ($method !== 'POST') sv_fail('POST required', 405);
    $name = (string)sv_param('username', '');
    $pass = (string)sv_param('password', '');
    // Throttle brute force with a per-IP backoff kept in the data dir.
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    $key = 'throttle';
    $now = time();
    $throttle = $store->read($key, []);
    // Drop stale entries: a scanner sweeping the internet must not be able to
    // grow this file forever.
    foreach ($throttle as $addr => $row) {
        if (($row['seen'] ?? 0) < $now - 86400) unset($throttle[$addr]);
    }
    if (count($throttle) > 500) $throttle = array_slice($throttle, -200, null, true);
    $entry = $throttle[$ip] ?? ['n' => 0, 'until' => 0];
    if (($entry['until'] ?? 0) > $now) {
        sv_fail('too many attempts, wait ' . ($entry['until'] - $now) . 's', 429);
    }
    $user = Auth::verify($name, $pass);
    if (!$user) {
        $entry['n'] = (int)($entry['n'] ?? 0) + 1;
        $entry['seen'] = $now;
        if ($entry['n'] >= 5) { $entry['until'] = $now + min(300, 5 * (2 ** ($entry['n'] - 5))); }
        $throttle[$ip] = $entry;
        $store->write($key, $throttle);
        sv_fail('invalid credentials', 401);
    }
    unset($throttle[$ip]);
    $store->write($key, $throttle);
    Auth::login($user);
    $cfg = sv_config();
    sv_json(['ok' => true, 'user' => $user['name'], 'csrf' => Auth::csrf(), 'overlayToken' => $cfg['overlay_token'] ?? '']);
}

case 'session/logout':
    Auth::logout();
    sv_json(['ok' => true]);

case 'session/me': {
    $cfg = sv_config();
    $user = Auth::user();
    sv_json([
        'ok' => true,
        'installed' => sv_installed(),
        'user' => $user,
        'csrf' => $user ? Auth::csrf() : null,
        'overlayToken' => $user ? ($cfg['overlay_token'] ?? '') : null,
        'relay' => [
            'url' => $cfg['relay_url'] ?? '',
            'enabled' => !empty($cfg['relay_url']),
        ],
    ]);
}

case 'config': {
    // The whole studio document: scenes, sources, audio, output settings.
    if ($method === 'GET') {
        Auth::requireRead();
        $doc = $store->read('studio', null);
        if ($doc === null) $doc = json_decode((string)@file_get_contents(__DIR__ . '/../assets/default-studio.json'), true) ?: [];
        sv_json(['ok' => true, 'config' => $doc, 'rev' => (int)($doc['rev'] ?? 0)]);
    }
    if ($method !== 'POST' && $method !== 'PUT') sv_fail('POST required', 405);
    Auth::requireUser();
    Auth::checkCsrf();
    $incoming = sv_param('config');
    if (!is_array($incoming)) sv_fail('config object required');
    $saved = $store->mutate('studio', function ($current) use ($incoming) {
        $incoming['rev'] = (int)($current['rev'] ?? 0) + 1;
        $incoming['savedAt'] = sv_now();
        return $incoming;
    }, []);
    sv_json(['ok' => true, 'rev' => $saved['rev']]);
}

case 'state': {
    // Live timer/scene state, published by the studio and read by overlays.
    if ($method === 'GET') {
        Auth::requireRead();
        // Hold nothing while we wait: the session lock would serialise the
        // studio's own requests behind this poll, and the client is gone
        // anyway if it has given up.
        Auth::releaseLock();
        ignore_user_abort(false);
        $state = $store->read('state', ['rev' => 0]);
        $since = isset($_GET['since']) ? (int)$_GET['since'] : -1;
        // A short server-side wait keeps overlay latency near a frame without
        // hammering the CPU. Capped low on purpose: each waiting request holds
        // a PHP worker, and shared hosting has few of them.
        $waitMs = isset($_GET['wait']) ? (int)sv_clamp((int)$_GET['wait'], 0, 5000) : 0;
        if ($waitMs > 0 && (int)($state['rev'] ?? 0) <= $since) {
            $deadline = microtime(true) + ($waitMs / 1000);
            while (microtime(true) < $deadline) {
                usleep(120000);
                if (connection_aborted()) exit;
                $state = $store->read('state', ['rev' => 0]);
                if ((int)($state['rev'] ?? 0) > $since) break;
            }
        }
        sv_json(['ok' => true, 'state' => $state, 'rev' => (int)($state['rev'] ?? 0)]);
    }
    if ($method !== 'POST') sv_fail('POST required', 405);
    Auth::requireUser();
    Auth::checkCsrf();
    $incoming = sv_param('state');
    if (!is_array($incoming)) sv_fail('state object required');
    $saved = $store->mutate('state', function ($current) use ($incoming) {
        $incoming['rev'] = (int)($current['rev'] ?? 0) + 1;
        $incoming['at'] = microtime(true);
        return $incoming;
    }, []);
    sv_json(['ok' => true, 'rev' => $saved['rev']]);
}

case 'splits/list': {
    Auth::requireRead();
    $index = $store->read('splits_index', []);
    sv_json(['ok' => true, 'splits' => array_values($index)]);
}

case 'splits/get': {
    Auth::requireRead();
    $id = preg_replace('/[^a-z0-9_\-]/i', '', (string)($_GET['id'] ?? ''));
    if ($id === '') sv_fail('id required');
    $run = $store->read('split_' . $id, null);
    if ($run === null) sv_fail('not found', 404);
    sv_json(['ok' => true, 'run' => $run]);
}

case 'splits/save': {
    if ($method !== 'POST') sv_fail('POST required', 405);
    Auth::requireUser();
    Auth::checkCsrf();
    $run = sv_param('run');
    if (!is_array($run)) sv_fail('run object required');
    $id = preg_replace('/[^a-z0-9_\-]/i', '', (string)($run['id'] ?? ''));
    if ($id === '') $id = sv_id('sp');
    $run['id'] = $id;
    $run['updatedAt'] = sv_now();
    // The index shows a PB column; derive it when the client did not send one.
    if (!isset($run['pbTime']) || $run['pbTime'] === null) {
        $segments = $run['segments'] ?? [];
        $last = $segments ? end($segments) : null;
        $run['pbTime'] = $last['pb'] ?? null;
    }
    $store->write('split_' . $id, $run);
    $store->mutate('splits_index', function ($index) use ($run, $id) {
        $index[$id] = [
            'id' => $id,
            'game' => $run['game'] ?? '',
            'category' => $run['category'] ?? '',
            'segments' => count($run['segments'] ?? []),
            'attempts' => (int)($run['attempts'] ?? 0),
            'pb' => $run['pbTime'] ?? null,
            'updatedAt' => $run['updatedAt'],
        ];
        return $index;
    }, []);
    sv_json(['ok' => true, 'id' => $id]);
}

case 'splits/delete': {
    if ($method !== 'POST') sv_fail('POST required', 405);
    Auth::requireUser();
    Auth::checkCsrf();
    $id = preg_replace('/[^a-z0-9_\-]/i', '', (string)sv_param('id', ''));
    if ($id === '') sv_fail('id required');
    $store->delete('split_' . $id);
    $store->mutate('splits_index', function ($index) use ($id) {
        unset($index[$id]);
        return $index;
    }, []);
    sv_json(['ok' => true]);
}

case 'splits/import': {
    // Accepts raw .lss XML (as text in JSON, or as a multipart upload).
    if ($method !== 'POST') sv_fail('POST required', 405);
    Auth::requireUser();
    Auth::checkCsrf();
    $xml = (string)sv_param('xml', '');
    if ($xml === '' && !empty($_FILES['file']['tmp_name'])) {
        $xml = (string)file_get_contents($_FILES['file']['tmp_name']);
    }
    if (trim($xml) === '') sv_fail('no .lss content supplied');
    if (strlen($xml) > 8 * 1024 * 1024) sv_fail('file too large', 413);
    try {
        $run = Lss::parse($xml);
    } catch (Throwable $e) {
        sv_fail('could not parse: ' . $e->getMessage());
    }
    sv_json(['ok' => true, 'run' => $run]);
}

case 'splits/export': {
    Auth::requireRead();
    $id = preg_replace('/[^a-z0-9_\-]/i', '', (string)($_GET['id'] ?? ''));
    $run = $id !== '' ? $store->read('split_' . $id, null) : sv_param('run');
    if (!is_array($run)) sv_fail('not found', 404);
    $xml = Lss::build($run);
    $name = preg_replace('/[^A-Za-z0-9._ -]/', '', (($run['game'] ?? 'splits') . ' - ' . ($run['category'] ?? '')));
    header('Content-Type: application/xml; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . trim($name) . '.lss"');
    echo $xml;
    exit;
}

case 'runs/list': {
    Auth::requireRead();
    $runs = $store->read('runs', []);
    sv_json(['ok' => true, 'runs' => array_slice(array_reverse($runs), 0, 200)]);
}

case 'runs/add': {
    if ($method !== 'POST') sv_fail('POST required', 405);
    Auth::requireUser();
    Auth::checkCsrf();
    $run = sv_param('run');
    if (!is_array($run)) sv_fail('run object required');
    $store->mutate('runs', function ($runs) use ($run) {
        $run['at'] = sv_now();
        $runs[] = $run;
        // Keep the history bounded: this is a flat file on shared hosting.
        if (count($runs) > 1000) $runs = array_slice($runs, -1000);
        return $runs;
    }, []);
    sv_json(['ok' => true]);
}

case 'destinations': {
    // Stream targets. Keys are stored encrypted and never sent back verbatim.
    if ($method === 'GET') {
        Auth::requireUser();
        $dests = $store->read('destinations', []);
        foreach ($dests as &$d) {
            $d['hasKey'] = !empty($d['key']);
            $d['key'] = $d['hasKey'] ? '••••••••' : '';
        }
        unset($d);
        sv_json(['ok' => true, 'destinations' => array_values($dests)]);
    }
    if ($method !== 'POST') sv_fail('POST required', 405);
    Auth::requireUser();
    Auth::checkCsrf();
    $list = sv_param('destinations');
    if (!is_array($list)) sv_fail('destinations array required');
    $existing = $store->read('destinations', []);
    $byId = [];
    foreach ($existing as $d) $byId[$d['id'] ?? ''] = $d;
    $next = [];
    foreach ($list as $d) {
        $url = trim((string)($d['url'] ?? ''));
        if ($url !== '' && !preg_match('#^rtmps?://[A-Za-z0-9._~:/?\#@!$&\'()*+,;=%-]{3,500}$#', $url)) {
            sv_fail('destination URL must be a plain rtmp:// or rtmps:// address');
        }
        $id = preg_replace('/[^a-z0-9_\-]/i', '', (string)($d['id'] ?? '')) ?: sv_id('dst');
        $key = (string)($d['key'] ?? '');
        if ($key === '' || $key === '••••••••') {
            $key = $byId[$id]['key'] ?? '';   // already-encrypted blob, keep it
        } else {
            $key = sv_encrypt($key);
        }
        $next[] = [
            'id' => $id,
            'name' => substr((string)($d['name'] ?? 'Destination'), 0, 64),
            'service' => substr((string)($d['service'] ?? 'custom'), 0, 32),
            'url' => $url,
            'key' => $key,
            'enabled' => !empty($d['enabled']),
        ];
    }
    $store->write('destinations', $next);
    sv_json(['ok' => true, 'count' => count($next)]);
}

case 'relay/ticket': {
    // Hands the browser a short-lived signed ticket plus the decrypted RTMP
    // targets, so the relay never needs its own copy of the user database.
    if ($method !== 'POST') sv_fail('POST required', 405);
    Auth::requireUser();
    Auth::checkCsrf();
    $cfg = sv_config();
    if (empty($cfg['relay_url'])) sv_fail('no relay configured', 409);
    $dests = $store->read('destinations', []);
    $targets = [];
    foreach ($dests as $d) {
        if (empty($d['enabled'])) continue;
        $key = sv_decrypt($d['key'] ?? '');
        $url = rtrim((string)$d['url'], '/');
        if ($url === '') continue;
        $targets[] = ['name' => $d['name'], 'url' => $key !== '' ? $url . '/' . $key : $url];
    }
    if (!$targets) sv_fail('no enabled destinations with a URL', 409);
    $payload = [
        'iss' => 'stream-studio',
        'user' => Auth::user(),
        'exp' => time() + 120,
        'targets' => $targets,
        'video' => sv_param('video', []),
        'audio' => sv_param('audio', []),
    ];
    $body = rtrim(strtr(base64_encode(json_encode($payload)), '+/', '-_'), '=');
    $sig = rtrim(strtr(base64_encode(hash_hmac('sha256', $body, (string)($cfg['relay_secret'] ?? $cfg['secret']), true)), '+/', '-_'), '=');
    sv_json(['ok' => true, 'ticket' => $body . '.' . $sig, 'relay' => $cfg['relay_url'], 'expires' => $payload['exp']]);
}

case 'settings': {
    if ($method === 'GET') {
        Auth::requireUser();
        $cfg = sv_config();
        sv_json(['ok' => true, 'settings' => [
            'relay_url' => $cfg['relay_url'] ?? '',
            'overlay_token' => $cfg['overlay_token'] ?? '',
            'site_name' => $cfg['site_name'] ?? 'Stream Studio',
        ]]);
    }
    if ($method !== 'POST') sv_fail('POST required', 405);
    Auth::requireUser();
    Auth::checkCsrf();
    $cfg = sv_config();
    $relay = trim((string)sv_param('relay_url', $cfg['relay_url'] ?? ''));
    if ($relay !== '' && !preg_match('#^wss?://#i', $relay)) sv_fail('relay URL must start with ws:// or wss://');
    $cfg['relay_url'] = $relay;
    $cfg['site_name'] = substr(trim((string)sv_param('site_name', $cfg['site_name'] ?? 'Stream Studio')), 0, 64);
    if (sv_param('rotate_overlay_token')) $cfg['overlay_token'] = bin2hex(random_bytes(16));
    $store->write('config', $cfg);
    sv_json(['ok' => true, 'overlay_token' => $cfg['overlay_token']]);
}

case 'password': {
    if ($method !== 'POST') sv_fail('POST required', 405);
    Auth::requireUser();
    Auth::checkCsrf();
    $current = (string)sv_param('current', '');
    $next = (string)sv_param('next', '');
    if (strlen($next) < 8) sv_fail('new password must be at least 8 characters');
    $user = Auth::verify((string)Auth::user(), $current);
    if (!$user) sv_fail('current password is wrong', 403);
    $cfg = sv_config();
    foreach ($cfg['users'] as &$u) {
        if (strcasecmp($u['name'], (string)Auth::user()) === 0) $u['hash'] = Auth::hash($next);
    }
    unset($u);
    $store->write('config', $cfg);
    sv_json(['ok' => true]);
}

default:
    sv_fail('unknown route: ' . $route, 404);
}
