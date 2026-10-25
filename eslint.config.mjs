import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: ['node_modules/**', 'test/**', '.dev-server/**'],
    },
    {
        rules: {
            // Allow console in scripts
            'no-console': 'off',
        },
    },
];
