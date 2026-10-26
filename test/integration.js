'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const { tests } = require('@iobroker/testing');

// Starts a real js-controller with this adapter and checks that it starts and keeps running.
// Without an API key the agent stays idle and logs why, which is the expected state here.
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('messagebox', getHarness => {
            // A real sendTo through js-controller: it only arrives when the messagebox is really enabled
            // (a common.supportedMessages with only false values had switched it off in 0.0.1-0.0.4).
            it('answers sendTo "listModels" for the model field of the admin page', async function () {
                this.timeout(60_000);
                const harness = getHarness();
                await harness.startAdapterAndWait();
                const options = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('no answer to sendTo')), 20_000);
                    harness.sendTo('pi-agent.0', 'listModels', { provider: 'deepseek' }, answer => {
                        clearTimeout(timer);
                        resolve(answer);
                    });
                });
                assert.ok(Array.isArray(options), JSON.stringify(options));
                assert.equal(options[0].label, 'Default (deepseek-flash)');
                assert.ok(options.some(o => o.value === 'deepseek-v4-pro'));
            });
        });
    },
});
