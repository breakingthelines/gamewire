/**
 * Decoders for API-Football enrichment datasets (Mega plan, spec GW-6).
 *
 * Only the player season stats dataset is built so far (GW-6a). Each decoder
 * turns one provider envelope into GS-2 ingest rows and never invents values:
 *
 * - A provider `null` is left out of `values`. A missing key means "the
 *   provider said nothing"; `0` means the provider said 0 (profile-spec §1.5).
 * - Numeric strings are parsed: `"6.65"` is 6.65 and `"33.33%"` is 33.33.
 * - Rows with a null or 0 player id, a null or 0 team id, or the provider's
 *   `"Data not available"` placeholder name are dropped.
 */
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';

import {
  ProviderEntitySnapshotSchema,
  type ProviderEntitySnapshot,
} from '@breakingthelines/protos/btl/game/v1/types/game_pb';
import {
  ProviderPlayerSeasonStatsRowSchema,
  type ProviderPlayerSeasonStatsRow,
} from '@breakingthelines/protos/btl/game/v1/types/provider_data_pb';

/** `/players?league=L&season=S&page=P`. Pages are 1-based. */
export const apiFootballPlayerSeasonStatsPath = (
  leagueId: number,
  season: number,
  page: number
): string =>
  `/players?league=${encodeURIComponent(String(leagueId))}` +
  `&season=${encodeURIComponent(String(season))}` +
  `&page=${encodeURIComponent(String(page))}`;

/** Placeholder name the provider uses for rows it has no player for. */
const PLACEHOLDER_NAME = 'data not available';

/**
 * Provider stat path to `ProviderPlayerSeasonStatsRow.values` key. Keys that
 * exist on `PlayerSeasonStats` use its field names; the rest are
 * `extra_stats` keys. xG and xA are absent on purpose: BTL computes them.
 * Changing a key changes what game-service stores, so treat the list as a
 * contract.
 */
export const PLAYER_SEASON_STAT_KEYS: ReadonlyArray<
  readonly [key: string, group: string, field: string]
> = [
  ['appearances', 'games', 'appearences'],
  ['starts', 'games', 'lineups'],
  ['minutes', 'games', 'minutes'],
  ['avg_rating', 'games', 'rating'],
  ['goals', 'goals', 'total'],
  ['assists', 'goals', 'assists'],
  ['shots', 'shots', 'total'],
  ['shots_on_target', 'shots', 'on'],
  ['key_passes', 'passes', 'key'],
  // Kept raw under its own key, not as `avg_pass_completion_pct`: the season
  // value is sometimes a percentage and sometimes a per-game count of accurate
  // passes (Eredivisie 2024: 47 for a centre-back with 55 passes a game).
  ['passes_accuracy', 'passes', 'accuracy'],
  ['tackles', 'tackles', 'total'],
  ['yellow_cards', 'cards', 'yellow'],
  ['red_cards', 'cards', 'red'],
  ['yellow_red_cards', 'cards', 'yellowred'],
  ['substitute_in', 'substitutes', 'in'],
  ['substitute_out', 'substitutes', 'out'],
  ['substitute_bench', 'substitutes', 'bench'],
  ['goals_conceded', 'goals', 'conceded'],
  ['saves', 'goals', 'saves'],
  ['passes_total', 'passes', 'total'],
  ['blocks', 'tackles', 'blocks'],
  ['interceptions', 'tackles', 'interceptions'],
  ['duels_total', 'duels', 'total'],
  ['duels_won', 'duels', 'won'],
  ['dribbles_attempts', 'dribbles', 'attempts'],
  ['dribbles_success', 'dribbles', 'success'],
  ['dribbled_past', 'dribbles', 'past'],
  ['fouls_drawn', 'fouls', 'drawn'],
  ['fouls_committed', 'fouls', 'committed'],
  ['penalties_won', 'penalty', 'won'],
  // The provider spells this field "commited".
  ['penalties_committed', 'penalty', 'commited'],
  ['penalties_scored', 'penalty', 'scored'],
  ['penalties_missed', 'penalty', 'missed'],
  ['penalties_saved', 'penalty', 'saved'],
];

/**
 * Parse a provider number. Accepts finite numbers and numeric strings, with an
 * optional trailing `%`. Returns undefined for null, empty, or anything else,
 * so the caller leaves the key out rather than writing 0.
 */
export const parseProviderNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().replace(/%$/, '').trim();
  if (trimmed === '' || !/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Provider id as a string, or undefined for null, 0, negative, or non-numeric ids. */
const providerId = (value: unknown): string | undefined => {
  const parsed = parseProviderNumber(value);
  if (parsed === undefined || parsed <= 0 || !Number.isInteger(parsed)) {
    return undefined;
  }
  return String(parsed);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
};

export interface PlayerSeasonStatsPaging {
  /** The page the provider says it returned. */
  readonly current: number;
  /** Total pages for this league and season. 0 when the envelope has none. */
  readonly total: number;
}

export interface DecodedPlayerSeasonStatsPage {
  readonly rows: readonly ProviderPlayerSeasonStatsRow[];
  readonly paging: PlayerSeasonStatsPaging;
  /** Provider `response[]` entries seen on the page. */
  readonly entries: number;
  /** Statistics blocks dropped: placeholder or missing ids, or another league. */
  readonly dropped: number;
  /**
   * The provider's `errors` field when it is non-empty (it answers some
   * failures with HTTP 200, an empty list and an error map).
   */
  readonly providerErrors?: string;
}

export interface DecodePlayerSeasonStatsOptions {
  /** League the page was requested for. Blocks for any other league are dropped. */
  readonly leagueId: number;
  /** Season the page was requested for. */
  readonly season: number;
  /** Snapshot time written to every row. */
  readonly fetchedAtMs: number;
}

/**
 * Decode one `/players?league&season&page` envelope into season rows, one per
 * (player, team) statistics block for the requested league. A player who
 * moved between two clubs in the same league gets two rows.
 */
export const decodePlayerSeasonStatsPage = (
  envelope: unknown,
  options: DecodePlayerSeasonStatsOptions
): DecodedPlayerSeasonStatsPage => {
  const paging = decodePaging(envelope);
  const providerErrors = decodeProviderErrors(envelope);
  if (!isRecord(envelope) || !Array.isArray(envelope.response)) {
    return { rows: [], paging, entries: 0, dropped: 0, providerErrors };
  }
  const rows: ProviderPlayerSeasonStatsRow[] = [];
  let dropped = 0;
  const fetchedAt = timestampFromMs(options.fetchedAtMs);
  const league = String(options.leagueId);

  for (const entry of envelope.response) {
    if (!isRecord(entry) || !isRecord(entry.player)) {
      dropped += 1;
      continue;
    }
    const player = entry.player;
    const playerId = providerId(player.id);
    const name = text(player.name);
    if (playerId === undefined || name.toLowerCase() === PLACEHOLDER_NAME) {
      dropped += Array.isArray(entry.statistics) ? Math.max(1, entry.statistics.length) : 1;
      continue;
    }
    const statistics = Array.isArray(entry.statistics) ? entry.statistics : [];
    for (const block of statistics) {
      if (!isRecord(block)) {
        dropped += 1;
        continue;
      }
      const team = isRecord(block.team) ? block.team : {};
      const teamId = providerId(team.id);
      const blockLeague = isRecord(block.league) ? providerId(block.league.id) : undefined;
      if (teamId === undefined || (blockLeague !== undefined && blockLeague !== league)) {
        dropped += 1;
        continue;
      }
      rows.push(
        create(ProviderPlayerSeasonStatsRowSchema, {
          providerPlayerId: playerId,
          providerTeamId: teamId,
          providerCompetitionId: league,
          seasonYear: options.season,
          playerSnapshot: playerSnapshot(player, block),
          teamSnapshot: teamSnapshot(team),
          values: playerSeasonValues(block),
          fetchedAt,
        })
      );
    }
  }
  return { rows, paging, entries: envelope.response.length, dropped, providerErrors };
};

/**
 * Read the stat values from one statistics block. Only non-null values are
 * returned, so a provider null never becomes 0.
 */
export const playerSeasonValues = (block: Record<string, unknown>): Record<string, number> => {
  const values: Record<string, number> = {};
  for (const [key, group, field] of PLAYER_SEASON_STAT_KEYS) {
    const section = block[group];
    if (!isRecord(section)) {
      continue;
    }
    const parsed = parseProviderNumber(section[field]);
    if (parsed !== undefined) {
      values[key] = parsed;
    }
  }
  return values;
};

const playerSnapshot = (
  player: Record<string, unknown>,
  block: Record<string, unknown>
): ProviderEntitySnapshot => {
  const attributes: Record<string, string> = {};
  const birth = isRecord(player.birth) ? player.birth : {};
  const games = isRecord(block.games) ? block.games : {};
  const put = (key: string, value: unknown) => {
    const str = text(value);
    if (str !== '') {
      attributes[key] = str;
    }
  };
  put('firstname', player.firstname);
  put('lastname', player.lastname);
  put('birth_date', birth.date);
  put('birth_place', birth.place);
  put('birth_country', birth.country);
  put('height', player.height);
  put('weight', player.weight);
  put('position', games.position);
  put('shirt_number', games.number);
  if (typeof games.captain === 'boolean') {
    attributes.captain = String(games.captain);
  }
  return create(ProviderEntitySnapshotSchema, {
    label: text(player.name),
    imageUrl: text(player.photo),
    country: text(player.nationality),
    attributes,
  });
};

const teamSnapshot = (team: Record<string, unknown>): ProviderEntitySnapshot =>
  create(ProviderEntitySnapshotSchema, {
    label: text(team.name),
    imageUrl: text(team.logo),
  });

const decodePaging = (envelope: unknown): PlayerSeasonStatsPaging => {
  if (!isRecord(envelope) || !isRecord(envelope.paging)) {
    return { current: 0, total: 0 };
  }
  const current = parseProviderNumber(envelope.paging.current) ?? 0;
  const total = parseProviderNumber(envelope.paging.total) ?? 0;
  return {
    current: Number.isInteger(current) && current > 0 ? current : 0,
    total: Number.isInteger(total) && total > 0 ? total : 0,
  };
};

const decodeProviderErrors = (envelope: unknown): string | undefined => {
  if (!isRecord(envelope)) {
    return undefined;
  }
  const errors = envelope.errors;
  if (Array.isArray(errors)) {
    return errors.length > 0 ? JSON.stringify(errors).slice(0, 300) : undefined;
  }
  if (isRecord(errors)) {
    return Object.keys(errors).length > 0 ? JSON.stringify(errors).slice(0, 300) : undefined;
  }
  return undefined;
};
