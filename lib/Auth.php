<?php
require_once __DIR__ . '/Util.php';
require_once __DIR__ . '/Store.php';

/**
 * Single-tenant-ish auth: a small user list in data/config.json, PHP sessions
 * for the studio UI, and long-lived opaque tokens for overlay/browser-source
 * URLs (so OBS or a second machine can read state without a login form).
 */
class Auth
{
    public static function start()
    {
        if (session_status() === PHP_SESSION_NONE) {
            $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
                || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
            session_set_cookie_params([
                'lifetime' => 0,
                'path' => '/',
                'httponly' => true,
                'samesite' => 'Lax',
                'secure' => $secure,
            ]);
            session_name('svstudio');
            @session_start();
        }
    }

    public static function hash($password)
    {
        return password_hash($password, PASSWORD_DEFAULT);
    }

    public static function verify($username, $password)
    {
        $cfg = sv_config();
        foreach (($cfg['users'] ?? []) as $user) {
            if (strcasecmp($user['name'] ?? '', $username) === 0) {
                if (password_verify($password, $user['hash'] ?? '')) return $user;
                return null;
            }
        }
        // Constant-ish work factor even for unknown users.
        password_verify($password, '$2y$10$usesomesillystringforsalt000000000000000000000000000000');
        return null;
    }

    public static function login($user)
    {
        self::start();
        session_regenerate_id(true);
        $_SESSION['user'] = $user['name'];
        $_SESSION['role'] = $user['role'] ?? 'owner';
        $_SESSION['at'] = time();
    }

    public static function logout()
    {
        self::start();
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
        }
        @session_destroy();
    }

    public static function user()
    {
        self::start();
        return $_SESSION['user'] ?? null;
    }

    /** True when the request carries either a valid session or the overlay token. */
    public static function readAccess()
    {
        if (self::user()) return true;
        return self::validOverlayToken();
    }

    public static function validOverlayToken()
    {
        $cfg = sv_config();
        $token = $_GET['token'] ?? ($_SERVER['HTTP_X_STUDIO_TOKEN'] ?? '');
        if ($token === '' || empty($cfg['overlay_token'])) return false;
        return sv_equals($cfg['overlay_token'], $token);
    }

    public static function requireUser()
    {
        if (!self::user()) sv_fail('not authenticated', 401);
    }

    public static function requireRead()
    {
        if (!self::readAccess()) sv_fail('not authenticated', 401);
    }

    /** CSRF token for state-changing form posts from the studio UI. */
    public static function csrf()
    {
        self::start();
        if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));
        return $_SESSION['csrf'];
    }

    public static function checkCsrf()
    {
        self::start();
        $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? (sv_param('csrf') ?? '');
        if (empty($_SESSION['csrf']) || !sv_equals($_SESSION['csrf'], $sent)) {
            sv_fail('bad csrf token', 403);
        }
    }
}
