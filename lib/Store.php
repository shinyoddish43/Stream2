<?php
require_once __DIR__ . '/Util.php';

/**
 * Flat-file JSON store. No database required, which is the point: a cPanel
 * user unzips the app and it runs. Writes go through a lock file + atomic
 * rename so a half-written file can never be served.
 */
class Store
{
    private $dir;

    public function __construct($dir = null)
    {
        $this->dir = $dir ?: sv_data_dir();
        if (!is_dir($this->dir)) @mkdir($this->dir, 0775, true);
    }

    private function path($name)
    {
        $name = preg_replace('/[^a-z0-9_\-]/i', '', (string)$name);
        if ($name === '') throw new InvalidArgumentException('bad store name');
        return $this->dir . '/' . $name . '.json';
    }

    public function read($name, $default = [])
    {
        $path = $this->path($name);
        if (!is_file($path)) return $default;
        $fh = @fopen($path, 'rb');
        if (!$fh) return $default;
        @flock($fh, LOCK_SH);
        $raw = stream_get_contents($fh);
        @flock($fh, LOCK_UN);
        fclose($fh);
        $data = json_decode((string)$raw, true);
        return is_array($data) ? $data : $default;
    }

    public function write($name, $data)
    {
        $path = $this->path($name);
        $tmp = $path . '.' . getmypid() . '.tmp';
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($json === false) throw new RuntimeException('encode failed');
        if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
            throw new RuntimeException('cannot write ' . basename($path) . ' - check data/ permissions (0775)');
        }
        if (!@rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException('cannot replace ' . basename($path));
        }
        @chmod($path, 0664);
        return true;
    }

    /** Read-modify-write under an exclusive lock. $fn receives and returns the data. */
    public function mutate($name, callable $fn, $default = [])
    {
        $lockPath = $this->path($name) . '.lock';
        $lock = @fopen($lockPath, 'c');
        if ($lock) @flock($lock, LOCK_EX);
        try {
            $data = $this->read($name, $default);
            $next = $fn($data);
            if ($next !== null) $this->write($name, $next);
            return $next;
        } finally {
            if ($lock) { @flock($lock, LOCK_UN); fclose($lock); }
        }
    }

    public function exists($name)
    {
        return is_file($this->path($name));
    }

    public function delete($name)
    {
        $path = $this->path($name);
        return is_file($path) ? @unlink($path) : true;
    }
}
