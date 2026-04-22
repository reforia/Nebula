import type { I18nextToolkitConfig } from 'i18next-cli';

const config: I18nextToolkitConfig = {
  locales: ['en', 'zh'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'src/i18n/locales/{{language}}.json',
    defaultNS: 'translation',
    keySeparator: '.',
    nsSeparator: false,
    sort: true,
  },
};

export default config;
