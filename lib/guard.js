'use strict';

/**
 * Compile the write allowlist (one regular expression per line, "#" starts a comment).
 * Invalid lines are reported through `onInvalid` and skipped, so a typo never opens the list.
 *
 * @param {string} text raw configuration text
 * @param {(line: string, message: string) => void} [onInvalid] called for each broken line
 * @returns {RegExp[]} compiled expressions
 */
function parseAllowlist(text, onInvalid) {
	const result = [];
	for (const raw of String(text || '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		try {
			result.push(new RegExp(line));
		} catch (e) {
			onInvalid?.(line, e.message);
		}
	}
	return result;
}

/**
 * Decide whether the agent may write a state. An empty allowlist denies everything.
 *
 * @param {string} id state id
 * @param {RegExp[]} allowlist compiled allowlist
 * @returns {boolean} true when the id matches at least one expression
 */
function isWriteAllowed(id, allowlist) {
	return allowlist.some(re => re.test(id));
}

/**
 * Stable request id for a trigger, so a retry after a crash finds the original submission.
 *
 * @param {import('node:crypto')} crypto node:crypto module
 * @param {number} ts timestamp of the triggering state
 * @param {unknown} val value of the triggering state
 * @returns {string} request id
 */
function requestIdFor(crypto, ts, val) {
	return `chat-${crypto.createHash('sha1').update(`${ts}:${String(val)}`).digest('hex').slice(0, 16)}`;
}

module.exports = { parseAllowlist, isWriteAllowed, requestIdFor };
