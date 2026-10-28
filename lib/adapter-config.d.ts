// Native configuration of pi-agent (io-package.json "native"), for the type check of the JavaScript sources.
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            provider: string;
            modelId: string;
            /** Endpoint of an OpenAI-compatible server (provider "custom") since 0.3.0. */
            baseUrl: string;
            /** Where the API key comes from since 0.3.0: this instance or the central credential store of admin. */
            keySource: 'adapter' | 'central';
            apiKey: string;
            /** Credential of the central credential store (system.credentials.*) when keySource is "central". */
            credentialId: string;
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
            /** Tab "Backup" since 0.4.0: automatic backup every so many hours (0 off, 24, 168) and how many to keep. */
            autoBackupInterval: number;
            backupKeep: number;
            /** Copy of every backup to an external server over SFTP. */
            remoteEnabled: boolean;
            remoteHost: string;
            remotePort: number;
            remoteUser: string;
            remotePassword: string;
            remoteDirectory: string;
            remoteHostKey: string;
            remoteKeep: number;
        }
    }
}

export {};
