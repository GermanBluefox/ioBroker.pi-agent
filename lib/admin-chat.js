'use strict';

const crypto = require('node:crypto');
const { markdownToTelegramHtml, isWellFormedHtml, escapeHtml } = require('./telegram');

/** Pseudo instance of the admin chat in the keys of telegram.chats: "admin/<user>". */
const ADMIN = 'admin';

/** How long a confirmation in the admin chat waits for a button. */
const CONFIRM_TIMEOUT_MS = 10 * 60_000;

/** At most this many entries of a conversation go to the admin page. */
const MAX_HISTORY = 200;

const ADMIN_INSTRUCTIONS =
    'This conversation is the chat in the ioBroker admin. Markdown is shown formatted: bold, italic, inline code, code blocks, lists and links; tables are shown as monospace text.';

/**
 * Markdown of the model as safe HTML for the admin page (the same subset as Telegram: b, i, code, pre, a).
 *
 * @param {string} text Markdown
 * @returns {string} HTML
 */
function toHtml(text) {
    const html = markdownToTelegramHtml(text);
    return isWellFormedHtml(html) ? html : escapeHtml(text);
}

/**
 * Short text of a tool call, e.g. 'get_state x.0.lamp'.
 *
 * @param {{ name: string, arguments?: Record<string, unknown> }} call tool call
 * @returns {string} text
 */
function toolText(call) {
    const args = Object.values(call.arguments || {})
        .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
        .join(' ');
    return `${call.name}${args ? ` ${args}` : ''}`.slice(0, 200);
}

/**
 * Entries of a conversation as the admin page shows them.
 *
 * @param {ReadonlyArray<{ kind: string, model?: ReadonlyArray<{ role?: string, content?: unknown, timestamp?: number }> }>} entries entries of viewState
 * @returns {Array<{ role: string, text?: string, html?: string, ts?: number }>} messages, oldest first
 */
function historyOf(entries) {
    const messages = [];
    for (const entry of entries) {
        for (const m of entry.model || []) {
            if (entry.kind === 'pi.user' && m.role === 'user') {
                const text = typeof m.content === 'string' ? m.content : '';
                messages.push({ role: 'user', text, ts: m.timestamp });
            } else if (entry.kind === 'pi.assistant' && m.role === 'assistant' && Array.isArray(m.content)) {
                for (const part of m.content) {
                    if (part.type === 'toolCall') {
                        messages.push({ role: 'tool', text: toolText(part), ts: m.timestamp });
                    } else if (part.type === 'text' && part.text) {
                        messages.push({ role: 'assistant', html: toHtml(part.text), ts: m.timestamp });
                    }
                }
            }
        }
    }
    return messages.slice(-MAX_HISTORY);
}

/**
 * Reminders between the messages of the conversation: before the first question that was asked after them.
 * (Only the time of a user question is the local clock; the time of an answer may come from the provider.)
 *
 * @param {Array<{ role: string, ts?: number }>} entries messages in conversation order
 * @param {Array<{ role: string, ts: number }>} notices reminders, oldest first
 * @returns {Array<object>} messages and reminders
 */
function withNotices(entries, notices) {
    const result = [];
    let next = 0;
    for (const entry of entries) {
        while (entry.role === 'user' && next < notices.length && notices[next].ts < (entry.ts || 0)) {
            result.push(notices[next++]);
        }
        result.push(entry);
    }
    return [...result, ...notices.slice(next)];
}

/**
 * Questions and errors of the admin chat, per ioBroker user.
 *
 * @returns {object} admin chat state
 */
function createAdminChat() {
    /** user -> open confirmation */
    const questions = new Map();
    /** user -> error of the last request */
    const errors = new Map();
    /** user -> reminders that came due (kept in memory, the newest 20) */
    const notices = new Map();

    return {
        /**
         * Ask the user of the admin chat whether a write may happen; the page shows the question with buttons.
         *
         * @param {string} user ioBroker user of the conversation
         * @param {string} id state to write
         * @param {unknown} val value to write
         * @returns {Promise<string>} "yes", "no" or "timeout"
         */
        confirm(user, id, val) {
            questions.get(user)?.resolve('no'); // an older question is answered by the newer one
            const nonce = crypto.randomBytes(4).toString('hex');
            return new Promise(resolve => {
                const timer = setTimeout(() => finish('timeout'), CONFIRM_TIMEOUT_MS);
                timer.unref?.(); // a stopping adapter does not wait for an unanswered question
                const finish = answer => {
                    clearTimeout(timer);
                    if (questions.get(user)?.nonce === nonce) {
                        questions.delete(user);
                    }
                    resolve(answer);
                };
                questions.set(user, { nonce, id, val, resolve: finish });
            });
        },

        /**
         * A button of the page was pressed.
         *
         * @param {string} user ioBroker user
         * @param {unknown} nonce nonce of the question
         * @param {unknown} answer "yes" or anything else
         * @returns {boolean} true when the question was still open
         */
        answer(user, nonce, answer) {
            const question = questions.get(user);
            if (!question || question.nonce !== nonce) {
                return false;
            }
            question.resolve(answer === 'yes' ? 'yes' : 'no');
            return true;
        },

        /**
         * @param {string} user ioBroker user
         * @returns {{ nonce: string, id: string, val: unknown } | null} open question
         */
        question(user) {
            const q = questions.get(user);
            return q ? { nonce: q.nonce, id: q.id, val: q.val } : null;
        },

        /**
         * @param {string} user ioBroker user
         * @param {string | null} text error of the last request, null to clear
         */
        setError(user, text) {
            if (text === null) {
                errors.delete(user);
            } else {
                errors.set(user, text);
            }
        },

        /**
         * @param {string} user ioBroker user
         * @returns {string | null} error of the last request
         */
        error(user) {
            return errors.get(user) ?? null;
        },

        /**
         * A reminder of the user's conversation came due: the page shows it between the messages.
         *
         * @param {string} user ioBroker user
         * @param {string} text reminder text (Markdown)
         */
        addNotice(user, text) {
            const list = [...(notices.get(user) || []), { role: 'notice', html: toHtml(text), ts: Date.now() }];
            notices.set(user, list.slice(-20));
        },

        /**
         * @param {string} user ioBroker user
         * @returns {Array<{ role: string, html: string, ts: number }>} reminders that came due
         */
        notices(user) {
            return notices.get(user) || [];
        },

        /** @param {string} user ioBroker user whose conversation starts anew */
        clear(user) {
            errors.delete(user);
            notices.delete(user);
        },
    };
}

module.exports = { ADMIN, ADMIN_INSTRUCTIONS, historyOf, toolText, withNotices, createAdminChat };
