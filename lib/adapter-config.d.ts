// Native configuration of pi-agent (io-package.json "native"), for the type check of the JavaScript sources.
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            provider: string;
            modelId: string;
            apiKey: string;
            /** Table "Write permissions" since 0.1.0. */
            writeRules: Array<{ scope: string; write: boolean; confirm: boolean }>;
            writeAllow: string;
            instructions: string;
            dryRun: boolean;
            /** Messenger instances (telegram, max) since 0.1.0: one row per instance. */
            messengers: Array<{ enabled?: boolean; instance: string; users: string; prefix: string }>;
            /** Single fields of 0.0.5 and earlier, moved into messengers at the first start. */
            telegramInstance: string;
            telegramUsers: string;
            telegramPrefix: string;
            confirmRequired: string;
            historyInstance: string;
            timeZone: string;
        }
    }
}

export {};
