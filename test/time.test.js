'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isValidTimeZone,
    resolveTimeZone,
    parseLocalTime,
    formatLocal,
    offsetMinutes,
    timeZoneOptions,
} = require('../lib/time');

const BERLIN = 'Europe/Berlin';
const utc = text => Date.parse(text);

test('time zone: valid names pass, a wrong name falls back to the server zone with a warning', () => {
    assert.ok(isValidTimeZone(BERLIN));
    assert.ok(!isValidTimeZone('Berlin'));
    const warnings = [];
    const zone = resolveTimeZone('Berlin', { warn: m => warnings.push(m) });
    assert.equal(zone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.match(warnings[0], /Unknown time zone "Berlin"/);
    assert.equal(resolveTimeZone(BERLIN, { warn: () => assert.fail('no warning') }), BERLIN);
    assert.equal(resolveTimeZone('', { warn: () => assert.fail('no warning') }), zone);
});

test('offset: Berlin is UTC+1 in winter and UTC+2 in summer', () => {
    assert.equal(offsetMinutes(utc('2026-01-15T12:00:00Z'), BERLIN), 60);
    assert.equal(offsetMinutes(utc('2026-07-15T12:00:00Z'), BERLIN), 120);
});

test('"HH:MM" is today in the house time zone, or tomorrow when already past', () => {
    const now = utc('2026-10-26T15:00:00Z'); // 16:00 in Berlin
    assert.equal(parseLocalTime('18:00', BERLIN, now), utc('2026-10-26T17:00:00Z'));
    assert.equal(parseLocalTime('09:30', BERLIN, now), utc('2026-10-27T08:30:00Z'));
});

test('dates with time are local; the daylight saving switch is respected', () => {
    const now = utc('2026-10-20T10:00:00Z');
    // 25.10.2026 is the switch to winter time: 24.10. is CEST (UTC+2), 26.10. is CET (UTC+1)
    assert.equal(parseLocalTime('2026-10-24 18:00', BERLIN, now), utc('2026-10-24T16:00:00Z'));
    assert.equal(parseLocalTime('2026-10-26T18:00', BERLIN, now), utc('2026-10-26T17:00:00Z'));
    assert.equal(parseLocalTime('27.10.2026 18:00', BERLIN, now), utc('2026-10-27T17:00:00Z'));
    assert.equal(parseLocalTime('27.10. 18:00', BERLIN, now), utc('2026-10-27T17:00:00Z'));
    // a day without year that has passed means next year
    assert.equal(parseLocalTime('01.01. 08:00', BERLIN, now), utc('2027-01-01T07:00:00Z'));
});

test('an ISO time with a zone is taken as it is; nonsense is NaN', () => {
    assert.equal(parseLocalTime('2026-10-27T18:00:00Z', BERLIN), utc('2026-10-27T18:00:00Z'));
    assert.equal(parseLocalTime('2026-10-27T18:00+02:00', BERLIN), utc('2026-10-27T16:00:00Z'));
    assert.ok(Number.isNaN(parseLocalTime('tomorrow', BERLIN)));
    assert.ok(Number.isNaN(parseLocalTime('25:00', BERLIN)));
});

test('local time is written with the zone name', () => {
    const ts = utc('2026-10-25T23:55:27Z');
    assert.equal(formatLocal(ts, BERLIN), '2026-10-26 00:55 (Europe/Berlin)');
    assert.equal(formatLocal(ts, BERLIN, { seconds: true, zone: false }), '2026-10-26 00:55:27');
});

test('timeZoneOptions: the server zone first, then every zone with its offset at that instant', () => {
    const winter = timeZoneOptions(utc('2026-01-15T12:00:00Z'));
    const summer = timeZoneOptions(utc('2026-07-15T12:00:00Z'));
    assert.equal(winter[0].value, '');
    assert.match(winter[0].label, /^Server: /);
    const label = (list, zone) => list.find(o => o.value === zone)?.label;
    assert.equal(label(winter, BERLIN), 'Europe/Berlin (UTC+01:00)');
    assert.equal(label(summer, BERLIN), 'Europe/Berlin (UTC+02:00)');
    assert.equal(label(winter, 'America/New_York'), 'America/New_York (UTC-05:00)');
    assert.equal(label(winter, 'UTC'), 'UTC (UTC+00:00)');
    const values = winter.slice(1).map(o => o.value);
    assert.equal(new Set(values).size, values.length);
    assert.ok(values.every(isValidTimeZone));
});
