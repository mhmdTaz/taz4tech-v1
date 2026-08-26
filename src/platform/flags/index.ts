/**
 * Feature flags.
 *
 * The point of these on a solo project is not A/B testing — it is being able to
 * merge an unfinished phase into develop behind an off switch instead of holding
 * a long-lived branch that rots. Every flag here is expected to be deleted once
 * its feature ships; a flag that outlives its phase is technical debt with a
 * config file attached.
 *
 * Read from the environment as TAZ_FLAG_<NAME>=on. Default is off, always: a
 * flag that defaults on cannot be used to protect an unfinished feature.
 */

export const FLAGS = {
  /** Phase 2: opens WhatsApp with the message pre-written; the operator presses send. */
  whatsappTapToSend: 'Tap-to-send WhatsApp button on order detail',
  /** Phase 4: Cloud API on the second number — automatic sends and campaigns. */
  whatsappCloudApi: 'Automated WhatsApp via Cloud API',
  /** Phase 1: Excel catalogue importer with column mapping and dry-run preview. */
  excelImporter: 'Excel (.xlsx) product importer',
  /** Phase 5: card/wallet gateway, gated on company registration. */
  cardPayments: 'Card and wallet checkout',
  /** Phase 4: loyalty points and referrals keyed on phone identity. */
  loyalty: 'Loyalty points and referrals',
} as const;

export type FlagName = keyof typeof FLAGS;

export interface Flags {
  isOn(flag: FlagName): boolean;
}

const envKey = (flag: FlagName): string =>
  `TAZ_FLAG_${flag.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;

export const createFlags = (source: Record<string, string | undefined> = process.env): Flags => {
  const enabled = new Set<FlagName>();
  for (const flag of Object.keys(FLAGS) as FlagName[]) {
    if (source[envKey(flag)]?.toLowerCase() === 'on') enabled.add(flag);
  }
  return { isOn: (flag) => enabled.has(flag) };
};

/** Explicit set of on-flags. For tests, and for previewing a phase in staging. */
export const fixedFlags = (on: readonly FlagName[]): Flags => {
  const enabled = new Set(on);
  return { isOn: (flag) => enabled.has(flag) };
};

/** The environment variable that controls a flag — used by docs and render.yaml. */
export const flagEnvName = envKey;
