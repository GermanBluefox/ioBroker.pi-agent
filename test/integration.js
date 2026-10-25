'use strict';

const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Starts a real js-controller with this adapter and checks that it starts and keeps running.
// Without an API key the agent stays idle and logs why, which is the expected state here.
tests.integration(path.join(__dirname, '..'));
