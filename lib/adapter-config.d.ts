// Native configuration of pi-agent (io-package.json "native"), for the type check of the JavaScript sources.
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            provider: string;
            modelId: string;
            apiKey: string;
            writeAllow: string;
            instructions: string;
            dryRun: boolean;
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
