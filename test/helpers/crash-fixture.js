'use strict';

/** One writable lamp that is on the allowlist; shared by the crash child and the test. */
const CRASH_SEED = {
    objects: {
        'x.0.lamp': { type: 'state', common: { name: 'Lamp', type: 'boolean', role: 'switch', write: true } },
    },
    states: { 'x.0.lamp': { val: false, ack: true, ts: 1 } },
};

const CRASH_CONFIG = { writeAllow: '^x\\.0\\.', dryRun: false };

module.exports = { CRASH_SEED, CRASH_CONFIG };
