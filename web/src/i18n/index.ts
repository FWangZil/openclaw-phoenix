import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import commonEn from './en/common.json';
import setupEn from './en/setup.json';
import archivesEn from './en/archives.json';
import configurationEn from './en/configuration.json';

import commonZhCN from './zh-CN/common.json';
import setupZhCN from './zh-CN/setup.json';
import archivesZhCN from './zh-CN/archives.json';
import configurationZhCN from './zh-CN/configuration.json';

// 合并所有命名空间到默认翻译命名空间
const mergeTranslations = (common: typeof commonEn, setup: typeof setupEn, archives: typeof archivesEn, configuration: typeof configurationEn) => {
  return {
    ...common,
    ...setup,
    ...archives,
    ...configuration,
  };
};

export const translations = {
  en: mergeTranslations(commonEn, setupEn, archivesEn, configurationEn),
  'zh-CN': mergeTranslations(commonZhCN, setupZhCN, archivesZhCN, configurationZhCN),
};

export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: { translation: translations.en },
    'zh-CN': { translation: translations['zh-CN'] },
  },
  interpolation: { escapeValue: false },
});

export default i18n;
