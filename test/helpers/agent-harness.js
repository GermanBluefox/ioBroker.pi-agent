'use strict';

// Runs the real main.js against a stand-in for @iobroker/adapter-core and the faux model of pi-ai.
// States, objects and foreign writes live in <dataDir>/fake-db.json, so they survive a killed process.

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const NAMESPACE = 'pi-agent.0';

class FakeDb {
    constructor(dataDir, seed = {}) {
        this.file = path.join(dataDir, 'fake-db.json');
        if (fs.existsSync(this.file)) {
            Object.assign(this, JSON.parse(fs.readFileSync(this.file, 'utf8')));
        } else {
            this.states = seed.states || {};
            this.objects = seed.objects || {};
            this.writes = [];
            this.save();
        }
    }

    save() {
        const { states, objects, writes } = this;
        fs.writeFileSync(this.file, JSON.stringify({ states, objects, writes }));
    }

    setState(id, state) {
        this.states[id] = { ...state, ts: state.ts ?? Date.now() };
        this.save();
    }
}

/**
 * Create the stand-in module for @iobroker/adapter-core.
 *
 * @param {object} hooks optional async hooks: getForeignState(id), setForeignState(id, state)
 * @returns {object} module exports
 */
function fakeAdapterCore(hooks) {
    class Adapter extends EventEmitter {
        constructor(options) {
            super();
            this.name = options.name;
            this.namespace = NAMESPACE;
            this.config = options.config;
            this.dataDir = options.dataDir;
            this.db = options.db;
            this.logs = [];
            this.sent = [];
            this.log = Object.fromEntries(
                ['debug', 'info', 'warn', 'error'].map(level => [level, msg => this.logs.push([level, msg])]),
            );
        }
        async setStateAsync(id, state) {
            this.db.setState(`${NAMESPACE}.${id}`, state);
        }
        async getStateAsync(id) {
            return this.db.states[`${NAMESPACE}.${id}`] ?? null;
        }
        async subscribeStatesAsync() {}
        async getForeignStateAsync(id) {
            await hooks.getForeignState?.(id);
            return this.db.states[id] ?? null;
        }
        async getForeignStatesAsync(ids) {
            return Object.fromEntries(ids.filter(id => this.db.states[id]).map(id => [id, this.db.states[id]]));
        }
        async getForeignObjectAsync(id) {
            return this.db.objects[id] ?? null;
        }
        async getObjectViewAsync(design, search, params) {
            const type = search === 'instance' ? 'instance' : 'state';
            const rows = Object.keys(this.db.objects)
                .sort()
                .filter(id => this.db.objects[id].type === type && id >= params.startkey && id <= params.endkey)
                .map(id => ({ id, value: this.db.objects[id] }));
            return { rows };
        }
        async setForeignStateAsync(id, state) {
            this.db.writes.push([id, state.val]);
            this.db.setState(id, state);
            await hooks.setForeignState?.(id, state);
        }
        sendTo(...args) {
            this.sent.push(args);
        }
    }
    return { Adapter, getAbsoluteInstanceDataDir: adapter => adapter.dataDir };
}

/**
 * Start one agent instance on a data directory.
 *
 * @param {object} options
 * @param {string} options.dataDir directory for the conversation store and the fake database
 * @param {object} [options.config] native configuration (apiKey, writeAllow, dryRun, ...)
 * @param {object} [options.seed] initial { states, objects } of the fake database
 * @param {Array} options.responses faux responses (messages or factories) for this instance
 * @param {object} [options.hooks] hooks of the fake adapter
 * @returns {Promise<{ agent: object, adapter: object, db: FakeDb, faux: object }>} running instance
 */
async function startAgent({ dataDir, config = {}, seed, responses, hooks = {} }) {
    const fauxModule = await import('@earendil-works/pi-ai/providers/faux');
    const { createModels } = await import('@earendil-works/pi-ai/models');
    const faux = fauxModule.fauxProvider({ provider: 'faux' });
    faux.setResponses(responses);

    const mainPath = require.resolve('../../main.js');
    const providersPath = require.resolve('../../lib/providers.js');
    const corePath = require.resolve('@iobroker/adapter-core');
    const realProviders = require(providersPath);
    delete require.cache[mainPath];
    require.cache[corePath] = { id: corePath, filename: corePath, loaded: true, exports: fakeAdapterCore(hooks) };
    require.cache[providersPath] = {
        id: providersPath,
        filename: providersPath,
        loaded: true,
        exports: {
            ...realProviders,
            createModelsWithKey: async () => {
                const models = createModels();
                models.setProvider(faux.provider);
                return { spec: { defaultModel: faux.getModel().id }, models };
            },
        },
    };
    try {
        const createAgent = require(mainPath);
        const db = new FakeDb(dataDir, seed);
        const agent = createAgent({
            dataDir,
            db,
            config: { provider: 'faux', modelId: '', apiKey: 'test', writeAllow: '', dryRun: true, ...config },
        });
        agent.emit('ready');
        await agent.readyPromise;
        return { agent, adapter: agent, db, faux };
    } finally {
        delete require.cache[providersPath];
        delete require.cache[corePath];
    }
}

/** Stop an instance the way js-controller does and wait for the unload callback. */
function stopAgent(agent) {
    return new Promise(resolve => agent.emit('unload', resolve));
}

/** Wait until a condition holds (polling, for asynchronous effects of the agent). */
async function waitFor(condition, what, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await condition()) {
            return;
        }
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

module.exports = { startAgent, stopAgent, waitFor, NAMESPACE };
