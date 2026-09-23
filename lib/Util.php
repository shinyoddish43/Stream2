<?php
// Small helpers shared by the API endpoints. No framework, no composer.

function sv_json($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function sv_fail($message, $code = 400) {
    sv_json(['ok' => false, 'error' => $message], $code);
}

function sv_body() {
    static $cached = null;
    if ($cached !== null) return $cached;
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) { $cached = []; return $cached; }
    $decoded = json_decode($raw, true);
    $cached = is_array($decoded) ? $decoded : [];
    return $cached;
}

function sv_param($key, $default = null) {
    $body = sv_body();
    if (array_key_exists($key, $body)) return $body[$key];
    if (isset($_GET[$key])) return $_GET[$key];
    if (isset($_POST[$key])) return $_POST[$key];
    return $default;
}

function sv_method() {
    return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
}

function sv_id($prefix = 'id') {
    return $prefix . '_' . bin2hex(random_bytes(6));
}

function sv_now() {
    return gmdate('c');
}

// Constant-time-ish token compare for PHP builds without hash_equals.
function sv_equals($a, $b) {
    if (function_exists('hash_equals')) return hash_equals((string)$a, (string)$b);
    $a = (string)$a; $b = (string)$b;
    if (strlen($a) !== strlen($b)) return false;
    $diff = 0;
    for ($i = 0; $i < strlen($a); $i++) $diff |= ord($a[$i]) ^ ord($b[$i]);
    return $diff === 0;
}

// Encrypt stream keys at rest so a leaked data/ dir is not an instant takeover.
// Uses libsodium or openssl when present, falls back to a keyed XOR + HMAC.
function sv_secret_key() {
    $cfg = sv_config();
    $key = $cfg['secret'] ?? '';
    return hash('sha256', 'stream-studio|' . $key, true);
}

function sv_encrypt($plain) {
    if ($plain === '' || $plain === null) return '';
    $key = sv_secret_key();
    if (function_exists('openssl_encrypt')) {
        $iv = random_bytes(16);
        $ct = openssl_encrypt($plain, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
        $mac = hash_hmac('sha256', $iv . $ct, $key, true);
        return 'v1:' . base64_encode($iv . $mac . $ct);
    }
    $stream = '';
    $len = strlen($plain);
    for ($i = 0; $i < $len; $i += 32) $stream .= hash('sha256', $key . $i, true);
    $ct = $plain ^ substr($stream, 0, $len);
    return 'v0:' . base64_encode($ct);
}

function sv_decrypt($blob) {
    if ($blob === '' || $blob === null) return '';
    $key = sv_secret_key();
    if (strpos($blob, 'v1:') === 0) {
        $raw = base64_decode(substr($blob, 3), true);
        if ($raw === false || strlen($raw) < 48) return '';
        $iv = substr($raw, 0, 16);
        $mac = substr($raw, 16, 32);
        $ct = substr($raw, 48);
        if (!sv_equals($mac, hash_hmac('sha256', $iv . $ct, $key, true))) return '';
        $out = openssl_decrypt($ct, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
        return $out === false ? '' : $out;
    }
    if (strpos($blob, 'v0:') === 0) {
        $ct = base64_decode(substr($blob, 3), true);
        if ($ct === false) return '';
        $stream = '';
        $len = strlen($ct);
        for ($i = 0; $i < $len; $i += 32) $stream .= hash('sha256', $key . $i, true);
        return $ct ^ substr($stream, 0, $len);
    }
    return $blob; // legacy plaintext
}

function sv_data_dir() {
    $dir = dirname(__DIR__) . '/data';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    return $dir;
}

function sv_config() {
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $path = sv_data_dir() . '/config.json';
    if (!is_file($path)) { $cfg = []; return $cfg; }
    $raw = @file_get_contents($path);
    $cfg = json_decode((string)$raw, true);
    if (!is_array($cfg)) $cfg = [];
    return $cfg;
}

function sv_installed() {
    $cfg = sv_config();
    return !empty($cfg['installed']) && !empty($cfg['users']);
}

function sv_clamp($n, $min, $max) {
    $n = (float)$n;
    if ($n < $min) return (float)$min;
    if ($n > $max) return (float)$max;
    return $n;
}
