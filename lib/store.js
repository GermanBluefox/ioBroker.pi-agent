'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Open the conversation store of the instance.
 *
 * SQLite (Node's built-in node:sqlite) keeps only the working set in memory. The JSONL store of version
 * 0.0.1/0.0.2 keeps the whole history in memory and grows with every request, so an existing JSONL store
 * is moved aside and replaced by SQLite - unless requests are still pending in it: then it is used once
 * more, and the switch happens at the next start.
 *
 * @param {string} dir instance data directory
 * @param {object} context chord context
 * @param {{ pendingCount: number, log: { info: (msg: string) => void } }} options pending requests and logger
 * @returns {Promise<{ storage: object, kind: 'sqlite' | 'jsonl', migrated: boolean }>} the opened store
 */
async function openStore(dir, context, { pendingCount, log }) {
    const sqliteFile = path.join(dir, 'session.sqlite');
    const jsonlDir = path.join(dir, 'session');
    let migrated = false;
    if (!fs.existsSync(sqliteFile) && fs.existsSync(jsonlDir)) {
        if (pendingCount > 0) {
            log.info(
                `${pendingCount} request(s) still pending in the JSONL store; switching to SQLite at the next start`,
            );
            const jsonl = await import('@earendil-works/pi-durable/storage/jsonl/node');
            return { storage: await jsonl.openNodeJsonlStorage(jsonlDir, context), kind: 'jsonl', migrated };
        }
        const backup = `${jsonlDir}.jsonl-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.renameSync(jsonlDir, backup);
        migrated = true;
        log.info(
            `Conversation store moved to SQLite. The previous history is kept in ${backup} and is no longer used.`,
        );
    }
    fs.mkdirSync(dir, { recursive: true });
    const sqlite = await import('@earendil-works/pi-durable/storage/sqlite/node');
    return { storage: await sqlite.openNodeSqliteStorage(sqliteFile), kind: 'sqlite', migrated };
}

module.exports = { openStore };
