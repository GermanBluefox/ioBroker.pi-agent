// Types shared by the JavaScript sources, for the type check only.

/** What the tools read from the adapter at every use, and the adapter functions they call back into. */
export interface Policy {
    /** States the agent may write. */
    allowlist: RegExp[];
    /** States whose write the user must confirm first (missing: none). */
    confirmList?: RegExp[];
    /** Log writes instead of executing them. */
    dryRun: boolean;
    /** IANA time zone of the house, e.g. "Europe/Berlin". */
    timeZone?: string;
    /** Extra instructions of the user. */
    instructions: string;
    /** Ask the user; resolves to "yes", "no", "timeout" or "unavailable". */
    requestConfirmation?: (request: { conversationId: unknown; id: string; val: unknown }) => Promise<string>;
    /** Send a reminder that is due. */
    deliverReminder?: (conversationId: unknown, text: string) => Promise<void>;
    /** History instance to query, or "". */
    historyInstance?: () => Promise<string>;
}
