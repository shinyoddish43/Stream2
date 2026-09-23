<?php
// Server-side tests: the .lss reader/writer, the flat-file store, and the
// bits of crypto that protect stream keys.

require_once __DIR__ . '/tiny.php';
require_once __DIR__ . '/../lib/Util.php';
require_once __DIR__ . '/../lib/Store.php';
require_once __DIR__ . '/../lib/Auth.php';
require_once __DIR__ . '/../lib/Lss.php';

$sandbox = sys_get_temp_dir() . '/studio-test-' . bin2hex(random_bytes(4));
mkdir($sandbox, 0775, true);
register_shutdown_function(function () use ($sandbox) {
    foreach (glob($sandbox . '/*') as $file) @unlink($file);
    @rmdir($sandbox);
});

T::describe('Lss::parseTime', function () {
    T::it('reads hours, minutes and seconds', fn() => T::close(Lss::parseTime('01:02:03.5'), 3723.5));
    T::it('reads a bare minute time', fn() => T::close(Lss::parseTime('02:30'), 150.0));
    T::it('reads the .NET day prefix', fn() => T::close(Lss::parseTime('1.00:00:10'), 86410.0));
    T::it('reads a negative offset', fn() => T::close(Lss::parseTime('-00:00:05'), -5.0));
    T::it('treats an empty string as no time', fn() => T::equal(Lss::parseTime(''), null));
    T::it('keeps seven decimal places on the way out', fn() => T::equal(Lss::formatTime(3723.5), '01:02:03.5000000'));
    T::it('formats zero', fn() => T::equal(Lss::formatTime(0), '00:00:00.0000000'));
});

T::describe('Lss round trip', function () {
    $xml = '<?xml version="1.0" encoding="UTF-8"?>
<Run version="1.7.0"><GameIcon /><GameName>Super Metroid</GameName><CategoryName>Any% NMG</CategoryName>
<Metadata><Run id="" /><Platform usesEmulator="False">SNES</Platform><Region>NTSC</Region>
<Variables><Variable name="Route">Ceres</Variable></Variables></Metadata>
<Offset>-00:00:05</Offset><AttemptCount>412</AttemptCount>
<AttemptHistory><Attempt id="411" started="01/02/2024 10:00:00" isStartedSynced="True" ended="01/02/2024 10:42:00" isEndedSynced="True"><RealTime>00:42:13.4500000</RealTime></Attempt></AttemptHistory>
<Segments>
<Segment><Name>Ceres</Name><Icon /><SplitTimes>
<SplitTime name="Personal Best"><RealTime>00:01:02.3400000</RealTime></SplitTime>
<SplitTime name="Average"><RealTime>00:01:05</RealTime></SplitTime></SplitTimes>
<BestSegmentTime><RealTime>00:00:59.1200000</RealTime></BestSegmentTime><SegmentHistory /></Segment>
<Segment><Name>Brinstar</Name><Icon /><SplitTimes>
<SplitTime name="Personal Best"><RealTime>00:08:44.1000000</RealTime></SplitTime></SplitTimes>
<BestSegmentTime><RealTime>00:07:30</RealTime></BestSegmentTime><SegmentHistory /></Segment>
</Segments><AutoSplitterSettings /></Run>';

    $run = Lss::parse($xml);
    T::it('reads the game', fn() => T::equal($run['game'], 'Super Metroid'));
    T::it('reads the category', fn() => T::equal($run['category'], 'Any% NMG'));
    T::it('reads a negative offset', fn() => T::close($run['offset'], -5.0));
    T::it('reads the attempt count', fn() => T::equal($run['attempts'], 412));
    T::it('reads every segment', fn() => T::equal(count($run['segments']), 2));
    T::it('reads PB splits', fn() => T::close($run['segments'][0]['pb'], 62.34));
    T::it('reads golds', fn() => T::close($run['segments'][0]['best'], 59.12));
    T::it('keeps extra comparisons', fn() => T::close($run['segments'][0]['comparisons']['Average'], 65.0));
    T::it('reads metadata', fn() => T::equal($run['platform'], 'SNES'));
    T::it('reads run variables', fn() => T::equal($run['variables']['Route'], 'Ceres'));
    T::it('reads attempt history', fn() => T::close($run['history'][0]['real'], 2533.45));
    T::it('derives the PB time', fn() => T::close($run['pbTime'], 524.1));

    $again = Lss::parse(Lss::build($run));
    T::it('survives a write and re-read', function () use ($run, $again) {
        T::close($again['segments'][0]['pb'], $run['segments'][0]['pb']);
        T::close($again['segments'][1]['best'], $run['segments'][1]['best']);
        T::close($again['offset'], $run['offset']);
        T::equal($again['attempts'], $run['attempts']);
        T::equal($again['variables']['Route'], 'Ceres');
        T::close($again['segments'][0]['comparisons']['Average'], 65.0);
    });
    T::it('writes XML LiveSplit would recognise', function () use ($run) {
        $xml = Lss::build($run);
        T::ok(strpos($xml, '<Run version="1.7.0">') !== false, 'missing versioned root');
        T::ok(strpos($xml, '<BestSegmentTime>') !== false, 'missing gold element');
        T::ok(strpos($xml, 'name="Personal Best"') !== false, 'missing PB comparison');
    });
});

T::describe('Lss rejects nonsense', function () {
    T::it('refuses a non-Run document', function () {
        try { Lss::parse('<?xml version="1.0"?><Layout />'); }
        catch (Throwable $e) { return; }
        throw new RuntimeException('expected a throw');
    });
    T::it('refuses broken XML', function () {
        try { Lss::parse('<Run><Segments>'); }
        catch (Throwable $e) { return; }
        throw new RuntimeException('expected a throw');
    });
    T::it('ignores an external entity rather than fetching it', function () {
        // A splits file from a stranger must not be able to read /etc/passwd.
        $evil = '<?xml version="1.0"?><!DOCTYPE Run [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
              . '<Run version="1.7.0"><GameName>&xxe;</GameName><Segments /></Run>';
        try { $run = Lss::parse($evil); } catch (Throwable $e) { return; }
        T::ok(strpos($run['game'], 'root:') === false, 'external entity was expanded');
    });
});

T::describe('Store', function () use ($sandbox) {
    $store = new Store($sandbox);
    T::it('returns the default for a missing file', fn() => T::equal($store->read('nope', ['a' => 1]), ['a' => 1]));
    T::it('writes and reads back', function () use ($store) {
        $store->write('thing', ['hello' => 'world', 'n' => 3]);
        T::equal($store->read('thing')['hello'], 'world');
    });
    T::it('mutates under a lock', function () use ($store) {
        $store->mutate('counter', fn($d) => ['n' => ($d['n'] ?? 0) + 1]);
        $store->mutate('counter', fn($d) => ['n' => ($d['n'] ?? 0) + 1]);
        T::equal($store->read('counter')['n'], 2);
    });
    T::it('leaves no temp files behind', function () use ($sandbox) {
        T::equal(count(glob($sandbox . '/*.tmp')), 0);
    });
    T::it('keeps a path-traversing name inside the data directory', function () use ($store, $sandbox) {
        // "../escape" must land in the sandbox, not one level up.
        $store->write('../escape', ['x' => 1]);
        T::ok(file_exists($sandbox . '/escape.json'), 'name was not sanitised into the data dir');
        T::ok(!file_exists(dirname($sandbox) . '/escape.json'), 'escaped the data dir');
    });
    T::it('refuses an empty name outright', function () use ($store) {
        try { $store->read(''); } catch (InvalidArgumentException $e) { return; }
        throw new RuntimeException('expected a throw');
    });
    T::it('deletes', function () use ($store) {
        $store->write('temp', ['x' => 1]);
        $store->delete('temp');
        T::ok(!$store->exists('temp'));
    });
});

T::describe('stream key encryption', function () {
    T::it('round-trips a key', function () {
        $secret = sv_encrypt('live_123456_supersecret');
        T::ok($secret !== 'live_123456_supersecret', 'stored in the clear');
        T::equal(sv_decrypt($secret), 'live_123456_supersecret');
    });
    T::it('produces a different ciphertext each time', function () {
        T::ok(sv_encrypt('same') !== sv_encrypt('same'), 'deterministic ciphertext leaks equality');
    });
    T::it('refuses a tampered ciphertext', function () {
        $blob = sv_encrypt('hunter2');
        $tampered = substr($blob, 0, -4) . 'AAAA';
        T::equal(sv_decrypt($tampered), '');
    });
    T::it('handles the empty string', fn() => T::equal(sv_encrypt(''), ''));
    T::it('still reads the first fallback format', function () {
        // v0 blobs exist in installs that predated the nonce, and must keep
        // decrypting or the user silently loses their stream keys.
        $key = sv_secret_key();
        $plain = 'legacy_key_value';
        $stream = '';
        for ($i = 0; $i < strlen($plain); $i += 32) $stream .= hash('sha256', $key . $i, true);
        $blob = 'v0:' . base64_encode($plain ^ substr($stream, 0, strlen($plain)));
        T::equal(sv_decrypt($blob), $plain);
    });
});

T::describe('the no-OpenSSL fallback', function () {
    T::it('round-trips', function () {
        $nonce = random_bytes(16);
        $key = sv_secret_key();
        $ct = 'hunter2hunter2' ^ sv_keystream($key, $nonce, 14);
        $mac = hash_hmac('sha256', $nonce . $ct, $key, true);
        T::equal(sv_decrypt('v2:' . base64_encode($nonce . $mac . $ct)), 'hunter2hunter2');
    });
    T::it('never reuses a keystream', function () {
        $key = sv_secret_key();
        $a = sv_keystream($key, str_repeat("\x01", 16), 32);
        $b = sv_keystream($key, str_repeat("\x02", 16), 32);
        T::ok($a !== $b, 'the same keystream for two nonces');
    });
    T::it('rejects a tampered blob', function () {
        $nonce = random_bytes(16);
        $key = sv_secret_key();
        $ct = 'secret' ^ sv_keystream($key, $nonce, 6);
        $mac = hash_hmac('sha256', $nonce . $ct, $key, true);
        $blob = 'v2:' . base64_encode($nonce . $mac . ($ct ^ str_repeat("\x01", 6)));
        T::equal(sv_decrypt($blob), '');
    });
});

T::describe('passwords', function () {
    T::it('hashes with a real algorithm', function () {
        $hash = Auth::hash('correct horse battery staple');
        T::ok(password_verify('correct horse battery staple', $hash));
        T::ok(!password_verify('wrong', $hash));
    });
    T::it('compares tokens without leaking length by early exit', function () {
        T::ok(sv_equals('abc', 'abc'));
        T::ok(!sv_equals('abc', 'abd'));
        T::ok(!sv_equals('abc', 'abcd'));
    });
});

T::describe('time helpers', function () {
    T::it('clamps', function () {
        T::equal(sv_clamp(5, 0, 3), 3.0);
        T::equal(sv_clamp(-1, 0, 3), 0.0);
        T::equal(sv_clamp(2, 0, 3), 2.0);
    });
});

exit(T::report('php'));
