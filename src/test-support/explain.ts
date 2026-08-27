/**
 * Helpers for asserting on MongoDB explain() output.
 *
 * Test-only, and excluded from the boundary graph for that reason — it is
 * imported exclusively by *.integration.test.ts files.
 */

/**
 * Every `stage` name anywhere in a plan tree.
 *
 * Deliberately walks EVERY nested value rather than the known plan keys
 * (`inputStage`, `inputStages`, `queryPlan`). Those keys differ between the
 * classic engine, SBE, and MongoDB versions — a walker that lists them returns
 * an empty array on an unfamiliar shape, and an empty array silently satisfies
 * "does not contain COLLSCAN". The gate would then pass on every query,
 * including the ones it exists to catch.
 */
export const stagesOf = (plan: unknown): string[] => {
  if (Array.isArray(plan)) return plan.flatMap(stagesOf);
  if (plan === null || typeof plan !== 'object') return [];

  const node = plan as Record<string, unknown>;
  const here = typeof node.stage === 'string' ? [node.stage] : [];
  return [...here, ...Object.values(node).flatMap(stagesOf)];
};

/**
 * The stages of the plan MongoDB actually chose.
 *
 * Walking the whole `queryPlanner` is wrong in both directions, because it
 * includes `rejectedPlans`:
 *
 *   - a SORT or COLLSCAN in a REJECTED plan fails an assertion about a query
 *     that is in fact served perfectly by an index;
 *   - and an IXSCAN in a rejected plan satisfies "uses an index" while the
 *     winning plan scans the entire collection.
 *
 * The second is the dangerous one: the gate reports success precisely when it
 * should fire. Only `winningPlan` describes what will run in production.
 */
export const winningStages = (explained: unknown): string[] => {
  if (explained === null || typeof explained !== 'object') return [];
  const root = explained as Record<string, unknown>;
  const planner = root.queryPlanner as Record<string, unknown> | undefined;
  const winning = planner?.winningPlan;
  if (winning === undefined) {
    throw new Error(
      `explain output has no queryPlanner.winningPlan; got keys: ${Object.keys(root).join(', ')}`,
    );
  }
  return stagesOf(winning);
};

/**
 * True when the plan reaches documents through an index.
 *
 * Matched as a substring, not equality: MongoDB 8 serves a single-field equality
 * on an indexed field with EXPRESS_IXSCAN, a fast path that is better than a
 * plain IXSCAN rather than worse. Asserting the exact string would fail on a
 * correctly indexed query.
 */
export const usesIndex = (stages: readonly string[]): boolean =>
  stages.some((stage) => stage.includes('IXSCAN'));

export const scansCollection = (stages: readonly string[]): boolean => stages.includes('COLLSCAN');

/** True when the server had to sort in memory instead of reading the index in order. */
export const sortsInMemory = (stages: readonly string[]): boolean => stages.includes('SORT');
