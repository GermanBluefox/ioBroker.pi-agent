'use strict';

// Local time for the model: the time zone of the house, written and read like a person would.

/**
 * Whether a string is a time zone Intl knows (IANA name such as "Europe/Berlin").
 *
 * @param {string} zone time zone name
 * @returns {boolean} true when it can be used
 */
function isValidTimeZone(zone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/**
 * The time zone to use: the configured one when valid, otherwise the one of the server process.
 *
 * @param {string} configured value of the setting, may be empty
 * @param {{ warn: (msg: string) => void }} log logger for an invalid value
 * @returns {string} IANA time zone
 */
function resolveTimeZone(configured, log) {
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const zone = String(configured || '').trim();
    if (!zone) {
        return system;
    }
    if (!isValidTimeZone(zone)) {
        log.warn(`Unknown time zone "${zone}"; using the time zone of the server (${system})`);
        return system;
    }
    return zone;
}

/**
 * Calendar fields of an instant in a time zone.
 *
 * @param {number} ts instant (ms)
 * @param {string} zone IANA time zone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} fields
 */
function fieldsIn(ts, zone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
    }).formatToParts(new Date(ts));
    const get = type => Number(parts.find(p => p.type === type)?.value);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
        second: get('second'),
    };
}

/**
 * Offset of a time zone from UTC at an instant, in minutes (Berlin in winter: 60).
 *
 * @param {number} ts instant (ms)
 * @param {string} zone IANA time zone
 * @returns {number} offset in minutes
 */
function offsetMinutes(ts, zone) {
    const f = fieldsIn(ts, zone);
    const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
    return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60_000);
}

/**
 * The instant of a local wall-clock time in a time zone (daylight saving time included).
 *
 * @param {{ year: number, month: number, day: number, hour: number, minute: number }} local wall-clock time
 * @param {string} zone IANA time zone
 * @returns {number} instant (ms)
 */
function localToUtc(local, zone) {
    const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    // two rounds settle the offset also right next to a daylight saving time switch
    let ts = naive - offsetMinutes(naive, zone) * 60_000;
    ts = naive - offsetMinutes(ts, zone) * 60_000;
    return ts;
}

/**
 * Read a time as the user or the model writes it.
 *
 * "18:00" (today, or tomorrow when already past), "2026-10-27 18:00", "2026-10-27T18:00", "27.10.2026 18:00",
 * "27.10. 18:00" (this year, or next year when already past) are local times in the given zone; an ISO time
 * with "Z" or an offset is taken as it is.
 *
 * @param {string} input time text
 * @param {string} zone IANA time zone of the house
 * @param {number} [now] current instant (ms)
 * @returns {number} instant (ms), NaN when the text is not understood
 */
function parseLocalTime(input, zone, now = Date.now()) {
    const text = String(input || '').trim();
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) && /^\d{4}-\d{2}-\d{2}T/.test(text)) {
        return Date.parse(text);
    }
    const today = fieldsIn(now, zone);
    let m = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (m) {
        const local = { ...today, hour: Number(m[1]), minute: Number(m[2]) };
        let ts = localToUtc(local, zone);
        if (ts <= now) {
            const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
            ts = localToUtc(
                {
                    year: next.getUTCFullYear(),
                    month: next.getUTCMonth() + 1,
                    day: next.getUTCDate(),
                    hour: local.hour,
                    minute: local.minute,
                },
                zone,
            );
        }
        return valid(local.hour, local.minute) ? ts : NaN;
    }
    m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
    if (m) {
        const [, y, mo, d, h, mi] = m.map(Number);
        return valid(h, mi) ? localToUtc({ year: y, month: mo, day: d, hour: h, minute: mi }, zone) : NaN;
    }
    m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?,?\s+(\d{1,2}):(\d{2})$/.exec(text);
    if (m) {
        const [, d, mo, y, h, mi] = m;
        if (!valid(Number(h), Number(mi))) {
            return NaN;
        }
        const at = year =>
            localToUtc({ year, month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi) }, zone);
        if (y) {
            return at(Number(y));
        }
        const thisYear = at(today.year);
        return thisYear > now ? thisYear : at(today.year + 1);
    }
    return NaN;
}

/**
 * @param {number} hour hour
 * @param {number} minute minute
 * @returns {boolean} true for a real clock time
 */
function valid(hour, minute) {
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * An instant as local time, e.g. "2026-10-27 18:00 (Europe/Berlin)".
 *
 * @param {number} ts instant (ms)
 * @param {string} zone IANA time zone
 * @param {{ seconds?: boolean, zone?: boolean }} [options] show seconds / append the zone name (default: zone yes)
 * @returns {string} local time text
 */
function formatLocal(ts, zone, options = {}) {
    const f = fieldsIn(ts, zone);
    const two = n => String(n).padStart(2, '0');
    const time = `${two(f.hour)}:${two(f.minute)}${options.seconds ? `:${two(f.second)}` : ''}`;
    const text = `${f.year}-${two(f.month)}-${two(f.day)} ${time}`;
    return options.zone === false ? text : `${text} (${zone})`;
}

/**
 * Choices for the time zone field of the admin page: empty (the server's) first, then every IANA zone Node.js
 * knows with its current offset from UTC, e.g. "Europe/Berlin (UTC+01:00)".
 *
 * @param {number} [now] instant of the offsets (ms)
 * @returns {Array<{ value: string, label: string, noTranslation: boolean }>} options for autocompleteSendTo
 */
function timeZoneOptions(now = Date.now()) {
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const offset = zone => {
        const minutes = offsetMinutes(now, zone);
        const abs = Math.abs(minutes);
        const hh = String(Math.floor(abs / 60)).padStart(2, '0');
        const mm = String(abs % 60).padStart(2, '0');
        return `UTC${minutes < 0 ? '-' : '+'}${hh}:${mm}`;
    };
    const zones = Intl.supportedValuesOf('timeZone');
    if (!zones.includes('UTC')) {
        zones.push('UTC');
    }
    return [
        { value: '', label: `Server: ${system} (${offset(system)})`, noTranslation: true },
        ...zones.map(zone => ({ value: zone, label: `${zone} (${offset(zone)})`, noTranslation: true })),
    ];
}

module.exports = { isValidTimeZone, resolveTimeZone, parseLocalTime, formatLocal, offsetMinutes, timeZoneOptions };
