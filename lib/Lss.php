<?php
require_once __DIR__ . '/Util.php';

/**
 * LiveSplit .lss reader/writer.
 *
 * The studio's native timer keeps splits in a compact JSON shape; this class
 * is the bridge to and from the real LiveSplit file format so a speedrunner
 * can drop in the splits they already have and take them back out unharmed.
 *
 * Internal shape:
 * [
 *   'game' => string, 'category' => string, 'offset' => float (seconds),
 *   'attempts' => int, 'platform' => string, 'region' => string,
 *   'variables' => [name => value],
 *   'segments' => [ ['name'=>..,'pb'=>float|null,'pbGame'=>float|null,
 *                    'best'=>float|null,'comparisons'=>[name=>float],'icon'=>string] ],
 *   'history' => [ ['id'=>int,'started'=>string,'ended'=>string,'real'=>float|null,'game'=>float|null] ]
 * ]
 */
class Lss
{
    /** "01:23:45.678" / "1.02:03:04" / "" -> seconds (float) or null */
    public static function parseTime($text)
    {
        $text = trim((string)$text);
        if ($text === '') return null;
        $sign = 1;
        if ($text[0] === '-') { $sign = -1; $text = substr($text, 1); }
        $days = 0;
        // .NET TimeSpan may prefix days with "d." — only when the first chunk
        // has no colon after it being followed by another dotted group.
        if (preg_match('/^(\d+)\.(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)$/', $text, $m)) {
            $days = (int)$m[1];
            $text = $m[2];
        }
        $parts = explode(':', $text);
        $seconds = 0.0;
        foreach ($parts as $part) $seconds = $seconds * 60 + (float)$part;
        return $sign * ($seconds + $days * 86400);
    }

    /** seconds -> "HH:MM:SS.fffffff" the way LiveSplit writes it */
    public static function formatTime($seconds)
    {
        if ($seconds === null || $seconds === '') return null;
        $seconds = (float)$seconds;
        $sign = $seconds < 0 ? '-' : '';
        $seconds = abs($seconds);
        $h = (int)floor($seconds / 3600);
        $m = (int)floor(fmod($seconds, 3600) / 60);
        $s = fmod($seconds, 60);
        return sprintf('%s%02d:%02d:%010.7f', $sign, $h, $m, $s);
    }

    public static function parse($xmlString)
    {
        $prev = libxml_use_internal_errors(true);
        // LIBXML_NONET: never let a crafted splits file pull a remote entity.
        $flags = LIBXML_NONET;
        if (defined('LIBXML_NOENT')) { /* deliberately not set */ }
        $xml = simplexml_load_string($xmlString, 'SimpleXMLElement', $flags);
        libxml_use_internal_errors($prev);
        if ($xml === false) throw new RuntimeException('not a valid .lss file');
        if (strtolower($xml->getName()) !== 'run') throw new RuntimeException('root element is not <Run>');

        $out = [
            'game' => (string)$xml->GameName,
            'category' => (string)$xml->CategoryName,
            'offset' => self::parseTime((string)$xml->Offset) ?: 0.0,
            'attempts' => (int)(string)$xml->AttemptCount,
            'platform' => '',
            'region' => '',
            'variables' => [],
            'segments' => [],
            'history' => [],
        ];

        if (isset($xml->Metadata)) {
            $out['platform'] = (string)($xml->Metadata->Platform ?? '');
            $out['region'] = (string)($xml->Metadata->Region ?? '');
            if (isset($xml->Metadata->Variables)) {
                foreach ($xml->Metadata->Variables->Variable as $var) {
                    $out['variables'][(string)$var['name']] = (string)$var;
                }
            }
        }

        if (isset($xml->AttemptHistory)) {
            foreach ($xml->AttemptHistory->Attempt as $att) {
                $out['history'][] = [
                    'id' => (int)$att['id'],
                    'started' => (string)$att['started'],
                    'ended' => (string)$att['ended'],
                    'real' => self::parseTime((string)$att->RealTime),
                    'game' => self::parseTime((string)$att->GameTime),
                ];
            }
        }

        if (isset($xml->Segments)) {
            foreach ($xml->Segments->Segment as $seg) {
                $comparisons = [];
                $pb = null; $pbGame = null;
                if (isset($seg->SplitTimes)) {
                    foreach ($seg->SplitTimes->SplitTime as $st) {
                        $name = (string)$st['name'];
                        $real = self::parseTime((string)$st->RealTime);
                        $game = self::parseTime((string)$st->GameTime);
                        if ($name === 'Personal Best') { $pb = $real; $pbGame = $game; }
                        else if ($real !== null) $comparisons[$name] = $real;
                    }
                }
                $out['segments'][] = [
                    'name' => (string)$seg->Name,
                    'pb' => $pb,
                    'pbGame' => $pbGame,
                    'best' => isset($seg->BestSegmentTime) ? self::parseTime((string)$seg->BestSegmentTime->RealTime) : null,
                    'bestGame' => isset($seg->BestSegmentTime) ? self::parseTime((string)$seg->BestSegmentTime->GameTime) : null,
                    'comparisons' => $comparisons,
                    'icon' => '',
                ];
            }
        }
        $out['pbTime'] = $out['segments'] ? end($out['segments'])['pb'] : null;
        return $out;
    }

    public static function build(array $run)
    {
        $x = new XMLWriter();
        $x->openMemory();
        $x->setIndent(true);
        $x->setIndentString('  ');
        $x->startDocument('1.0', 'UTF-8');
        $x->startElement('Run');
        $x->writeAttribute('version', '1.7.0');
        $x->writeElement('GameIcon', '');
        $x->writeElement('GameName', (string)($run['game'] ?? ''));
        $x->writeElement('CategoryName', (string)($run['category'] ?? ''));

        $x->startElement('Metadata');
        $x->startElement('Run'); $x->writeAttribute('id', ''); $x->endElement();
        $x->startElement('Platform'); $x->writeAttribute('usesEmulator', 'False');
        $x->text((string)($run['platform'] ?? '')); $x->endElement();
        $x->writeElement('Region', (string)($run['region'] ?? ''));
        $x->startElement('Variables');
        foreach (($run['variables'] ?? []) as $k => $v) {
            $x->startElement('Variable');
            $x->writeAttribute('name', (string)$k);
            $x->text((string)$v);
            $x->endElement();
        }
        $x->endElement(); // Variables
        $x->endElement(); // Metadata

        $x->writeElement('Offset', self::formatTime($run['offset'] ?? 0) ?: '00:00:00');
        $x->writeElement('AttemptCount', (string)(int)($run['attempts'] ?? 0));

        $x->startElement('AttemptHistory');
        foreach (($run['history'] ?? []) as $att) {
            $x->startElement('Attempt');
            $x->writeAttribute('id', (string)(int)($att['id'] ?? 0));
            if (!empty($att['started'])) {
                $x->writeAttribute('started', $att['started']);
                $x->writeAttribute('isStartedSynced', 'True');
            }
            if (!empty($att['ended'])) {
                $x->writeAttribute('ended', $att['ended']);
                $x->writeAttribute('isEndedSynced', 'True');
            }
            if (isset($att['real']) && $att['real'] !== null) $x->writeElement('RealTime', self::formatTime($att['real']));
            if (isset($att['game']) && $att['game'] !== null) $x->writeElement('GameTime', self::formatTime($att['game']));
            $x->endElement();
        }
        $x->endElement(); // AttemptHistory

        $x->startElement('Segments');
        foreach (($run['segments'] ?? []) as $seg) {
            $x->startElement('Segment');
            $x->writeElement('Name', (string)($seg['name'] ?? ''));
            $x->writeElement('Icon', '');
            $x->startElement('SplitTimes');
            $split = ['Personal Best' => $seg['pb'] ?? null] + (array)($seg['comparisons'] ?? []);
            foreach ($split as $name => $value) {
                $x->startElement('SplitTime');
                $x->writeAttribute('name', (string)$name);
                if ($value !== null) $x->writeElement('RealTime', self::formatTime($value));
                if ($name === 'Personal Best' && isset($seg['pbGame']) && $seg['pbGame'] !== null) {
                    $x->writeElement('GameTime', self::formatTime($seg['pbGame']));
                }
                $x->endElement();
            }
            $x->endElement(); // SplitTimes
            $x->startElement('BestSegmentTime');
            if (isset($seg['best']) && $seg['best'] !== null) $x->writeElement('RealTime', self::formatTime($seg['best']));
            if (isset($seg['bestGame']) && $seg['bestGame'] !== null) $x->writeElement('GameTime', self::formatTime($seg['bestGame']));
            $x->endElement();
            $x->writeElement('SegmentHistory', '');
            $x->endElement(); // Segment
        }
        $x->endElement(); // Segments
        $x->writeElement('AutoSplitterSettings', '');
        $x->endElement(); // Run
        $x->endDocument();
        return $x->outputMemory();
    }
}
