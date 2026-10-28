'use strict';

/**
 * Where the API key comes from (native.keySource):
 *  - "adapter": the encrypted field apiKey of this instance (as up to 0.2.0)
 *  - "central": a credential of the central credential store of admin 8 (system.credentials.*);
 *               native.credentialId names it, the key is read and decrypted at runtime.
 *  - "system":  the system-wide AI settings of admin (object system.ai, tab "AI" of the system settings):
 *               provider, model, base URL and credential all come from there.
 */
const KEY_SOURCES = ['adapter', 'central', 'system'];

/** ID of the object with the system-wide AI settings, written by the system settings of admin. */
const SYSTEM_AI_OBJECT_ID = 'system.ai';

/** Provider names of system.ai -> provider names of this adapter (see PROVIDERS in providers.js). */
const SYSTEM_PROVIDERS = {
    anthropic: 'anthropic',
    openai: 'openai',
    gemini: 'google',
    deepseek: 'deepseek',
    openrouter: 'openrouter',
    custom: 'custom',
};

/** The fields of system.ai that this adapter uses; a change of any other field (e.g. hideFab) does not matter. */
const SYSTEM_AI_FIELDS = ['provider', 'model', 'credentialId', 'baseUrl'];

/**
 * Key source of a configuration; anything unknown is the key of the adapter.
 *
 * @param {{ keySource?: unknown }} config native configuration or unsaved form values
 * @returns {'adapter' | 'central' | 'system'} key source
 */
function keySourceOf(config) {
    return config.keySource === 'central' || config.keySource === 'system' ? config.keySource : 'adapter';
}

/**
 * Whether a configuration takes the system-wide AI settings: it says so, or it sets up no provider of its own.
 * An instance nobody configured (no key in the adapter, not a keyless custom server) uses what was set up once
 * for the whole system in admin, as the adapters built on `@iobroker/ai-core` do.
 *
 * @param {{ keySource?: unknown, apiKey?: unknown, provider?: unknown }} config native configuration or form values
 * @returns {boolean} true for the system-wide settings
 */
function usesSystemAi(config) {
    const source = keySourceOf(config);
    if (source !== 'adapter') {
        return source === 'system';
    }
    return !String(config.apiKey || '').trim() && config.provider !== 'custom';
}

/**
 * The provider settings of system.ai in the shape of this adapter's configuration: a credential of the
 * central store, the provider renamed where this adapter calls it differently.
 *
 * @param {Record<string, unknown> | null | undefined} native the native of system.ai
 * @returns {{ provider: string, modelId: string, baseUrl: string, keySource: 'central', apiKey: string, credentialId: string } | null} settings, null when no known provider is set up
 */
function systemAiForm(native) {
    const cfg = Object(native);
    const provider = SYSTEM_PROVIDERS[String(cfg.provider || '')];
    if (!provider) {
        return null;
    }
    return {
        provider,
        modelId: String(cfg.model || '').trim(),
        baseUrl: provider === 'custom' ? String(cfg.baseUrl || '').trim() : '',
        keySource: 'central',
        apiKey: '',
        credentialId: String(cfg.credentialId || '').trim(),
    };
}

/**
 * The fields of system.ai this adapter uses, to tell a relevant change from an irrelevant one.
 *
 * @param {ioBroker.Object | null | undefined} obj system.ai
 * @returns {string} comparable text
 */
function systemAiFingerprint(obj) {
    const native = Object(obj?.native);
    return JSON.stringify(SYSTEM_AI_FIELDS.map(field => native[field] ?? ''));
}

/**
 * Read system.ai. A missing object, or one the instance may not read, gives null.
 *
 * @param {ioBroker.Adapter} adapter adapter instance
 * @returns {Promise<ioBroker.Object | null>} the object
 */
async function readSystemAi(adapter) {
    try {
        return (await adapter.getForeignObjectAsync(SYSTEM_AI_OBJECT_ID)) || null;
    } catch {
        return null;
    }
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

module.exports = {
    KEY_SOURCES,
    SYSTEM_AI_OBJECT_ID,
    keySourceOf,
    usesSystemAi,
    systemAiForm,
    systemAiFingerprint,
    readSystemAi,
    resolveApiKey,
};
