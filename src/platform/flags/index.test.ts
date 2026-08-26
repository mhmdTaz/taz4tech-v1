import { describe, expect, it } from 'vitest';
import { createFlags, FLAGS, type FlagName, fixedFlags, flagEnvName } from './index';

describe('flag naming', () => {
  it('maps a camelCase flag to a screaming-snake environment variable', () => {
    expect(flagEnvName('whatsappTapToSend')).toBe('TAZ_FLAG_WHATSAPP_TAP_TO_SEND');
    expect(flagEnvName('excelImporter')).toBe('TAZ_FLAG_EXCEL_IMPORTER');
    expect(flagEnvName('loyalty')).toBe('TAZ_FLAG_LOYALTY');
    expect(flagEnvName('whatsappCloudApi')).toBe('TAZ_FLAG_WHATSAPP_CLOUD_API');
  });

  it('produces a distinct variable for every declared flag', () => {
    const names = (Object.keys(FLAGS) as FlagName[]).map(flagEnvName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('documents every flag with a human description', () => {
    for (const description of Object.values(FLAGS)) {
      expect(description.length).toBeGreaterThan(0);
    }
  });
});

describe('createFlags', () => {
  it('is off for everything when the environment says nothing', () => {
    const flags = createFlags({});
    for (const flag of Object.keys(FLAGS) as FlagName[]) {
      expect(flags.isOn(flag)).toBe(false);
    }
  });

  it('turns a flag on for exactly the value "on"', () => {
    expect(createFlags({ TAZ_FLAG_EXCEL_IMPORTER: 'on' }).isOn('excelImporter')).toBe(true);
    expect(createFlags({ TAZ_FLAG_EXCEL_IMPORTER: 'ON' }).isOn('excelImporter')).toBe(true);
  });

  it('treats every other value as off, including the ones that look truthy', () => {
    // 'true', '1' and 'yes' are the values people reach for by habit. Accepting
    // them would mean a typo like 'tru' silently disables a shipped feature,
    // so there is exactly one spelling.
    for (const value of ['true', '1', 'yes', 'off', '', 'enabled']) {
      expect(createFlags({ TAZ_FLAG_EXCEL_IMPORTER: value }).isOn('excelImporter')).toBe(false);
    }
  });

  it('leaves the other flags alone when one is on', () => {
    const flags = createFlags({ TAZ_FLAG_LOYALTY: 'on' });
    expect(flags.isOn('loyalty')).toBe(true);
    expect(flags.isOn('cardPayments')).toBe(false);
  });
});

describe('fixedFlags', () => {
  it('turns on exactly the listed flags', () => {
    const flags = fixedFlags(['cardPayments', 'loyalty']);
    expect(flags.isOn('cardPayments')).toBe(true);
    expect(flags.isOn('loyalty')).toBe(true);
    expect(flags.isOn('excelImporter')).toBe(false);
  });

  it('is off for everything when given an empty list', () => {
    expect(fixedFlags([]).isOn('whatsappCloudApi')).toBe(false);
  });
});
