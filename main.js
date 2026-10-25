'use strict';

const utils = require('@iobroker/adapter-core');
const crypto = require('node:crypto');
const { parseAllowlist, requestIdFor } = require('./lib/guard');
const { createIoBrokerExtension } = require('./lib/tools');
const { createModelsWithKey } = require('./lib/providers');

/**
 * Text blocks of the model messages of one transcript entry.
 *
 * @param {ReadonlyArray<{ content?: string | ReadonlyArray<{ type: string, text?: string }> }>} messages model messages
 * @returns {string} the text blocks joined by newlines, empty when there are none
 */
function answerText(messages) {
    return messages
        .flatMap(m => (Array.isArray(m.content) ? m.content : []))
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
}

class PiAgent extends utils.Adapter {
    /** @param {Partial<utils.AdapterOptions>} [options] adapter options */
    constructor(options = {}) {
        super({ ...options, name: 'pi-agent' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.harness = null;
        this.root = null;
        this.context = null;
        this.allowlist = [];
        /** Set in onUnload: errors from the closing harness are interruptions, not failures. */
        this.stopping = false;
        /** Runs are serialised: one conversation, one run at a time. */
        this.queue = Promise.resolve();
        this.readyPromise = new Promise(resolve => {
            this.markReady = resolve;
        });
    }

    async onReady() {
        try {
            await this.setStateAsync('info.connection', { val: false, ack: true });
            this.allowlist = parseAllowlist(this.config.writeAllow, (line, msg) =>
                this.log.warn(`Ignoring invalid allowlist line "${line}": ${msg}`),
            );
            if (this.allowlist.length === 0) {
                this.log.warn('The write allowlist is empty: the agent can read but not write anything.');
            }
            if (this.config.dryRun) {
                this.log.info('Dry run is on: write requests are logged but not executed.');
            }

            if (!this.config.apiKey) {
                // A setting the user still has to make, not a fault: stay idle and say what is missing.
                this.log.warn(
                    'No API key configured. Enter it in the instance settings; the agent stays idle until then.',
                );
                this.markReady();
                return;
            }

            await this.startHarness();
            await this.subscribeStatesAsync('chat.input');
            await this.setStateAsync('info.connection', { val: true, ack: true });
            this.markReady();

            // A request that was cut off by a crash is picked up again with the same requestId.
            await this.resumePending();
        } catch (e) {
            this.log.error(`Start failed: ${e.message}`);
            this.markReady();
        }
    }

    /** Load the ESM packages and open the durable harness on the instance data directory. */
    async startHarness() {
        // The key goes into an in-memory credential store of this instance, never into the process environment.
        const { spec, models } = await createModelsWithKey(this.config.provider, this.config.apiKey);
        const modelId = String(this.config.modelId || '').trim() || spec.defaultModel;

        const [{ BACKGROUND_CONTEXT }, durable, jsonl, ai] = await Promise.all([
            import('@earendil-works/chord/context'),
            import('@earendil-works/pi-durable'),
            import('@earendil-works/pi-durable/storage/jsonl/node'),
            import('@earendil-works/pi-ai'),
        ]);
        this.context = BACKGROUND_CONTEXT;

        const registry = durable.createRegistry();
        registry.install(
            createIoBrokerExtension(this, { ...durable, Type: ai.Type }, () => ({
                allowlist: this.allowlist,
                dryRun: Boolean(this.config.dryRun),
                instructions: String(this.config.instructions || ''),
            })),
        );

        const dir = utils.getAbsoluteInstanceDataDir(this);
        const storage = await jsonl.openNodeJsonlStorage(`${dir}/session`, this.context);
        this.harness = await durable.Harness.open(storage, { models, registry }, this.context);

        const model = { provider: this.config.provider, modelId };
        this.root = await this.harness.root(this.context, { agent: { model } });
        await this.root.configure({ model }, this.context); // the model may have changed since the first start
        this.harness.resume();
        this.log.info(`Agent ready (${model.provider}/${model.modelId})`);
    }

    /**
     * Submit a request exactly once and return the answer text.
     *
     * @param {string} content user text
     * @param {string} requestId stable id, so a retry finds the original submission
     * @returns {Promise<string>} answer text
     */
    ask(content, requestId) {
        const run = this.queue.then(async () => {
            await this.readyPromise;
            if (!this.root) {
                throw new Error('Agent is not running');
            }
            await this.setStateAsync('chat.pending', { val: JSON.stringify({ requestId, content }), ack: true });
            const submission = await this.root.submit({ type: 'input', content, requestId }, this.context);
            const settled = await submission.wait(this.context);
            if (settled.status !== 'done') {
                throw new Error(`Request not answered (${settled.reason ?? settled.status})`);
            }
            const answer = await this.lastAnswer();
            await this.setStateAsync('chat.pending', { val: '', ack: true });
            return answer;
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    /** @returns {Promise<string>} text of the newest assistant message */
    async lastAnswer() {
        const view = await this.root.viewState(this.context);
        try {
            const entries = view.value.entries;
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].kind !== 'pi.assistant') {
                    continue;
                }
                const answer = answerText(entries[i].model || []);
                if (answer) {
                    return answer;
                }
            }
            return '';
        } finally {
            view.dispose?.();
        }
    }

    async resumePending() {
        const pending = await this.getStateAsync('chat.pending');
        if (!pending || !pending.val) {
            return;
        }
        try {
            const { requestId, content } = JSON.parse(String(pending.val));
            this.log.info(`Continuing request ${requestId} after restart`);
            const answer = await this.ask(content, requestId);
            await this.setStateAsync('chat.answer', { val: answer, ack: true });
        } catch (e) {
            if (this.stopping) {
                this.log.info('Request interrupted by shutdown; it continues after the next start');
                return;
            }
            this.log.warn(`Pending request could not be continued: ${e.message}`);
            await this.setStateAsync('chat.pending', { val: '', ack: true });
        }
    }

    /**
     * @param {string} id state id
     * @param {ioBroker.State | null | undefined} state new state
     */
    async onStateChange(id, state) {
        if (!state || state.ack || id !== `${this.namespace}.chat.input` || !state.val) {
            return;
        }
        try {
            const answer = await this.ask(String(state.val), requestIdFor(crypto, state.ts, state.val));
            await this.setStateAsync('chat.answer', { val: answer, ack: true });
        } catch (e) {
            if (this.stopping) {
                // chat.pending stays set, so the next start continues this request.
                this.log.info('Request interrupted by shutdown; it continues after the next start');
                return;
            }
            this.log.error(`Request failed: ${e.message}`);
            await this.setStateAsync('chat.answer', { val: `Error: ${e.message}`, ack: true });
        }
        await this.setStateAsync('chat.input', { val: String(state.val), ack: true });
    }

    /** @param {ioBroker.Message} obj message from a script or another adapter */
    async onMessage(obj) {
        if (!obj || obj.command !== 'ask') {
            return;
        }
        let result;
        try {
            const message = typeof obj.message === 'string' ? { text: obj.message } : obj.message || {};
            if (!message.text) {
                throw new Error('Missing "text"');
            }
            const requestId = message.requestId || requestIdFor(crypto, Date.now(), message.text);
            result = { answer: await this.ask(String(message.text), String(requestId)) };
        } catch (e) {
            result = {
                error: this.stopping
                    ? 'Interrupted by shutdown; the request continues after the next start'
                    : e.message,
            };
        }
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, result, obj.callback);
        }
    }

    /** @param {() => void} callback called when everything is stopped */
    onUnload(callback) {
        this.stopping = true;
        const done = async () => {
            try {
                await this.harness?.close(this.context);
            } catch (e) {
                this.log.error(`Closing the harness failed: ${e.message}`);
            }
            try {
                await this.setStateAsync('info.connection', { val: false, ack: true });
            } finally {
                callback();
            }
        };
        void done();
    }
}

if (require.main !== module) {
    module.exports = options => new PiAgent(options);
} else {
    new PiAgent();
}
