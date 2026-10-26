'use strict';

const utils = require('@iobroker/adapter-core');
const crypto = require('node:crypto');
const { parseAllowlist, requestIdFor } = require('./lib/guard');
const { createIoBrokerExtension } = require('./lib/tools');
const { createModelsWithKey, listModels } = require('./lib/providers');
const { ensureObjects } = require('./lib/objects');
const { openStore } = require('./lib/store');
const { resolveTimeZone } = require('./lib/time');
const {
    parseAllowedUsers,
    isAllowedUser,
    parseRequest,
    stripPrefix,
    telegramRequestId,
    splitMessage,
    markdownToTelegramHtml,
    isWellFormedHtml,
    escapeHtml,
    TELEGRAM_INSTRUCTIONS,
} = require('./lib/telegram');

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

/**
 * Pending requests as stored in chat.pending: a list, or the single object of version 0.0.1.
 *
 * @param {unknown} value state value
 * @returns {Array<{ requestId: string, content: string, target: { kind: string, chatId?: string } }>} entries
 */
function parsePending(value) {
    if (!value) {
        return [];
    }
    const parsed = JSON.parse(String(value));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
        .filter(e => e && e.requestId && e.content)
        .map(e => ({ requestId: e.requestId, content: e.content, target: e.target || { kind: 'state' } }));
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
        this.model = null;
        this.allowlist = [];
        /** IANA time zone of the house (setting, else the server's). */
        this.timeZone = 'UTC';
        /** States whose write the user must confirm in Telegram first. */
        this.confirmList = [];
        /** Telegram instance ("telegram.0") or "" when the Telegram link is off. */
        this.telegram = '';
        this.allowedUsers = new Set();
        /** Telegram chat id -> conversation id, persisted in telegram.chats. */
        this.chats = {};
        /** Requests that were accepted but not answered yet, persisted in chat.pending. */
        this.pending = [];
        this.pendingWrite = Promise.resolve();
        /** Set in onUnload: errors from the closing harness are interruptions, not failures. */
        this.stopping = false;
        /** One queue per conversation ("root" or "telegram:<chatId>"): runs of one conversation are serialised. */
        this.queues = new Map();
        this.readyPromise = new Promise(resolve => {
            this.markReady = resolve;
        });
    }

    async onReady() {
        try {
            await this.setStateAsync('info.connection', { val: false, ack: true });
            if (await this.enableMessagebox()) {
                this.markReady();
                return; // js-controller restarts the instance because its object changed
            }
            // Created here, not in instanceObjects: js-controller would reset their ACL at every start.
            await ensureObjects(this);
            this.allowlist = parseAllowlist(this.config.writeAllow, (line, msg) =>
                this.log.warn(`Ignoring invalid allowlist line "${line}": ${msg}`),
            );
            this.timeZone = resolveTimeZone(this.config.timeZone, this.log);
            this.log.info(`Time zone: ${this.timeZone}`);
            this.confirmList = parseAllowlist(this.config.confirmRequired, (line, msg) =>
                this.log.warn(`Ignoring invalid confirmation line "${line}": ${msg}`),
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
            await this.startTelegram();
            await this.setStateAsync('info.connection', { val: true, ack: true });
            this.markReady();

            // Requests that were cut off by a restart or a crash are picked up again with the same requestId.
            await this.resumePending();
        } catch (e) {
            this.log.error(`Start failed: ${e.message}`);
            this.markReady();
        }
    }

    /**
     * Versions 0.0.1-0.0.4 declared "supportedMessages": {"custom": false}. When that object exists, js-controller
     * ignores common.messagebox and subscribes to messages only if one of its values is true - so sendTo never
     * arrived. An update does not remove the key from an existing instance object, so it is removed here, once.
     *
     * @returns {Promise<boolean>} true when the instance object was changed (js-controller then restarts the instance)
     */
    async enableMessagebox() {
        const id = `system.adapter.${this.namespace}`;
        try {
            const obj = await this.getForeignObjectAsync(id);
            const supported = obj?.common && Object(obj.common).supportedMessages;
            if (!supported || typeof supported !== 'object' || Object.values(supported).some(v => v !== false)) {
                return false;
            }
            delete Object(obj.common).supportedMessages;
            await this.setForeignObjectAsync(id, obj);
            this.log.info(
                'Message box enabled: removed an outdated "supportedMessages" from the instance; it restarts once',
            );
            return true;
        } catch (e) {
            this.log.warn(`Could not check the message box setting of the instance: ${e.message}`);
            return false;
        }
    }

    /** Load the ESM packages and open the durable harness on the instance data directory. */
    async startHarness() {
        // The key goes into an in-memory credential store of this instance, never into the process environment.
        const { spec, models } = await createModelsWithKey(this.config.provider, this.config.apiKey);
        const modelId = String(this.config.modelId || '').trim() || spec.defaultModel;

        const [{ BACKGROUND_CONTEXT }, durable, ai] = await Promise.all([
            import('@earendil-works/chord/context'),
            import('@earendil-works/pi-durable'),
            import('@earendil-works/pi-ai'),
        ]);
        this.context = BACKGROUND_CONTEXT;

        const registry = durable.createRegistry();
        registry.install(
            createIoBrokerExtension(this, { ...durable, Type: ai.Type }, () => ({
                allowlist: this.allowlist,
                confirmList: this.confirmList,
                timeZone: this.timeZone,
                dryRun: Boolean(this.config.dryRun),
                instructions: String(this.config.instructions || ''),
                requestConfirmation: request => this.requestConfirmation(request),
                deliverReminder: (conversationId, text) => this.deliverReminder(conversationId, text),
                historyInstance: () => this.historyInstance(),
            })),
        );

        const stored = await this.getStateAsync('chat.pending');
        let pendingCount = 0;
        try {
            pendingCount = parsePending(stored?.val).length;
        } catch {
            // an unreadable list is dropped later by resumePending
        }
        const { storage, migrated } = await openStore(utils.getAbsoluteInstanceDataDir(this), this.context, {
            pendingCount,
            log: this.log,
        });
        if (migrated) {
            // the chats' conversations lived in the old store
            await this.setStateAsync('telegram.chats', { val: '', ack: true });
        }
        this.harness = await durable.Harness.open(storage, { models, registry }, this.context);

        this.model = { provider: this.config.provider, modelId };
        this.root = await this.harness.root(this.context, { agent: { model: this.model } });
        await this.root.configure({ model: this.model }, this.context); // the model may have changed since the last start
        this.harness.resume();
        await this.updateUsage();
        this.log.info(`Agent ready (${this.model.provider}/${this.model.modelId})`);
    }

    /** Listen to the configured Telegram instance, if any. */
    async startTelegram() {
        this.telegram = String(this.config.telegramInstance || '').trim();
        if (!this.telegram) {
            return;
        }
        this.allowedUsers = parseAllowedUsers(this.config.telegramUsers);
        if (this.allowedUsers.size === 0) {
            this.log.warn('Telegram is on, but no user is allowed: every Telegram message is ignored.');
        }
        const stored = await this.getStateAsync('telegram.chats');
        this.chats = stored?.val ? JSON.parse(String(stored.val)) : {};
        // Chats keep their own conversation; a model change in the settings reaches them too.
        for (const id of Object.values(this.chats)) {
            const conversation = await this.harness.conversation(id, this.context);
            await conversation?.configure({ model: this.model, instructions: TELEGRAM_INSTRUCTIONS }, this.context);
        }
        await this.subscribeForeignStatesAsync(`${this.telegram}.communicate.request`);
        const prefix = String(this.config.telegramPrefix || '').trim();
        this.log.info(
            `Telegram: listening on ${this.telegram} for ${this.allowedUsers.size} allowed user(s)${prefix ? `, prefix "${prefix}"` : ''}`,
        );
    }

    /**
     * Conversation of a request: one per Telegram chat, the root conversation for everything else.
     *
     * @param {{ kind: string, chatId?: string }} target where the answer goes
     * @returns {Promise<object>} conversation handle
     */
    async conversationFor(target) {
        if (target.kind !== 'telegram') {
            return this.root;
        }
        const known = this.chats[target.chatId];
        if (known) {
            const conversation = await this.harness.conversation(known, this.context);
            if (conversation) {
                return conversation;
            }
        }
        const created = await this.harness.createConversation(
            { ownership: { kind: 'ownerless' }, agent: { model: this.model, instructions: TELEGRAM_INSTRUCTIONS } },
            this.context,
        );
        this.chats[target.chatId] = created.id;
        // chats run in parallel; chained writes always store the newest map
        this.chatsWrite = (this.chatsWrite || Promise.resolve())
            .then(async () => {
                await this.setStateAsync('telegram.chats', { val: JSON.stringify(this.chats), ack: true });
            })
            .catch(e => {
                this.log.warn(`Telegram chats could not be saved: ${e.message}`);
            });
        await this.chatsWrite;
        this.log.info(`Telegram: new conversation for chat ${target.chatId}`);
        return created;
    }

    /**
     * Telegram chat of a conversation, if the conversation belongs to one.
     *
     * @param {unknown} conversationId conversation id
     * @returns {string | undefined} chat id
     */
    chatOf(conversationId) {
        return Object.keys(this.chats).find(chatId => String(this.chats[chatId]) === String(conversationId));
    }

    /**
     * Ask the user in the Telegram chat of the conversation whether a write may happen.
     *
     * @param {{ conversationId: unknown, id: string, val: unknown }} request the write to confirm
     * @returns {Promise<string>} "yes", "no", "timeout" or "unavailable" (no Telegram chat for this conversation)
     */
    async requestConfirmation({ conversationId, id, val }) {
        const chatId = this.chatOf(conversationId);
        if (!this.telegram || !chatId) {
            this.log.warn(`Confirmation for ${id} needed, but the request did not come from a Telegram chat`);
            return 'unavailable';
        }
        const question = `⚠️ Set <code>${escapeHtml(id)}</code> to <code>${escapeHtml(JSON.stringify(val))}</code>?`;
        try {
            const answer = await this.sendToAsync(
                this.telegram,
                'ask',
                {
                    text: question,
                    chatId,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Yes', callback_data: 'pi-agent:yes' },
                                { text: '❌ No', callback_data: 'pi-agent:no' },
                            ],
                        ],
                    },
                },
                { timeout: 10 * 60_000 },
            );
            if (String(answer) === '__timeout__') {
                return 'timeout';
            }
            // the telegram adapter answers with the pressed button (a callback query with "data")
            return Object(answer).data === 'pi-agent:yes' ? 'yes' : 'no';
        } catch (e) {
            this.log.warn(`No answer to the confirmation for ${id}: ${e.message}`);
            return 'timeout';
        }
    }

    /**
     * A reminder is due: send it to the Telegram chat of its conversation, or to chat.answer.
     *
     * @param {unknown} conversationId conversation that set the reminder
     * @param {string} text reminder text
     */
    async deliverReminder(conversationId, text) {
        const chatId = this.chatOf(conversationId);
        const target = this.telegram && chatId ? { kind: 'telegram', chatId } : { kind: 'state' };
        this.log.info(`Reminder due${chatId ? ` for chat ${chatId}` : ''}`);
        await this.deliver(target, `⏰ ${text}`);
    }

    /** @returns {Promise<string>} configured history instance, else the system default, else "" */
    async historyInstance() {
        const configured = String(this.config.historyInstance || '').trim();
        if (configured) {
            return configured;
        }
        const system = await this.getForeignObjectAsync('system.config');
        return String(system?.common?.defaultHistory || '');
    }

    /** Publish the token use and cost of all conversations in usage.*. */
    async updateUsage() {
        try {
            const state = await this.harness.usage(this.context);
            const all = [...Object.values(state.models || {}), ...Object.values(state.tools || {})];
            const sum = pick => all.reduce((total, usage) => total + (Number(pick(usage)) || 0), 0);
            await this.setStateAsync('usage.tokensInput', { val: sum(u => u.input), ack: true });
            await this.setStateAsync('usage.tokensOutput', { val: sum(u => u.output), ack: true });
            await this.setStateAsync('usage.tokensTotal', { val: sum(u => u.totalTokens), ack: true });
            await this.setStateAsync('usage.cost', { val: Math.round(sum(u => u.cost?.total) * 1e6) / 1e6, ack: true });
            await this.setStateAsync('usage.json', { val: JSON.stringify(state), ack: true });
        } catch (e) {
            this.log.warn(`Usage could not be published: ${e.message}`);
        }
    }

    /** Write the pending list; writes are chained so the newest list always wins. */
    savePending() {
        this.pendingWrite = this.pendingWrite
            .then(async () => {
                await this.setStateAsync('chat.pending', {
                    val: this.pending.length ? JSON.stringify(this.pending) : '',
                    ack: true,
                });
            })
            .catch(e => {
                this.log.warn(`Pending requests could not be saved: ${e.message}`);
            });
        return this.pendingWrite;
    }

    /**
     * Submit a request exactly once and return the answer text.
     *
     * @param {string} content user text
     * @param {string} requestId stable id, so a retry finds the original submission
     * @param {{ kind: string, chatId?: string }} [target] where the answer goes (kept for a restart)
     * @returns {Promise<string>} answer text
     */
    ask(content, requestId, target = { kind: 'state' }) {
        // Recorded before the request waits in the queue, so a queued request also survives a restart.
        const admitted = (async () => {
            await this.readyPromise;
            if (!this.root) {
                throw new Error('Agent is not running');
            }
            this.pending = this.pending.filter(p => p.requestId !== requestId).concat({ requestId, content, target });
            await this.savePending();
        })();
        // One queue per conversation: a chat waits for its own earlier request, not for other chats.
        const key = target.kind === 'telegram' ? `telegram:${target.chatId}` : 'root';
        const previous = this.queues.get(key) || Promise.resolve();
        const run = Promise.all([admitted, previous]).then(async () => {
            try {
                const conversation = await this.conversationFor(target);
                const submission = await conversation.submit({ type: 'input', content, requestId }, this.context);
                const settled = await submission.wait(this.context);
                if (settled.status !== 'done') {
                    throw new Error(`Request not answered (${settled.reason ?? settled.status})`);
                }
                const answer = await this.lastAnswer(conversation);
                await this.removePending(requestId);
                void this.updateUsage();
                return answer;
            } catch (e) {
                if (!this.stopping) {
                    await this.removePending(requestId);
                }
                throw e;
            }
        });
        const tail = run.catch(() => undefined);
        this.queues.set(key, tail);
        // forget a finished queue so idle chats do not accumulate
        void tail.then(() => this.queues.get(key) === tail && this.queues.delete(key));
        admitted.catch(() => undefined);
        return run;
    }

    /** @param {string} requestId request to drop from the pending list */
    async removePending(requestId) {
        this.pending = this.pending.filter(p => p.requestId !== requestId);
        await this.savePending();
    }

    /**
     * Text of the newest assistant message of a conversation.
     *
     * @param {object} conversation conversation handle
     * @returns {Promise<string>} answer text
     */
    async lastAnswer(conversation) {
        const view = await conversation.viewState(this.context);
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

    /**
     * Run a request and deliver the answer (or the error) to its target.
     *
     * @param {{ requestId: string, content: string, target: { kind: string, chatId?: string } }} entry request
     */
    async process(entry) {
        try {
            const answer = await this.ask(entry.content, entry.requestId, entry.target);
            await this.deliver(entry.target, answer);
        } catch (e) {
            if (this.stopping) {
                // The request stays pending, so the next start continues it.
                this.log.info('Request interrupted by shutdown; it continues after the next start');
                return;
            }
            this.log.error(`Request failed: ${e.message}`);
            await this.deliver(entry.target, `Error: ${e.message}`);
        }
    }

    /**
     * @param {{ kind: string, chatId?: string }} target where the answer goes
     * @param {string} text answer or error text
     */
    async deliver(target, text) {
        if (target.kind === 'telegram') {
            for (const part of splitMessage(text)) {
                // Telegram shows Markdown literally; its HTML mode renders bold, italic, code and links.
                // The telegram adapter does not report a rejected message back, so only well-formed HTML is sent.
                const html = markdownToTelegramHtml(part);
                if (isWellFormedHtml(html)) {
                    this.sendTo(this.telegram, 'send', { text: html, chatId: target.chatId, parse_mode: 'HTML' });
                } else {
                    this.log.warn('Telegram: the answer could not be converted to valid HTML; sent as plain text');
                    this.sendTo(this.telegram, 'send', { text: part, chatId: target.chatId });
                }
            }
            return;
        }
        // "state", and "sendTo" after a restart: the caller is no longer waiting.
        await this.setStateAsync('chat.answer', { val: text, ack: true });
    }

    async resumePending() {
        const stored = await this.getStateAsync('chat.pending');
        let entries;
        try {
            entries = parsePending(stored?.val);
        } catch (e) {
            this.log.warn(`Pending requests could not be read and are dropped: ${e.message}`);
            await this.setStateAsync('chat.pending', { val: '', ack: true });
            return;
        }
        this.pending = entries;
        for (const entry of entries) {
            if (entry.target.kind === 'telegram' && !this.telegram) {
                entry.target = { kind: 'state' }; // Telegram was switched off meanwhile
            }
            this.log.info(`Continuing request ${entry.requestId} after restart`);
        }
        await Promise.all(entries.map(entry => this.process(entry)));
    }

    /**
     * @param {string} id state id
     * @param {ioBroker.State | null | undefined} state new state
     */
    async onStateChange(id, state) {
        if (this.telegram && id === `${this.telegram}.communicate.request`) {
            return this.onTelegram(state);
        }
        if (!state || state.ack || id !== `${this.namespace}.chat.input` || !state.val) {
            return;
        }
        const requestId = requestIdFor(crypto, state.ts, state.val);
        await this.process({ requestId, content: String(state.val), target: { kind: 'state' } });
        if (!this.stopping) {
            await this.setStateAsync('chat.input', { val: String(state.val), ack: true });
        }
    }

    /**
     * A message arrived at the Telegram instance: check sender and prefix, then ask in the chat's conversation.
     *
     * @param {ioBroker.State | null | undefined} state value of <telegram>.communicate.request ("[name]text")
     */
    async onTelegram(state) {
        if (!state || !state.val) {
            return;
        }
        const base = `${this.telegram}.communicate`;
        const meta = await this.getForeignStatesAsync([
            `${base}.requestChatId`,
            `${base}.requestUserId`,
            `${base}.requestMessageId`,
            `${base}.users`,
        ]);
        const chatId = meta[`${base}.requestChatId`]?.val;
        const userId = meta[`${base}.requestUserId`]?.val;
        const messageId = meta[`${base}.requestMessageId`]?.val;
        const { name, text } = parseRequest(state.val);
        if (chatId === null || chatId === undefined || chatId === '') {
            this.log.warn(`Telegram message without chat id ignored`);
            return;
        }
        let users = {};
        try {
            users = JSON.parse(String(meta[`${base}.users`]?.val || '{}'));
        } catch {
            // the user list is only used to resolve user names
        }
        const known = users[String(userId)];
        const sender = { userId, userName: known?.userName, firstName: known?.firstName, known: Boolean(known) };
        if (!isAllowedUser(sender, this.allowedUsers)) {
            const who = [known?.firstName, known?.userName].filter(Boolean).join(' / ') || name || '?';
            this.log.warn(`Telegram message from ${who} (${userId ?? '?'}) ignored: user not allowed`);
            return;
        }
        const content = stripPrefix(text, String(this.config.telegramPrefix || ''));
        if (content === null) {
            return; // not for the agent; the bot may serve other scripts too
        }
        const requestId =
            messageId !== null && messageId !== undefined
                ? telegramRequestId(chatId, messageId)
                : requestIdFor(crypto, state.ts, state.val);
        await this.process({ requestId, content, target: { kind: 'telegram', chatId: String(chatId) } });
    }

    /** @param {ioBroker.Message} obj message from a script or another adapter */
    async onMessage(obj) {
        if (obj?.command === 'listModels') {
            // model field of the admin page; needs no API key and no running agent
            let options = [];
            try {
                options = await listModels(String(Object(obj.message).provider || this.config.provider || ''));
            } catch (e) {
                this.log.debug(`No model list: ${e.message}`);
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, options, obj.callback);
            }
            return;
        }
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
            result = { answer: await this.ask(String(message.text), String(requestId), { kind: 'sendTo' }) };
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
                await this.pendingWrite;
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
