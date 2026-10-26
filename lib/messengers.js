'use strict';

const crypto = require('node:crypto');
const {
    parseRequest,
    splitMessage,
    markdownToTelegramHtml,
    isWellFormedHtml,
    escapeHtml,
    TELEGRAM_INSTRUCTIONS,
} = require('./telegram');

/** How long a confirmation waits for a button press. */
const CONFIRM_TIMEOUT_MS = 10 * 60_000;

const MAX_INSTRUCTIONS =
    'This conversation is a chat in the MAX messenger. Keep answers short. Write plain text only: no Markdown, no tables, no headings.';

/**
 * Markdown of the model as plain text, for a messenger that shows Markdown literally.
 *
 * @param {string} text Markdown
 * @returns {string} plain text
 */
function markdownToPlain(text) {
    return text
        .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/__([^_\n]+)__/g, '$1')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
}

/**
 * Messenger adapters the agent can chat through: they receive messages in <instance>.communicate.request
 * ("[name]text", the ids in requestChatId/requestUserId/requestMessageId, as the telegram adapter writes it).
 *
 * @param {object} adapter the pi-agent adapter (sendTo, sendToAsync, getForeignStatesAsync, log)
 * @returns {Record<string, object>} driver per adapter name
 */
function createDrivers(adapter) {
    const telegram = {
        label: 'Telegram',
        instructions: TELEGRAM_INSTRUCTIONS,

        /**
         * @param {string} instance telegram instance
         * @param {unknown} value value of communicate.request
         */
        async readRequest(instance, value) {
            const base = `${instance}.communicate`;
            const meta = await adapter.getForeignStatesAsync([
                `${base}.requestChatId`,
                `${base}.requestUserId`,
                `${base}.requestMessageId`,
                `${base}.users`,
            ]);
            const chatId = meta[`${base}.requestChatId`]?.val;
            const userId = meta[`${base}.requestUserId`]?.val;
            let users = {};
            try {
                users = JSON.parse(String(meta[`${base}.users`]?.val || '{}'));
            } catch {
                // the user list is only used to resolve user names
            }
            const known = users[String(userId)];
            return {
                ...parseRequest(value),
                chatId: chatId === null || chatId === undefined || chatId === '' ? '' : String(chatId),
                messageId: meta[`${base}.requestMessageId`]?.val,
                sender: { userId, userName: known?.userName, firstName: known?.firstName, known: Boolean(known) },
            };
        },

        /**
         * @param {string} instance telegram instance
         * @param {string} chatId chat
         * @param {string} text answer (Markdown)
         */
        send(instance, chatId, text) {
            for (const part of splitMessage(text)) {
                // Telegram shows Markdown literally; its HTML mode renders bold, italic, code and links.
                // The telegram adapter does not report a rejected message back, so only well-formed HTML is sent.
                const html = markdownToTelegramHtml(part);
                if (isWellFormedHtml(html)) {
                    adapter.sendTo(instance, 'send', { text: html, chatId, parse_mode: 'HTML' });
                } else {
                    adapter.log.warn('Telegram: the answer could not be converted to valid HTML; sent as plain text');
                    adapter.sendTo(instance, 'send', { text: part, chatId });
                }
            }
        },

        /**
         * @param {string} instance telegram instance
         * @param {string} chatId chat
         * @param {string} id state to write
         * @param {unknown} val value to write
         * @returns {Promise<string>} "yes", "no" or "timeout"
         */
        async confirm(instance, chatId, id, val) {
            const question = `⚠️ Set <code>${escapeHtml(id)}</code> to <code>${escapeHtml(JSON.stringify(val))}</code>?`;
            const answer = await adapter.sendToAsync(
                instance,
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
                { timeout: CONFIRM_TIMEOUT_MS },
            );
            if (String(answer) === '__timeout__') {
                return 'timeout';
            }
            // the telegram adapter answers with the pressed button (a callback query with "data")
            return Object(answer).data === 'pi-agent:yes' ? 'yes' : 'no';
        },

        /** Telegram answers a button press through "ask"; nothing arrives as a message. */
        takeButton() {
            return false;
        },
    };

    /** Confirmations of the MAX driver that wait for a button press: "<instance>/<chat>" -> waiter. */
    const waiting = new Map();

    const max = {
        label: 'MAX',
        instructions: MAX_INSTRUCTIONS,

        /**
         * @param {string} instance max instance
         * @param {unknown} value value of communicate.request
         */
        async readRequest(instance, value) {
            const base = `${instance}.communicate`;
            const meta = await adapter.getForeignStatesAsync([
                `${base}.requestChatId`,
                `${base}.requestUserId`,
                `${base}.requestMessageId`,
            ]);
            const group = meta[`${base}.requestChatId`]?.val;
            const userId = meta[`${base}.requestUserId`]?.val;
            const hasUser = userId !== null && userId !== undefined && userId !== '';
            // requestChatId is 0 in a private dialog: the answer goes to the user ("u<user id>")
            const chatId = group && Number(group) !== 0 ? String(group) : hasUser ? `u${userId}` : '';
            // users.<id> exists for users who wrote to the bot privately; group members are known by id only
            const name = hasUser ? await adapter.getForeignStatesAsync([`${instance}.users.${userId}.username`]) : {};
            const known = name[`${instance}.users.${userId}.username`];
            return {
                ...parseRequest(value),
                chatId,
                messageId: meta[`${base}.requestMessageId`]?.val || undefined,
                sender: { userId, firstName: known?.val ? String(known.val) : undefined, known: Boolean(known) },
            };
        },

        /**
         * @param {string} instance max instance
         * @param {string} chatId "u<user id>" for a private dialog, else the group chat id
         * @param {string} text answer (Markdown)
         * @param {Array} [keyboard] buttons below the message
         */
        send(instance, chatId, text, keyboard) {
            const to = chatId.startsWith('u') ? { userId: chatId.slice(1) } : { chatId };
            const parts = splitMessage(markdownToPlain(text));
            parts.forEach((part, i) => {
                const last = i === parts.length - 1;
                adapter.sendTo(instance, 'send', { ...to, text: part, ...(keyboard && last ? { keyboard } : {}) });
            });
        },

        /**
         * MAX has no "ask": the buttons carry a payload that comes back as a message, see takeButton.
         *
         * @param {string} instance max instance
         * @param {string} chatId chat
         * @param {string} id state to write
         * @param {unknown} val value to write
         * @returns {Promise<string>} "yes", "no" or "timeout"
         */
        confirm(instance, chatId, id, val) {
            const key = `${instance}/${chatId}`;
            waiting.get(key)?.resolve('no'); // an older question of this chat is answered by the newer one
            const nonce = crypto.randomBytes(4).toString('hex');
            return new Promise(resolve => {
                const timer = setTimeout(() => finish('timeout'), CONFIRM_TIMEOUT_MS);
                timer.unref?.(); // a stopping adapter does not wait for an unanswered question
                const finish = answer => {
                    clearTimeout(timer);
                    if (waiting.get(key)?.nonce === nonce) {
                        waiting.delete(key);
                    }
                    resolve(answer);
                };
                waiting.set(key, { nonce, resolve: finish });
                max.send(instance, chatId, `⚠️ Set ${id} to ${JSON.stringify(val)}?`, [
                    [
                        { text: '✅ Yes', callback: `pi-agent:yes:${nonce}` },
                        { text: '❌ No', callback: `pi-agent:no:${nonce}` },
                    ],
                ]);
            });
        },

        /**
         * A button of a confirmation was pressed: its payload arrives like a message.
         *
         * @param {string} instance max instance
         * @param {{ chatId: string, text: string, sender: { userId: unknown } }} request request
         * @returns {boolean} true when the request was a button of the agent (and must not go to the model)
         */
        takeButton(instance, request) {
            const match = /^pi-agent:(yes|no):([0-9a-f]+)$/.exec(request.text.trim());
            if (!match) {
                return false;
            }
            const waiter = waiting.get(`${instance}/${request.chatId}`);
            if (waiter?.nonce === match[2]) {
                waiter.resolve(match[1]);
                adapter.sendTo(instance, 'answerCallback', {
                    userId: request.sender.userId,
                    text: match[1] === 'yes' ? '✅' : '❌',
                });
            }
            return true; // an outdated button is dropped as well
        },
    };

    return { telegram, max };
}

/**
 * Adapter name of an instance: "telegram.0" -> "telegram".
 *
 * @param {string} instance instance id
 * @returns {string} adapter name
 */
function messengerType(instance) {
    return instance.slice(0, instance.lastIndexOf('.'));
}

/** Adapters with a driver, for the instance list of the admin page. */
const MESSENGER_ADAPTERS = ['telegram', 'max'];

module.exports = { createDrivers, messengerType, markdownToPlain, MESSENGER_ADAPTERS, MAX_INSTRUCTIONS };
