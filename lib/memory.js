'use strict';

/**
 * The long-term memory of the agent: short facts kept across all conversations (messengers, admin chat, sendTo callers
 * such as ioBroker.assistant). The model adds them with the tool remember and removes them with forget; all of them go
 * into the instructions of every conversation. They are kept in the state memory.list (JSON), where the user can read
 * and edit them, and go into the backups of the conversations.
 */

const crypto = require('node:crypto');

/** At most this many facts. */
const MAX_FACTS = 100;
/** At most this many characters of one fact. */
const MAX_FACT_LENGTH = 500;
/** At most this many characters of all facts together (they go into every request). */
const MAX_TOTAL_LENGTH = 8000;

/**
 * Facts of a stored list; anything that is not a fact is left out.
 *
 * @param {unknown} value state value or backup content
 * @returns {Array<{ id: string, text: string, ts: number }>} facts
 */
function parseFacts(value) {
    let list = value;
    if (typeof value === 'string') {
        try {
            list = value ? JSON.parse(value) : [];
        } catch {
            return [];
        }
    }
    return (Array.isArray(list) ? list : [])
        .filter(f => f && typeof f.text === 'string' && f.text.trim())
        .map(f => ({
            id: String(f.id || newId()),
            text: f.text.trim().slice(0, MAX_FACT_LENGTH),
            ts: Number(f.ts) || 0,
        }))
        .slice(0, MAX_FACTS);
}

/** @returns {string} short id of a fact, e.g. "m3f2a" */
function newId() {
    return `m${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * The memory of an adapter instance.
 *
 * @param {Pick<ioBroker.Adapter, 'getStateAsync' | 'setStateAsync'>} adapter adapter instance (state memory.list)
 * @param {() => boolean} enabled whether the memory is switched on in the settings
 * @returns {{ load: () => Promise<void>, enabled: () => boolean, list: () => Array<{ id: string, text: string, ts: number }>, add: (fact: string) => Promise<string>, remove: (query: string) => Promise<string>, replace: (facts: unknown) => Promise<void> }} memory
 */
function createMemory(adapter, enabled) {
    let facts = [];
    let writing = Promise.resolve();

    /** Store the list; writes run one after the other. */
    const save = () => {
        const val = JSON.stringify(facts);
        writing = writing
            .then(() => adapter.setStateAsync('memory.list', { val, ack: true }))
            .then(() => adapter.setStateAsync('memory.count', { val: facts.length, ack: true }))
            .then(() => undefined);
        return writing;
    };

    return {
        /** Read the stored facts (at the start, and after the user edited memory.list). */
        async load() {
            facts = parseFacts((await adapter.getStateAsync('memory.list'))?.val);
        },

        enabled,

        list: () => facts,

        async add(fact) {
            if (!enabled()) {
                return 'The long-term memory is switched off in the settings; nothing was kept.';
            }
            const text = String(fact).trim().replace(/\s+/g, ' ');
            if (!text) {
                return 'Nothing to remember: the fact is empty.';
            }
            if (text.length > MAX_FACT_LENGTH) {
                return `Not kept: a fact may have at most ${MAX_FACT_LENGTH} characters. Keep it shorter.`;
            }
            const same = facts.find(f => f.text.toLowerCase() === text.toLowerCase());
            if (same) {
                return `Already kept as [${same.id}].`;
            }
            const total = facts.reduce((sum, f) => sum + f.text.length, 0) + text.length;
            if (facts.length >= MAX_FACTS || total > MAX_TOTAL_LENGTH) {
                return `Not kept: the memory is full (at most ${MAX_FACTS} facts, ${MAX_TOTAL_LENGTH} characters). Ask the user which facts to forget.`;
            }
            const entry = { id: newId(), text, ts: Date.now() };
            facts = [...facts, entry];
            await save();
            return `Kept as [${entry.id}]. It is part of every conversation from the next request on.`;
        },

        async remove(query) {
            const q = String(query)
                .trim()
                .replace(/^\[|\]$/g, '')
                .toLowerCase();
            if (!q) {
                return 'Nothing removed: say which fact (its id or a word of it).';
            }
            const byId = facts.filter(f => f.id.toLowerCase() === q);
            const matches = byId.length ? byId : facts.filter(f => f.text.toLowerCase().includes(q));
            if (matches.length === 0) {
                return `No fact matches "${query}".`;
            }
            if (matches.length > 3 && !byId.length) {
                return `"${query}" matches ${matches.length} facts; give the id of the one to forget: ${matches.map(f => f.id).join(', ')}.`;
            }
            facts = facts.filter(f => !matches.includes(f));
            await save();
            return `Forgotten: ${matches.map(f => `[${f.id}] ${f.text}`).join('; ')}.`;
        },

        /**
         * Replace all facts, e.g. from a restored backup or after the user edited memory.list.
         *
         * @param {unknown} list facts as JSON text or list
         */
        async replace(list) {
            facts = parseFacts(list);
            await save();
        },
    };
}

module.exports = { MAX_FACTS, MAX_FACT_LENGTH, MAX_TOTAL_LENGTH, parseFacts, createMemory };
