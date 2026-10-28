'use strict';

const utils = require('@iobroker/adapter-core');
const crypto = require('node:crypto');
const { parseAllowlist, parseWriteRules, requestIdFor } = require('./lib/guard');
const { createIoBrokerExtension } = require('./lib/tools');
const { createModelsWithKey, listModels, testModel } = require('./lib/providers');
const { keySourceOf, resolveApiKey } = require('./lib/credentials');
const { ensureObjects } = require('./lib/objects');
const { openStore } = require('./lib/store');
const { resolveTimeZone, timeZoneOptions } = require('./lib/time');
const { channelsFromConfig, legacyRows, chatKey, parseChatKey, migrateChats } = require('./lib/channels');
const { createDrivers, messengerType, MESSENGER_ADAPTERS } = require('./lib/messengers');
const { ADMIN, ADMIN_INSTRUCTIONS, historyOf, withNotices, createAdminChat } = require('./lib/admin-chat');
const { isAllowedUser, stripPrefix, telegramRequestId } = require('./lib/telegram');

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
 * @returns {Array<{ requestId: string, content: string, target: { kind: string, instance?: string, chatId?: string } }>} entries
 */
function parsePending(value) {
    if (!value) {
        return [];
    }
    const parsed = JSON.parse(String(value));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
        .filter(e => e && e.requestId && e.content)
        .map(e => ({ requestId: e.requestId, content: e.content, target: chatTarget(e.target) }));
}

/**
 * ioBroker user of a message from the admin tab: the socket of admin passes it in the options of sendTo.
 * Without one (authentication off) all admin sessions share one conversation.
 *
 * @param {ioBroker.Message} obj message
 * @returns {string} user id, e.g. "system.user.admin"
 */
function adminUser(obj) {
    const user = String(Object(obj).user || '').trim();
    return /^system\.user\.[^/]+$/.test(user) ? user : 'system.user.admin';
}

/**
 * Target of a stored request; up to 0.0.5 a messenger chat was { kind: "telegram", chatId } without an instance.
 *
 * @param {{ kind: string, instance?: string, chatId?: string } | undefined} target stored target
 * @returns {{ kind: string, instance?: string, chatId?: string }} target
 */
function chatTarget(target) {
    if (!target) {
        return { kind: 'state' };
    }
    return target.kind === 'telegram' ? { ...target, kind: 'chat' } : target;
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
        /** States whose write the user must confirm in the messenger chat first. */
        this.confirmList = [];
        /** Messenger instances the agent listens on ("telegram.0" -> allowed users and prefix); empty when off. */
        this.channels = new Map();
        /** Sending, reading and confirming per messenger adapter (telegram, max). */
        this.drivers = createDrivers(this);
        /** Questions, errors and reminders of the chat in the admin tab, per ioBroker user. */
        this.adminChat = createAdminChat();
        /** Users of the admin tab whose request runs now (requests resumed after a restart are in this.pending). */
        this.adminRunning = new Set();
        /** "<instance>/<chat id>" -> conversation id, persisted in telegram.chats. */
        this.chats = {};
        /** Requests that were accepted but not answered yet, persisted in chat.pending. */
        this.pending = [];
        this.pendingWrite = Promise.resolve();
        /** Set in onUnload: errors from the closing harness are interruptions, not failures. */
        this.stopping = false;
        /** One queue per conversation ("root" or "<instance>/<chat id>"): runs of one conversation are serialised. */
        this.queues = new Map();
        this.readyPromise = new Promise(resolve => {
            this.markReady = resolve;
        });
    }

    async onReady() {
        try {
            await this.setStateAsync('info.connection', { val: false, ack: true });
            if (
                (await this.enableMessagebox()) ||
                (await this.migrateMessengerSettings()) ||
                (await this.removeObsoleteSettings())
            ) {
                this.markReady();
                return; // js-controller restarts the instance because its object changed
            }
            // Created here, not in instanceObjects: js-controller would reset their ACL at every start.
            await ensureObjects(this);
            // the table "Write permissions" and the regular expressions of the expert fields both count
            const rules = parseWriteRules(this.config.writeRules);
            this.allowlist = [
                ...rules.allow,
                ...parseAllowlist(this.config.writeAllow, (line, msg) =>
                    this.log.warn(`Ignoring invalid allowlist line "${line}": ${msg}`),
                ),
            ];
            this.timeZone = resolveTimeZone(this.config.timeZone, this.log);
            this.log.info(`Time zone: ${this.timeZone}`);
            this.confirmList = [
                ...rules.confirm,
                ...parseAllowlist(this.config.confirmRequired, (line, msg) =>
                    this.log.warn(`Ignoring invalid confirmation line "${line}": ${msg}`),
                ),
            ];
            if (this.allowlist.length === 0) {
                this.log.warn('The write allowlist is empty: the agent can read but not write anything.');
            }
            if (this.config.dryRun) {
                this.log.info('Simulation mode is on: write requests are logged but not executed.');
            }

            const apiKey = await this.apiKey();
            if (apiKey === null) {
                this.markReady();
                return;
            }

            await this.startHarness(apiKey);
            await this.subscribeStatesAsync('chat.input');
            await this.startMessengers();
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

    /**
     * Versions up to 0.0.5 had one Telegram instance in three single fields; since 0.1.0 it is a row of the table
     * "messengers". The settings are moved once, so the admin page shows the instance in the table.
     *
     * @returns {Promise<boolean>} true when the instance object was changed (js-controller then restarts the instance)
     */
    async migrateMessengerSettings() {
        const native = this.config;
        const hasTable = Array.isArray(native.messengers) && native.messengers.length > 0;
        if (hasTable || !String(native.telegramInstance || '').trim()) {
            return false;
        }
        try {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: {
                    messengers: legacyRows(native),
                    telegramInstance: '',
                    telegramUsers: '',
                    telegramPrefix: '',
                },
            });
            this.log.info('Telegram settings moved into the table of messengers; the instance restarts once');
            return true;
        } catch (e) {
            // the single fields keep working: channelsFromConfig reads them while the table is empty
            this.log.warn(`Could not move the Telegram settings into the table: ${e.message}`);
            return false;
        }
    }

    /**
     * A development build before 0.1.0 stored the messenger table as "telegramChannels"; no release reads it.
     *
     * @returns {Promise<boolean>} true when the instance object was changed (js-controller then restarts the instance)
     */
    async removeObsoleteSettings() {
        if (!('telegramChannels' in Object(this.config))) {
            return false;
        }
        const id = `system.adapter.${this.namespace}`;
        try {
            const obj = await this.getForeignObjectAsync(id);
            if (!obj?.native || !('telegramChannels' in obj.native)) {
                return false;
            }
            delete obj.native.telegramChannels;
            await this.setForeignObjectAsync(id, obj);
            this.log.info('Removed the unused setting "telegramChannels"; the instance restarts once');
            return true;
        } catch (e) {
            this.log.warn(`Could not remove the unused setting "telegramChannels": ${e.message}`);
            return false;
        }
    }

    /**
     * Installed messenger instances (telegram, max) for the instance column of the messenger table.
     *
     * @returns {Promise<Array<{ value: string, label: string }>>} options
     */
    async messengerInstanceOptions() {
        const options = [];
        for (const name of MESSENGER_ADAPTERS) {
            const view = await this.getObjectViewAsync('system', 'instance', {
                startkey: `system.adapter.${name}.`,
                endkey: `system.adapter.${name}.香`,
            });
            for (const row of view.rows) {
                const instance = row.id.slice('system.adapter.'.length);
                const title = Object(row.value?.common?.titleLang).en || row.value?.common?.title;
                options.push({ value: instance, label: title ? `${instance} (${title})` : instance });
            }
        }
        return options;
    }

    /**
     * The table "Write permissions" with a row (nothing allowed yet) for every installed instance that has none.
     * Instances of admin and system tools (adapter type "general" or "storage") and the agent itself are left out.
     *
     * @param {unknown} rows rows of the admin page, not saved yet
     * @returns {Promise<{ rows: Array<{ scope: string, write: boolean, confirm: boolean }>, added: number }>} table
     */
    async writeRulesWithInstances(rows) {
        const table = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object');
        const present = new Set(table.map(r => String(r.scope || '').trim()));
        const view = await this.getObjectViewAsync('system', 'instance', {
            startkey: 'system.adapter.',
            endkey: 'system.adapter.香',
        });
        const added = view.rows
            .filter(row => !['general', 'storage'].includes(String(row.value?.common?.type)))
            .map(row => row.id.slice('system.adapter.'.length))
            .filter(instance => instance !== this.namespace && !present.has(instance))
            .sort()
            .map(instance => ({ scope: instance, write: false, confirm: false }));
        return { rows: [...table, ...added], added: added.length };
    }

    /**
     * The API key of the configuration, from this instance or from the central credential store of admin.
     * A key of the central store is watched: when it changes, the instance restarts with the new one.
     *
     * @returns {Promise<string | null>} the key (empty for a custom server without one), null when the agent stays idle
     */
    async apiKey() {
        const central = keySourceOf(this.config) === 'central';
        const credentialId = String(this.config.credentialId || '').trim();
        let key = '';
        try {
            key = await resolveApiKey(this, this.config);
        } catch (e) {
            this.log.warn(`Cannot read the credential "${credentialId}": ${e.message}; the agent stays idle`);
            return null;
        }
        if (central && credentialId) {
            await this.watchCredential(credentialId);
        }
        if (!key && this.config.provider !== 'custom') {
            // A setting the user still has to make, not a fault: stay idle and say what is missing.
            this.log.warn(
                central
                    ? 'No credential with an API key chosen. Choose it in the instance settings; the agent stays idle until then.'
                    : 'No API key configured. Enter it in the instance settings; the agent stays idle until then.',
            );
            return null;
        }
        return key;
    }

    /**
     * Restart the instance when the chosen credential of the central store is changed or deleted.
     *
     * @param {string} credentialId id of the credential, e.g. "system.credentials.openai"
     */
    async watchCredential(credentialId) {
        try {
            const { subscribeCredentials } = require('@iobroker/adapter-core/credentials');
            await subscribeCredentials(this, credentialId, () => {
                if (this.stopping) {
                    return;
                }
                this.log.info(`The credential ${credentialId} was changed; the instance restarts`);
                this.restart();
            });
        } catch (e) {
            this.log.warn(`Cannot watch the credential ${credentialId}: ${e.message}`);
        }
    }

    /**
     * Load the ESM packages and open the durable harness on the instance data directory.
     *
     * @param {string} apiKey API key of the provider (may be empty for a custom server)
     */
    async startHarness(apiKey) {
        const custom = this.config.provider === 'custom';
        if (custom && !String(this.config.modelId || '').trim()) {
            throw new Error('No model configured for the OpenAI-compatible server');
        }
        // The key goes into an in-memory credential store of this instance, never into the process environment.
        const { spec, models } = await createModelsWithKey(this.config.provider, apiKey, {
            baseUrl: this.config.baseUrl,
            modelId: this.config.modelId,
        });
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

    /** Listen to the configured messenger instances, if any. */
    async startMessengers() {
        this.channels = new Map();
        for (const channel of channelsFromConfig(this.config)) {
            const driver = this.drivers[messengerType(channel.instance)];
            if (driver) {
                this.channels.set(channel.instance, { ...channel, driver });
            } else {
                this.log.warn(
                    `Messenger ${channel.instance} ignored: only ${MESSENGER_ADAPTERS.join(' and ')} are supported`,
                );
            }
        }
        // the chats of the admin tab live in the same map, so it is read even without a messenger
        const stored = await this.getStateAsync('telegram.chats');
        const { chats, changed } = migrateChats(stored?.val ? JSON.parse(String(stored.val)) : {}, this.firstChannel());
        this.chats = chats;
        if (changed) {
            await this.setStateAsync('telegram.chats', { val: JSON.stringify(this.chats), ack: true });
        }
        // Chats keep their own conversation; a model change in the settings reaches them too.
        for (const [key, id] of Object.entries(this.chats)) {
            const instructions = this.instructionsOf(parseChatKey(key, this.firstChannel()).instance);
            const conversation = instructions ? await this.harness.conversation(id, this.context) : undefined;
            await conversation?.configure({ model: this.model, instructions }, this.context);
        }
        for (const { instance, allowed, prefix, driver } of this.channels.values()) {
            if (allowed.size === 0) {
                this.log.warn(`${driver.label} ${instance}: no user is allowed, every message is ignored.`);
            }
            await this.subscribeForeignStatesAsync(`${instance}.communicate.request`);
            this.log.info(
                `${driver.label}: listening on ${instance} for ${allowed.size} allowed user(s)${prefix ? `, prefix "${prefix}"` : ''}`,
            );
        }
    }

    /**
     * @param {string} instance messenger instance, or "admin" for the chat of the admin tab
     * @returns {string | undefined} instructions of its conversations; undefined for an instance that is off
     */
    instructionsOf(instance) {
        return instance === ADMIN ? ADMIN_INSTRUCTIONS : this.channels.get(instance)?.driver.instructions;
    }

    /** @returns {string} first configured messenger instance, or "" (the one of chats stored by 0.0.5) */
    firstChannel() {
        return this.channels.keys().next().value || '';
    }

    /**
     * Conversation of a request: one per messenger chat (per instance) and per user of the admin tab, the root
     * conversation for everything else.
     *
     * @param {{ kind: string, instance?: string, chatId?: string }} target where the answer goes
     * @returns {Promise<object>} conversation handle
     */
    async conversationFor(target) {
        const key = this.chatKeyOf(target);
        if (!key) {
            return this.root;
        }
        const instance = target.kind === 'admin' ? ADMIN : target.instance;
        const instructions = this.instructionsOf(instance);
        const known = this.chats[key];
        if (known) {
            const conversation = await this.harness.conversation(known, this.context);
            if (conversation) {
                return conversation;
            }
        }
        const created = await this.harness.createConversation(
            { ownership: { kind: 'ownerless' }, agent: { model: this.model, instructions } },
            this.context,
        );
        this.chats[key] = created.id;
        // chats run in parallel; chained writes always store the newest map
        this.chatsWrite = (this.chatsWrite || Promise.resolve())
            .then(async () => {
                await this.setStateAsync('telegram.chats', { val: JSON.stringify(this.chats), ack: true });
            })
            .catch(e => {
                this.log.warn(`Messenger chats could not be saved: ${e.message}`);
            });
        await this.chatsWrite;
        this.log.info(`New conversation for chat ${target.chatId} on ${instance}`);
        return created;
    }

    /**
     * Key of a target in telegram.chats (also the key of its queue).
     *
     * @param {{ kind: string, instance?: string, chatId?: string }} target where the answer goes
     * @returns {string} "<instance>/<chat id>", "admin/<user>", or "" for the root conversation
     */
    chatKeyOf(target) {
        if (target.kind === 'admin') {
            return chatKey(ADMIN, target.chatId);
        }
        return target.kind === 'chat' ? chatKey(target.instance, target.chatId) : '';
    }

    /**
     * ioBroker user of the admin tab whose conversation this is.
     *
     * @param {unknown} conversationId conversation id
     * @returns {string | undefined} user
     */
    adminUserOf(conversationId) {
        const key = Object.keys(this.chats).find(k => String(this.chats[k]) === String(conversationId));
        const chat = key ? parseChatKey(key, '') : undefined;
        return chat?.instance === ADMIN ? chat.chatId : undefined;
    }

    /**
     * Messenger chat of a conversation, if the conversation belongs to one on a configured instance.
     *
     * @param {unknown} conversationId conversation id
     * @returns {{ instance: string, chatId: string } | undefined} instance and chat
     */
    chatOf(conversationId) {
        const key = Object.keys(this.chats).find(k => String(this.chats[k]) === String(conversationId));
        if (!key) {
            return undefined;
        }
        const chat = parseChatKey(key, this.firstChannel());
        return this.channels.has(chat.instance) ? chat : undefined;
    }

    /**
     * Ask the user in the messenger chat of the conversation whether a write may happen.
     *
     * @param {{ conversationId: unknown, id: string, val: unknown }} request the write to confirm
     * @returns {Promise<string>} "yes", "no", "timeout" or "unavailable" (no messenger chat for this conversation)
     */
    async requestConfirmation({ conversationId, id, val }) {
        const user = this.adminUserOf(conversationId);
        if (user) {
            return this.adminChat.confirm(user, id, val);
        }
        const chat = this.chatOf(conversationId);
        if (!chat) {
            this.log.warn(`Confirmation for ${id} needed, but the request did not come from a messenger chat`);
            return 'unavailable';
        }
        try {
            return await this.channels.get(chat.instance).driver.confirm(chat.instance, chat.chatId, id, val);
        } catch (e) {
            this.log.warn(`No answer to the confirmation for ${id}: ${e.message}`);
            return 'timeout';
        }
    }

    /**
     * A reminder is due: send it to the messenger chat of its conversation, or to chat.answer.
     *
     * @param {unknown} conversationId conversation that set the reminder
     * @param {string} text reminder text
     */
    async deliverReminder(conversationId, text) {
        const user = this.adminUserOf(conversationId);
        if (user) {
            this.log.info(`Reminder due for the admin chat of ${user}`);
            this.adminChat.addNotice(user, `⏰ ${text}`);
            return;
        }
        const chat = this.chatOf(conversationId);
        const target = chat ? { kind: 'chat', ...chat } : { kind: 'state' };
        this.log.info(`Reminder due${chat ? ` for chat ${chat.chatId} on ${chat.instance}` : ''}`);
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
     * @param {{ kind: string, instance?: string, chatId?: string }} [target] where the answer goes (kept for a restart)
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
        const key = this.chatKeyOf(target) || 'root';
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
     * @param {{ requestId: string, content: string, target: { kind: string, instance?: string, chatId?: string } }} entry request
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
            if (entry.target.kind === 'admin') {
                this.adminChat.setError(String(entry.target.chatId), e.message);
                return;
            }
            await this.deliver(entry.target, `Error: ${e.message}`);
        }
    }

    /**
     * @param {{ kind: string, instance?: string, chatId?: string }} target where the answer goes
     * @param {string} text answer or error text
     */
    async deliver(target, text) {
        if (target.kind === 'admin') {
            return; // the admin tab reads the answer from the conversation
        }
        if (target.kind === 'chat') {
            this.channels.get(target.instance).driver.send(target.instance, target.chatId, text);
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
            if (entry.target.kind === 'chat') {
                // entries of 0.0.5 and earlier have no instance: they came from the only one
                entry.target = { ...entry.target, instance: entry.target.instance || this.firstChannel() };
                if (!this.channels.has(entry.target.instance)) {
                    entry.target = { kind: 'state' }; // this messenger instance was switched off meanwhile
                }
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
        const instance = id.endsWith('.communicate.request') ? id.slice(0, -'.communicate.request'.length) : '';
        if (this.channels.has(instance)) {
            return this.onChatMessage(instance, state);
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
     * A message arrived at a messenger instance: check sender and prefix, then ask in the chat's conversation.
     *
     * @param {string} instance messenger instance the message came from
     * @param {ioBroker.State | null | undefined} state value of <instance>.communicate.request ("[name]text")
     */
    async onChatMessage(instance, state) {
        if (!state || !state.val) {
            return;
        }
        const { allowed, prefix, driver } = this.channels.get(instance);
        const request = await driver.readRequest(instance, state.val);
        const { chatId, messageId, name, text, sender } = request;
        if (!chatId) {
            this.log.warn(`${driver.label} message on ${instance} without chat id ignored`);
            return;
        }
        if (!isAllowedUser(sender, allowed)) {
            const who = [sender.firstName, sender.userName].filter(Boolean).join(' / ') || name || '?';
            this.log.warn(
                `${driver.label} message on ${instance} from ${who} (${sender.userId ?? '?'}) ignored: user not allowed`,
            );
            return;
        }
        if (driver.takeButton(instance, request)) {
            return; // a button of a confirmation, not a message for the model
        }
        const content = stripPrefix(text, prefix);
        if (content === null) {
            return; // not for the agent; the bot may serve other scripts too
        }
        const requestId =
            messageId !== null && messageId !== undefined
                ? telegramRequestId(instance, chatId, messageId)
                : requestIdFor(crypto, state.ts, state.val);
        await this.process({ requestId, content, target: { kind: 'chat', instance, chatId } });
    }

    /**
     * Commands of the chat in the admin tab (admin/tab.html). The page polls chatHistory while a request runs.
     *
     * @param {string} command chatHistory, chatSend, chatConfirm or chatNew
     * @param {string} user ioBroker user of the admin session
     * @param {{ text?: unknown, nonce?: unknown, answer?: unknown }} message message of the page
     * @returns {Promise<object>} answer for the page
     */
    async onAdminChat(command, user, message) {
        const key = chatKey(ADMIN, user);
        const busy = () =>
            this.adminRunning.has(user) ||
            this.pending.some(p => p.target.kind === 'admin' && p.target.chatId === user);
        if (command === 'chatSend') {
            const text = String(message.text || '').trim();
            if (!this.root) {
                return { error: 'notRunning' };
            }
            if (!text || busy()) {
                return { error: text ? 'busy' : 'empty' };
            }
            this.adminChat.setError(user, null);
            this.adminRunning.add(user);
            const requestId = `admin-${crypto.randomBytes(8).toString('hex')}`;
            void this.process({ requestId, content: text, target: { kind: 'admin', chatId: user } }).finally(() =>
                this.adminRunning.delete(user),
            );
            return { accepted: true };
        }
        if (command === 'chatConfirm') {
            return { ok: this.adminChat.answer(user, message.nonce, message.answer) };
        }
        if (command === 'chatNew') {
            if (busy()) {
                return { error: 'busy' };
            }
            delete this.chats[key];
            await this.setStateAsync('telegram.chats', { val: JSON.stringify(this.chats), ack: true });
            this.adminChat.clear(user);
            this.log.info(`Admin chat of ${user}: new conversation`);
            return { ok: true };
        }
        // chatHistory
        let entries = [];
        const conversation = this.chats[key] ? await this.harness?.conversation(this.chats[key], this.context) : null;
        if (conversation) {
            const view = await conversation.viewState(this.context);
            try {
                entries = historyOf(view.value.entries);
            } finally {
                view.dispose?.();
            }
        }
        const notices = this.adminChat.notices(user);
        return {
            running: Boolean(this.root),
            model: this.model ? `${this.model.provider}/${this.model.modelId}` : '',
            simulation: Boolean(this.config.dryRun),
            user,
            busy: busy(),
            question: this.adminChat.question(user),
            error: this.adminChat.error(user),
            entries: withNotices(entries, notices),
        };
    }

    /**
     * Provider settings sent by the admin page (unsaved form values); missing fields come from the saved configuration.
     *
     * @param {unknown} message jsonData of the admin page
     * @returns {{ provider: string, modelId: string, baseUrl: string, keySource: string, apiKey: string, credentialId: string }} settings
     */
    providerForm(message) {
        const form = Object(message);
        const pick = name => String(form[name] ?? this.config[name] ?? '').trim();
        return {
            provider: pick('provider'),
            modelId: pick('modelId'),
            baseUrl: pick('baseUrl'),
            keySource: pick('keySource'),
            apiKey: pick('apiKey'),
            credentialId: pick('credentialId'),
        };
    }

    /**
     * Ask the configured model one short question.
     *
     * @param {ReturnType<PiAgent['providerForm']>} form provider settings
     * @returns {Promise<string>} text for the admin page
     */
    async testConnection(form) {
        const key = await resolveApiKey(this, form);
        if (!key && form.provider !== 'custom') {
            throw new Error(form.keySource === 'central' ? 'No credential chosen' : 'No API key entered');
        }
        if (form.provider === 'custom' && !form.modelId) {
            throw new Error('No model entered');
        }
        const { spec, models } = await createModelsWithKey(form.provider, key, {
            baseUrl: form.baseUrl,
            modelId: form.modelId,
        });
        const modelId = form.modelId || spec.defaultModel;
        const reply = await testModel(models, form.provider, modelId);
        return `${form.provider}/${modelId}: ${reply.slice(0, 200)}`;
    }

    /** @param {ioBroker.Message} obj message from a script or another adapter */
    async onMessage(obj) {
        if (obj?.command === 'listModels') {
            // model field of the admin page; needs no running agent, and an API key only for a custom server
            let options = [];
            try {
                const form = this.providerForm(obj.message);
                options = await listModels(form.provider, {
                    baseUrl: form.baseUrl,
                    apiKey: form.provider === 'custom' ? await resolveApiKey(this, form) : '',
                });
            } catch (e) {
                this.log.debug(`No model list: ${e.message}`);
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, options, obj.callback);
            }
            return;
        }
        if (obj?.command === 'testConnection') {
            // button of the admin page: one short question with the unsaved values of the form
            let answer;
            try {
                answer = { result: await this.testConnection(this.providerForm(obj.message)) };
            } catch (e) {
                answer = { error: e.message };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, answer, obj.callback);
            }
            return;
        }
        if (obj?.command === 'importInstances') {
            // button of the admin page: jsonData sends the unsaved table, "native" in the answer (useNative) replaces it
            let answer;
            try {
                const { rows, added } = await this.writeRulesWithInstances(Object(obj.message).writeRules);
                answer = { native: { writeRules: rows } };
                this.log.info(`Write permissions: ${added} installed instance(s) added to the table (not saved yet)`);
            } catch (e) {
                answer = { error: e.message };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, answer, obj.callback);
            }
            return;
        }
        if (['chatHistory', 'chatSend', 'chatConfirm', 'chatNew'].includes(String(obj?.command))) {
            let answer;
            try {
                answer = await this.onAdminChat(obj.command, adminUser(obj), Object(obj.message));
            } catch (e) {
                answer = { error: e.message };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, answer, obj.callback);
            }
            return;
        }
        if (obj?.command === 'listTimeZones') {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, timeZoneOptions(), obj.callback);
            }
            return;
        }
        if (obj?.command === 'listMessengerInstances') {
            let options = [];
            try {
                options = await this.messengerInstanceOptions();
            } catch (e) {
                this.log.debug(`No list of messenger instances: ${e.message}`);
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
