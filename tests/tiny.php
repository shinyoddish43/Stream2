<?php
// The PHP half of the test harness. Same idea as tests/tiny.mjs: no
// dependencies, so `php tests/php.test.php` works on any host.

class T
{
    public static $passed = 0;
    public static $failed = 0;
    public static $failures = [];
    public static $group = '';

    public static function describe($name, callable $fn)
    {
        self::$group = $name;
        $fn();
        self::$group = '';
    }

    public static function it($name, callable $fn)
    {
        $label = self::$group ? self::$group . ' › ' . $name : $name;
        try {
            $fn();
            self::$passed++;
            echo '.';
        } catch (Throwable $e) {
            self::$failed++;
            self::$failures[] = $label . "\n    " . $e->getMessage();
            echo 'x';
        }
    }

    public static function ok($value, $message = 'expected truthy')
    {
        if (!$value) throw new RuntimeException($message);
    }

    public static function equal($actual, $expected, $message = 'not equal')
    {
        if ($actual !== $expected) {
            throw new RuntimeException($message . ': expected ' . self::fmt($expected) . ', got ' . self::fmt($actual));
        }
    }

    public static function close($actual, $expected, $tolerance = 1e-6, $message = 'not close')
    {
        if (abs($actual - $expected) > $tolerance) {
            throw new RuntimeException($message . ': expected ~' . self::fmt($expected) . ', got ' . self::fmt($actual));
        }
    }

    public static function fmt($value)
    {
        return is_scalar($value) || $value === null ? var_export($value, true) : json_encode($value);
    }

    public static function report($title)
    {
        echo "\n";
        foreach (self::$failures as $failure) echo '  FAIL ' . $failure . "\n";
        echo "$title: " . self::$passed . ' passed, ' . self::$failed . " failed\n";
        return self::$failed === 0 ? 0 : 1;
    }
}
