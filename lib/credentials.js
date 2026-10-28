'use strict';

/**
 * Where the API key comes from (native.keySource):
 *  - "adapter": the encrypted field apiKey of this instance (default, as up to 0.2.0)
 *  - "central": a credential of the central credential store of admin 8 (system.credentials.*);
 *               native.credentialId names it, the key is read and decrypted at runtime.
 */
const KEY_SOURCES = ['adapter', 'central'];

/**
 * Key source of a configuration; anything unknown is the key of the adapter.
 *
 * @param {{ keySource?: unknown }} config native configuration or unsaved form values
 * @returns {'adapter' | 'central'} key source
 */
function keySourceOf(config) {
    return config.keySource === 'central' ? 'central' : 'adapter';
}

/**
 * The API key of a configuration.
 *
 * @param {ioBroker.Adapter} adapter adapter instance (reads the credential object)
 * @param {{ keySource?: unknown, apiKey?: unknown, credentialId?: unknown }} config native configuration or unsaved form values
 * @returns {Promise<string>} the key, empty when none is set
 */
async function resolveApiKey(adapter, config) {
    if (keySourceOf(config) === 'adapter') {
        return String(config.apiKey || '').trim();
    }
    const id = String(config.credentialId || '').trim();
    if (!id) {
        return '';
    }
    const { getCredentials } = require('@iobroker/adapter-core/credentials');
    const credential = await getCredentials(adapter, id);
    return String(Object(credential?.values).key || '').trim();
}

module.exports = { KEY_SOURCES, keySourceOf, resolveApiKey };
