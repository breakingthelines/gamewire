/**
 * Regression guard for the bug the unified competition catalogue exists to
 * make impossible: a competition with steady-state sweep coverage
 * (`daily-anchor`/`hourly-matchday`/`squad-sweep`/`identity-gap-scan`) but no
 * live ingestion coverage (the always-on pre-kickoff-lineups/live-events
 * loop). Before the collapse, `PHASE_A_COMPETITIONS` (24 leagues) and
 * `API_FOOTBALL_BETA_COMPETITIONS` (15 leagues) were separate hand-maintained
 * lists and silently drifted apart — 9 leagues ended up in that exact gap.
 *
 * This test fails the moment any catalogue entry has
 * `steadyStateSweep: true` and `liveIngestion: false` UNLESS its key is
 * named, with a comment explaining why, in `NO_LIVE_INGESTION_ALLOWLIST`.
 * That allow-list must stay empty today; adding an entry to it is a
 * deliberate, reviewable decision, not something that can happen by leaving
 * a field off a new catalogue row.
 */
import { describe, expect, it } from 'vitest';

import { COMPETITIONS, NO_LIVE_INGESTION_ALLOWLIST } from '../competitions.js';

describe('live ingestion coverage trip-wire', () => {
  it('has no undeclared steady-state-only competitions', () => {
    const undeclaredGaps = COMPETITIONS.filter(
      (competition) =>
        competition.steadyStateSweep &&
        !competition.liveIngestion &&
        !NO_LIVE_INGESTION_ALLOWLIST.has(competition.key)
    ).map((competition) => competition.key);

    expect(undeclaredGaps).toEqual([]);
  });

  it('keeps the allow-list empty', () => {
    // If this ever legitimately needs an entry, add the key to
    // NO_LIVE_INGESTION_ALLOWLIST in competitions.ts WITH A COMMENT
    // explaining why, and update this expectation deliberately. It must
    // never grow silently.
    expect(NO_LIVE_INGESTION_ALLOWLIST.size).toBe(0);
  });

  it('every allow-listed key (if any) actually exists in the catalogue', () => {
    const catalogueKeys = new Set(COMPETITIONS.map((competition) => competition.key));
    for (const key of NO_LIVE_INGESTION_ALLOWLIST) {
      expect(catalogueKeys.has(key)).toBe(true);
    }
  });
});
