'use strict';

/**
 * Deleting conversations from the store, e.g. the old one after "New conversation" in the admin chat.
 *
 * Pi Durable has no call to delete a conversation, and the store must not be changed while the harness has it open
 * (it keeps documents and contexts in memory). So a conversation to delete is only queued (purge.json next to the
 * store) and deleted at the next start, before the store is opened, in one transaction:
 *
 * - only with the schema version this code was written for (durable_schema.version); with any other version nothing
 *   is deleted, so an update of Pi Durable cannot damage the store;
 * - only when no task of the conversation is still open — a reminder sleeps as a task until it is due; such a
 *   conversation stays queued until then;
 * - never a conversation that a chat still uses;
 * - with the conversations it owns (owner_conversation_id, or owner_task_id of one of its tasks).
 *
 * Afterwards VACUUM gives the space back to the file system.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Queue of the conversations to delete, next to the store. */
const PURGE_FILE = 'purge.json';

/** Version of the SQLite schema of Pi Durable that the statements below are written for. */
const SCHEMA_VERSION = 2;

/**
 * The queued conversation ids.
 *
 * @param {string} dir instance data directory
 * @returns {string[]} ids, as stored
 */
function queuedPurges(dir) {
    try {
        const list = JSON.parse(fs.readFileSync(path.join(dir, PURGE_FILE), 'utf8'));
        return Array.isArray(list) ? list.map(String).filter(id => /^\d+$/.test(id)) : [];
    } catch {
        return [];
    }
}

/**
 * Queue a conversation for deletion at the next start.
 *
 * @param {string} dir instance data directory
 * @param {unknown} conversationId id of the conversation
 */
function queuePurge(dir, conversationId) {
    const id = String(conversationId ?? '');
    if (!/^\d+$/.test(id)) {
        return;
    }
    const list = queuedPurges(dir);
    if (!list.includes(id)) {
        writeQueue(dir, [...list, id]);
    }
}

/**
 * @param {string} dir instance data directory
 * @param {string[]} list ids still to delete
 */
function writeQueue(dir, list) {
    const file = path.join(dir, PURGE_FILE);
    if (list.length === 0) {
        fs.rmSync(file, { force: true });
        return;
    }
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(list));
    fs.renameSync(`${file}.tmp`, file);
}

/**
 * Whether the store has the schema the statements are written for.
 *
 * @param {import('node:sqlite').DatabaseSync} db open store
 * @returns {number} schema version, 0 when unknown
 */
function schemaVersion(db) {
    try {
        return Number(Object(db.prepare('SELECT version FROM durable_schema WHERE singleton = 1').get()).version) || 0;
    } catch {
        return 0;
    }
}

/**
 * A conversation with everything it owns: its sub-conversations and their tasks.
 *
 * @param {import('node:sqlite').DatabaseSync} db open store
 * @param {number} id conversation id
 * @returns {{ conversations: number[], tasks: number[] }} ids
 */
function ownedBy(db, id) {
    const conversations = [id];
    const tasks = [];
    for (let i = 0; i < conversations.length; i++) {
        const own = db
            .prepare('SELECT id FROM tasks WHERE conversation_id = ?')
            .all(conversations[i])
            .map(r => Number(r.id));
        tasks.push(...own);
        const children = db
            .prepare(
                `SELECT id FROM conversations WHERE owner_conversation_id = ?${own.length ? ` OR owner_task_id IN (${own.join(',')})` : ''}`,
            )
            .all(conversations[i])
            .map(r => Number(r.id))
            .filter(child => !conversations.includes(child));
        conversations.push(...children);
    }
    return { conversations, tasks };
}

/**
 * Delete the queued conversations. Runs before the store is opened.
 *
 * @param {string} dir instance data directory
 * @param {Set<string>} inUse conversation ids a chat still uses
 * @param {{ check?: boolean }} [options] check: only find out what would be deleted, change nothing
 * @returns {{ deleted: string[], waiting: string[], skipped?: string }} what happened; `skipped` names why nothing was done
 */
function purgeQueued(dir, inUse, options = {}) {
    const queued = queuedPurges(dir);
    const storeFile = path.join(dir, 'session.sqlite');
    if (queued.length === 0 || !fs.existsSync(storeFile)) {
        return { deleted: [], waiting: queued };
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(storeFile, { readOnly: Boolean(options.check) });
    const deleted = [];
    const waiting = [];
    try {
        const version = schemaVersion(db);
        if (version !== SCHEMA_VERSION) {
            return {
                deleted,
                waiting: queued,
                skipped: `the store has schema version ${version}, not ${SCHEMA_VERSION}`,
            };
        }
        for (const id of queued) {
            if (inUse.has(id)) {
                continue; // a chat uses it again (e.g. after a restore): it stays, and leaves the queue
            }
            const exists = db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(Number(id));
            if (!exists) {
                continue;
            }
            const { conversations, tasks } = ownedBy(db, Number(id));
            const list = conversations.join(',');
            const open = db
                .prepare(`SELECT count(*) AS n FROM tasks WHERE conversation_id IN (${list}) AND status <> 'terminal'`)
                .get();
            if (Number(Object(open).n) > 0) {
                waiting.push(id); // e.g. a reminder that is not due yet
                continue;
            }
            if (options.check) {
                deleted.push(id);
                continue;
            }
            const taskList = tasks.length ? tasks.join(',') : 'NULL';
            db.exec('BEGIN');
            try {
                const documents = db
                    .prepare(
                        `SELECT id FROM documents WHERE (scope_kind = 'conversation' AND owner_id IN (${list})) OR (scope_kind = 'task' AND owner_id IN (${taskList}))`,
                    )
                    .all()
                    .map(r => Number(r.id));
                const docList = documents.length ? documents.join(',') : 'NULL';
                const records = [
                    ...conversations,
                    ...tasks,
                    ...documents,
                    ...db
                        .prepare(`SELECT id FROM entries WHERE conversation_id IN (${list})`)
                        .all()
                        .map(r => Number(r.id)),
                    ...db
                        .prepare(`SELECT id FROM submissions WHERE conversation_id IN (${list})`)
                        .all()
                        .map(r => Number(r.id)),
                ];
                db.exec(`DELETE FROM document_revisions WHERE document_id IN (${docList})`);
                db.exec(`DELETE FROM documents WHERE id IN (${docList})`);
                db.exec(`DELETE FROM entries WHERE conversation_id IN (${list})`);
                db.exec(`DELETE FROM submissions WHERE conversation_id IN (${list})`);
                db.exec(`DELETE FROM tasks WHERE conversation_id IN (${list})`);
                db.exec(`DELETE FROM conversations WHERE id IN (${list})`);
                for (let i = 0; i < records.length; i += 500) {
                    db.exec(`DELETE FROM record_ids WHERE id IN (${records.slice(i, i + 500).join(',')})`);
                }
                db.exec('COMMIT');
                deleted.push(id);
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        }
        if (deleted.length > 0 && !options.check) {
            db.exec('VACUUM');
        }
    } finally {
        db.close();
    }
    if (!options.check) {
        writeQueue(dir, waiting);
    }
    return { deleted, waiting };
}

module.exports = { PURGE_FILE, SCHEMA_VERSION, queuedPurges, queuePurge, purgeQueued };
