/**
 * Decoders for API-Football enrichment datasets (Mega plan, spec GW-6).
 *
 * Player season stats (GW-6a); injuries, sidelined spells, transfers and
 * trophies (GW-6b); team season stats (GW-6c); team coaches. Each decoder turns one provider envelope into GS-2 ingest
 * rows and never invents values:
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
import { SubjectType } from '@breakingthelines/protos/btl/context/v1/context_pb';
import {
  AvailabilityKind,
  AvailabilityRowSchema,
  CoachCareerRowSchema,
  CoachProfileRowSchema,
  AvailabilitySource,
  AvailabilityStatus,
  ProviderPlayerSeasonStatsRowSchema,
  ProviderTeamSeasonStatsRowSchema,
  TransferRowSchema,
  TrophyEntrySchema,
  TrophyRowSchema,
  type AvailabilityRow,
  type CoachCareerRow,
  type CoachProfileRow,
  type ProviderPlayerSeasonStatsRow,
  type ProviderTeamSeasonStatsRow,
  type TransferRow,
  type TrophyEntry,
  type TrophyRow,
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
 * exist on `PlayerSeasonStats` use its field names. The rest are
 * `extra_stats` keys, named after the `PlayerMatchStats` field where one
 * exists (`passes`, `duels`, `duels_won`, `dribbles`, `dribbles_completed`,
 * `interceptions`, `fouls_*`, `saves`, `goals_conceded`), so a provider value
 * plus BTL fold deltas (verdict D10) lines up by key. xG and xA are absent on
 * purpose: BTL computes them. Changing a key changes what game-service
 * stores, so treat the list as a contract; the README lists it for GS-2,
 * GS-3 and PF-G4a.
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
  ['passes', 'passes', 'total'],
  ['blocks', 'tackles', 'blocks'],
  ['interceptions', 'tackles', 'interceptions'],
  ['duels', 'duels', 'total'],
  ['duels_won', 'duels', 'won'],
  ['dribbles', 'dribbles', 'attempts'],
  ['dribbles_completed', 'dribbles', 'success'],
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

// ── GW-6b: availability, transfers, trophies ──────────────────────────────

/** Most ids the provider takes in one `players=` or `coachs=` parameter. */
export const PROVIDER_MULTI_ID_MAX = 20;

/** `/injuries?league=L&season=S`. One unpaginated list for the whole season. */
export const apiFootballInjuriesLeaguePath = (leagueId: number, season: number): string =>
  `/injuries?league=${encodeURIComponent(String(leagueId))}` +
  `&season=${encodeURIComponent(String(season))}`;

/** `/sidelined?players=a-b-c`, up to {@link PROVIDER_MULTI_ID_MAX} ids. */
export const apiFootballSidelinedPath = (playerIds: readonly string[]): string =>
  `/sidelined?players=${playerIds.map((id) => encodeURIComponent(id)).join('-')}`;

/** `/transfers?team=T`: every transfer of every player the provider links to the team. */
export const apiFootballTransfersPath = (teamId: string): string =>
  `/transfers?team=${encodeURIComponent(teamId)}`;

/** `/trophies?players=a-b` or `/trophies?coachs=a-b`, up to {@link PROVIDER_MULTI_ID_MAX} ids. */
export const apiFootballTrophiesPath = (
  subject: 'player' | 'coach',
  ids: readonly string[]
): string =>
  `/trophies?${subject === 'player' ? 'players' : 'coachs'}=` +
  ids.map((id) => encodeURIComponent(id)).join('-');

/** `/players/squads?team=T`: the current squad, used to scope player trophies. */
export const apiFootballSquadPath = (teamId: string): string =>
  `/players/squads?team=${encodeURIComponent(teamId)}`;

/** Provider id parser, exported for the enrichment workflow's id lists. */
export const parseProviderId = (value: unknown): string | undefined => providerId(value);

/** The provider's non-empty `errors` field, or undefined. */
export const providerErrorsOf = (envelope: unknown): string | undefined =>
  decodeProviderErrors(envelope);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** First ten characters as an ISO date when they are one, else ''. */
const isoDate = (value: unknown): string => {
  const str = text(value);
  const match = ISO_DATE.exec(str);
  if (!match) {
    return '';
  }
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(date) ? date : '';
};

const isPlaceholderName = (value: unknown): boolean =>
  text(value).toLowerCase() === PLACEHOLDER_NAME;

/** Provider injury `type` to status: "Missing Fixture" is out, "Questionable" doubtful. */
export const availabilityStatusFor = (type: unknown): AvailabilityStatus => {
  const value = text(type).toLowerCase();
  if (value === 'missing fixture') {
    return AvailabilityStatus.OUT;
  }
  if (value === 'questionable') {
    return AvailabilityStatus.DOUBTFUL;
  }
  return AvailabilityStatus.UNKNOWN;
};

const SUSPENSION_REASON = /card|suspen/i;
const INJURY_REASON =
  /injur|knock|surgery|broken|fracture|strain|sprain|tear|torn|muscle|tendon|ligament|concussion|bruise|contusion|illness|\bill\b|virus|sick|health|medical|hamstring|cruciate|meniscus/i;

/**
 * Provider reason text to kind. A card or suspension is SUSPENSION, a known
 * injury or illness word is INJURY, anything else ("Inactive", "Personal
 * Reasons", "Lacking Match Fitness") is OTHER.
 */
export const availabilityKindFor = (reason: unknown): AvailabilityKind => {
  const value = text(reason);
  if (value === '') {
    return AvailabilityKind.OTHER;
  }
  if (SUSPENSION_REASON.test(value)) {
    return AvailabilityKind.SUSPENSION;
  }
  if (INJURY_REASON.test(value)) {
    return AvailabilityKind.INJURY;
  }
  return AvailabilityKind.OTHER;
};

export interface DecodedEnrichmentResponse<TRow> {
  readonly rows: readonly TRow[];
  /** Provider `response[]` entries seen. */
  readonly entries: number;
  /** Entries or rows dropped: placeholder or missing ids, bad dates, another league. */
  readonly dropped: number;
  /** The provider's non-empty `errors` field. */
  readonly providerErrors?: string;
}

export interface InjuriesPlayerSighting {
  readonly providerPlayerId: string;
  /** Kickoff of the fixture the row is for, in ms. */
  readonly fixtureAtMs: number;
}

export interface DecodedInjuries extends DecodedEnrichmentResponse<AvailabilityRow> {
  /** One entry per row: who was listed for which kickoff (feeds the sidelined scope). */
  readonly sightings: readonly InjuriesPlayerSighting[];
}

/**
 * Decode `/injuries?league=L&season=S` into INJURIES rows, one per (player,
 * fixture). Rows for another league, or with no player or fixture id, are
 * dropped.
 */
export const decodeInjuries = (
  envelope: unknown,
  options: { readonly leagueId: number; readonly season: number; readonly fetchedAtMs: number }
): DecodedInjuries => {
  const providerErrors = decodeProviderErrors(envelope);
  if (!isRecord(envelope) || !Array.isArray(envelope.response)) {
    return { rows: [], sightings: [], entries: 0, dropped: 0, providerErrors };
  }
  const league = String(options.leagueId);
  const fetchedAt = timestampFromMs(options.fetchedAtMs);
  const rows: AvailabilityRow[] = [];
  const sightings: InjuriesPlayerSighting[] = [];
  let dropped = 0;
  for (const entry of envelope.response) {
    if (!isRecord(entry)) {
      dropped += 1;
      continue;
    }
    const player = isRecord(entry.player) ? entry.player : {};
    const team = isRecord(entry.team) ? entry.team : {};
    const fixture = isRecord(entry.fixture) ? entry.fixture : {};
    const entryLeague = isRecord(entry.league) ? providerId(entry.league.id) : undefined;
    const playerId = providerId(player.id);
    const fixtureId = providerId(fixture.id);
    const kickoffMs = fixtureKickoffMs(fixture);
    const startDate = kickoffMs === undefined ? isoDate(fixture.date) : isoDateFromMs(kickoffMs);
    if (
      playerId === undefined ||
      fixtureId === undefined ||
      isPlaceholderName(player.name) ||
      startDate === '' ||
      (entryLeague !== undefined && entryLeague !== league)
    ) {
      dropped += 1;
      continue;
    }
    rows.push(
      create(AvailabilityRowSchema, {
        source: AvailabilitySource.INJURIES,
        providerPlayerId: playerId,
        providerTeamId: providerId(team.id) ?? '',
        providerFixtureId: fixtureId,
        providerCompetitionId: league,
        seasonYear: options.season,
        playerSnapshot: create(ProviderEntitySnapshotSchema, {
          label: text(player.name),
          imageUrl: text(player.photo),
        }),
        teamSnapshot: teamSnapshot(team),
        status: availabilityStatusFor(player.type),
        kind: availabilityKindFor(player.reason),
        reason: text(player.reason),
        startDate,
        endDate: '',
        fixtureAt: kickoffMs === undefined ? undefined : timestampFromMs(kickoffMs),
        fetchedAt,
      })
    );
    if (kickoffMs !== undefined) {
      sightings.push({ providerPlayerId: playerId, fixtureAtMs: kickoffMs });
    }
  }
  return { rows, sightings, entries: envelope.response.length, dropped, providerErrors };
};

const fixtureKickoffMs = (fixture: Record<string, unknown>): number | undefined => {
  const seconds = parseProviderNumber(fixture.timestamp);
  if (seconds !== undefined && seconds > 0) {
    return seconds * 1_000;
  }
  const parsed = Date.parse(text(fixture.date));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const isoDateFromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Decode `/sidelined?players=a-b` (grouped by player id) into SIDELINED rows,
 * one per spell. A spell has no team, fixture, competition or season. Status
 * is OUT: a spell is time the player missed. Spells with no valid start date
 * are dropped. `subjectsAnswered` lists the ids the provider returned.
 */
export const decodeSidelined = (
  envelope: unknown,
  options: { readonly fetchedAtMs: number }
): DecodedEnrichmentResponse<AvailabilityRow> & { readonly subjectsAnswered: number } => {
  const providerErrors = decodeProviderErrors(envelope);
  if (!isRecord(envelope) || !Array.isArray(envelope.response)) {
    return { rows: [], entries: 0, dropped: 0, providerErrors, subjectsAnswered: 0 };
  }
  const fetchedAt = timestampFromMs(options.fetchedAtMs);
  const rows: AvailabilityRow[] = [];
  let dropped = 0;
  let subjectsAnswered = 0;
  for (const entry of envelope.response) {
    const playerId = isRecord(entry) ? providerId(entry.id) : undefined;
    if (!isRecord(entry) || playerId === undefined || !Array.isArray(entry.sidelined)) {
      dropped += 1;
      continue;
    }
    subjectsAnswered += 1;
    for (const spell of entry.sidelined) {
      const start = isRecord(spell) ? isoDate(spell.start) : '';
      if (!isRecord(spell) || start === '') {
        dropped += 1;
        continue;
      }
      const type = text(spell.type);
      rows.push(
        create(AvailabilityRowSchema, {
          source: AvailabilitySource.SIDELINED,
          providerPlayerId: playerId,
          providerTeamId: '',
          providerFixtureId: '',
          providerCompetitionId: '',
          seasonYear: 0,
          status: AvailabilityStatus.OUT,
          kind: availabilityKindFor(type),
          reason: type,
          startDate: start,
          endDate: isoDate(spell.end),
          fetchedAt,
        })
      );
    }
  }
  return { rows, entries: envelope.response.length, dropped, providerErrors, subjectsAnswered };
};

/**
 * Decode `/transfers?team=T` into one row per transfer. The response lists
 * each player's whole transfer history, not only moves involving T. `type`
 * is kept raw as `fee_text` ("€ 50M", "Loan", "Free", or '' for null). A
 * missing team id is stored as '' (the provider has some moves with no
 * club on one side). Transfers with no valid date are dropped.
 */
export const decodeTransfers = (
  envelope: unknown,
  options: { readonly fetchedAtMs: number }
): DecodedEnrichmentResponse<TransferRow> => {
  const providerErrors = decodeProviderErrors(envelope);
  if (!isRecord(envelope) || !Array.isArray(envelope.response)) {
    return { rows: [], entries: 0, dropped: 0, providerErrors };
  }
  const fetchedAt = timestampFromMs(options.fetchedAtMs);
  const rows: TransferRow[] = [];
  let dropped = 0;
  for (const entry of envelope.response) {
    const player = isRecord(entry) && isRecord(entry.player) ? entry.player : undefined;
    const playerId = player ? providerId(player.id) : undefined;
    const transfers = isRecord(entry) && Array.isArray(entry.transfers) ? entry.transfers : [];
    if (!player || playerId === undefined || isPlaceholderName(player.name)) {
      dropped += Math.max(1, transfers.length);
      continue;
    }
    const playerSnap = create(ProviderEntitySnapshotSchema, { label: text(player.name) });
    for (const move of transfers) {
      const date = isRecord(move) ? isoDate(move.date) : '';
      if (!isRecord(move) || date === '') {
        dropped += 1;
        continue;
      }
      const teams = isRecord(move.teams) ? move.teams : {};
      const teamIn = isRecord(teams.in) ? teams.in : {};
      const teamOut = isRecord(teams.out) ? teams.out : {};
      rows.push(
        create(TransferRowSchema, {
          providerPlayerId: playerId,
          playerSnapshot: playerSnap,
          transferDate: date,
          providerTeamInId: providerId(teamIn.id) ?? '',
          teamInSnapshot: teamSnapshot(teamIn),
          providerTeamOutId: providerId(teamOut.id) ?? '',
          teamOutSnapshot: teamSnapshot(teamOut),
          feeText: text(move.type),
          fetchedAt,
        })
      );
    }
  }
  return { rows, entries: envelope.response.length, dropped, providerErrors };
};

/**
 * Decode `/trophies?players=a-b` or `?coachs=a-b` (grouped by id) into one
 * row per subject holding its full list. An id the provider answered with an
 * empty list sets `clear_scope` (the provider confirmed no trophies); an id
 * it left out of the response produces no row. A null `season` is kept as
 * '' and entries with no competition name are dropped.
 */
export const decodeTrophies = (
  envelope: unknown,
  options: {
    readonly subject: 'player' | 'coach';
    readonly fetchedAtMs: number;
    /** Display names known from the squad call, by provider id. */
    readonly names?: ReadonlyMap<string, string>;
  }
): DecodedEnrichmentResponse<TrophyRow> => {
  const providerErrors = decodeProviderErrors(envelope);
  if (!isRecord(envelope) || !Array.isArray(envelope.response)) {
    return { rows: [], entries: 0, dropped: 0, providerErrors };
  }
  const fetchedAt = timestampFromMs(options.fetchedAtMs);
  const subjectType = options.subject === 'player' ? SubjectType.PLAYER : SubjectType.COACH;
  const rows: TrophyRow[] = [];
  let dropped = 0;
  for (const entry of envelope.response) {
    const id = isRecord(entry) ? providerId(entry.id) : undefined;
    if (!isRecord(entry) || id === undefined || !Array.isArray(entry.trophies)) {
      dropped += 1;
      continue;
    }
    const trophies: TrophyEntry[] = [];
    for (const trophy of entry.trophies) {
      const name = isRecord(trophy) ? text(trophy.league) : '';
      if (!isRecord(trophy) || name === '') {
        dropped += 1;
        continue;
      }
      trophies.push(
        create(TrophyEntrySchema, {
          competitionName: name,
          country: text(trophy.country),
          seasonText: text(trophy.season),
          place: text(trophy.place),
        })
      );
    }
    const label = options.names?.get(id) ?? '';
    rows.push(
      create(TrophyRowSchema, {
        subjectType,
        providerSubjectId: id,
        subjectSnapshot: label ? create(ProviderEntitySnapshotSchema, { label }) : undefined,
        trophies,
        fetchedAt,
        // Only an explicit empty list clears; a list whose every entry was
        // dropped is not the provider saying "none".
        clearScope: entry.trophies.length === 0,
      })
    );
  }
  return { rows, entries: envelope.response.length, dropped, providerErrors };
};

export interface DecodedSquad {
  /** Player ids in squad order, de-duplicated. */
  readonly playerIds: readonly string[];
  /** Display names by player id. */
  readonly names: ReadonlyMap<string, string>;
  readonly providerErrors?: string;
}

/** Decode `/players/squads?team=T` into the squad's player ids. */
export const decodeSquadPlayerIds = (envelope: unknown): DecodedSquad => {
  const providerErrors = decodeProviderErrors(envelope);
  const names = new Map<string, string>();
  const playerIds: string[] = [];
  if (!isRecord(envelope) || !Array.isArray(envelope.response)) {
    return { playerIds, names, providerErrors };
  }
  for (const squad of envelope.response) {
    const players = isRecord(squad) && Array.isArray(squad.players) ? squad.players : [];
    for (const player of players) {
      const id = isRecord(player) ? providerId(player.id) : undefined;
      if (!isRecord(player) || id === undefined || isPlaceholderName(player.name)) {
        continue;
      }
      if (!names.has(id)) {
        playerIds.push(id);
        names.set(id, text(player.name));
      }
    }
  }
  return { playerIds, names, providerErrors };
};

// ── GW-6c: team season stats ──────────────────────────────────────────────

/** `/teams/statistics?league=L&season=S&team=T`: one team's season in one competition. */
export const apiFootballTeamStatisticsPath = (
  leagueId: number,
  season: number,
  teamId: string
): string =>
  `/teams/statistics?league=${encodeURIComponent(String(leagueId))}` +
  `&season=${encodeURIComponent(String(season))}` +
  `&team=${encodeURIComponent(teamId)}`;

/**
 * Provider path to `ProviderTeamSeasonStatsRow.values` key. The first six are
 * `TeamSeasonStats` field names; `clean_sheets` and `failed_to_score` are
 * extra_stats keys today (game-service is adding `clean_sheets` as a field
 * under the same name); the penalty keys match the player season keys. All are
 * whole-season totals (home plus away). Treat the list as a contract with
 * game-service, like {@link PLAYER_SEASON_STAT_KEYS}.
 */
export const TEAM_SEASON_STAT_KEYS: ReadonlyArray<readonly [key: string, path: readonly string[]]> =
  [
    ['matches_played', ['fixtures', 'played', 'total']],
    ['wins', ['fixtures', 'wins', 'total']],
    ['draws', ['fixtures', 'draws', 'total']],
    // The provider spells this field "loses".
    ['losses', ['fixtures', 'loses', 'total']],
    ['goals_for', ['goals', 'for', 'total', 'total']],
    ['goals_against', ['goals', 'against', 'total', 'total']],
    ['clean_sheets', ['clean_sheet', 'total']],
    ['failed_to_score', ['failed_to_score', 'total']],
    ['penalties_scored', ['penalty', 'scored', 'total']],
    ['penalties_missed', ['penalty', 'missed', 'total']],
  ];

const pathValue = (root: unknown, path: readonly string[]): unknown => {
  let node = root;
  for (const part of path) {
    if (!isRecord(node)) {
      return undefined;
    }
    node = node[part];
  }
  return node;
};

export interface DecodedTeamSeasonStats {
  /** One row, or none when the response holds no statistics for the team. */
  readonly rows: readonly ProviderTeamSeasonStatsRow[];
  /** 1 when the provider answered with a statistics object, else 0. */
  readonly entries: number;
  /** 1 when the object was for another league, season or team, else 0. */
  readonly dropped: number;
  readonly providerErrors?: string;
}

/**
 * Decode `/teams/statistics?league&season&team`. Unlike the list endpoints,
 * `response` is a single object (an empty array when the provider has
 * nothing). A provider null stays out of `values`; `form` is copied as sent
 * ('' for null). An object whose league, season or team differs from the
 * request is dropped.
 */
export const decodeTeamSeasonStats = (
  envelope: unknown,
  options: {
    readonly leagueId: number;
    readonly season: number;
    readonly teamId: string;
    readonly fetchedAtMs: number;
  }
): DecodedTeamSeasonStats => {
  const providerErrors = decodeProviderErrors(envelope);
  const response = isRecord(envelope) ? envelope.response : undefined;
  if (!isRecord(response)) {
    return { rows: [], entries: 0, dropped: 0, providerErrors };
  }
  const league = isRecord(response.league) ? response.league : {};
  const team = isRecord(response.team) ? response.team : {};
  const leagueId = providerId(league.id);
  const season = parseProviderNumber(league.season);
  const teamId = providerId(team.id);
  if (
    (leagueId !== undefined && leagueId !== String(options.leagueId)) ||
    (season !== undefined && season !== options.season) ||
    (teamId !== undefined && teamId !== options.teamId)
  ) {
    return { rows: [], entries: 1, dropped: 1, providerErrors };
  }
  const values: Record<string, number> = {};
  for (const [key, path] of TEAM_SEASON_STAT_KEYS) {
    const parsed = parseProviderNumber(pathValue(response, path));
    if (parsed !== undefined) {
      values[key] = parsed;
    }
  }
  const row = create(ProviderTeamSeasonStatsRowSchema, {
    providerTeamId: options.teamId,
    providerCompetitionId: String(options.leagueId),
    seasonYear: options.season,
    teamSnapshot: teamSnapshot(team),
    values,
    form: text(response.form),
    fetchedAt: timestampFromMs(options.fetchedAtMs),
  });
  return { rows: [row], entries: 1, dropped: 0, providerErrors };
};

// ── Team coaches ──────────────────────────────────────────────────────────

/**
 * `/coachs?team=T`: every coach the provider links to the team, current and
 * former, each with a full career. The top-level `team` on each coach is the
 * queried team, not the coach's current one, so it is ignored.
 */
export const apiFootballCoachsTeamPath = (teamId: string): string =>
  `/coachs?team=${encodeURIComponent(teamId)}`;

/**
 * The spell a coach holds now: an open spell (no end date, or an end date
 * after the fetch day) with a team id, the one that started last. Provider
 * careers keep stale open spells (Amorim's Manchester United spell stayed
 * open after Carrick's began), so the latest start wins. A spell with no
 * start date only wins when no open spell has one.
 */
export const currentCoachSpell = (
  career: readonly CoachCareerRow[],
  fetchedAtMs: number
): CoachCareerRow | undefined => {
  const today = new Date(fetchedAtMs).toISOString().slice(0, 10);
  let best: CoachCareerRow | undefined;
  for (const spell of career) {
    if (spell.providerTeamId === '' || (spell.endDate !== '' && spell.endDate <= today)) {
      continue;
    }
    if (best === undefined || spell.startDate > best.startDate) {
      best = spell;
    }
  }
  return best;
};

/**
 * Decode `/coachs?team=T` into one profile row per coach with the whole
 * career, most recent first. Coaches with no id or the placeholder name are
 * dropped; so are career spells with no team id. A malformed date is kept as
 * ''. `current_provider_team_id` is {@link currentCoachSpell}'s team, or ''
 * when every spell has ended (a sacked coach with no new post).
 */
export const decodeCoachs = (
  envelope: unknown,
  options: { readonly fetchedAtMs: number }
): DecodedEnrichmentResponse<CoachProfileRow> => {
  const providerErrors = decodeProviderErrors(envelope);
  if (!isRecord(envelope) || !Array.isArray(envelope.response)) {
    return { rows: [], entries: 0, dropped: 0, providerErrors };
  }
  const fetchedAt = timestampFromMs(options.fetchedAtMs);
  const rows: CoachProfileRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of envelope.response) {
    const id = isRecord(entry) ? providerId(entry.id) : undefined;
    if (!isRecord(entry) || id === undefined || isPlaceholderName(entry.name) || seen.has(id)) {
      dropped += 1;
      continue;
    }
    seen.add(id);
    const career: CoachCareerRow[] = [];
    for (const spell of Array.isArray(entry.career) ? entry.career : []) {
      const team = isRecord(spell) && isRecord(spell.team) ? spell.team : undefined;
      const teamId = team ? providerId(team.id) : undefined;
      if (!isRecord(spell) || !team || teamId === undefined) {
        dropped += 1;
        continue;
      }
      career.push(
        create(CoachCareerRowSchema, {
          providerTeamId: teamId,
          teamSnapshot: teamSnapshot(team),
          teamName: text(team.name),
          startDate: isoDate(spell.start),
          endDate: isoDate(spell.end),
        })
      );
    }
    career.sort((a, b) => (a.startDate === b.startDate ? 0 : a.startDate > b.startDate ? -1 : 1));
    const birth = isRecord(entry.birth) ? entry.birth : {};
    const name = text(entry.name);
    rows.push(
      create(CoachProfileRowSchema, {
        providerCoachId: id,
        coachSnapshot: create(ProviderEntitySnapshotSchema, {
          label: name,
          imageUrl: text(entry.photo),
        }),
        name,
        firstname: text(entry.firstname),
        lastname: text(entry.lastname),
        birthDate: isoDate(birth.date),
        birthPlace: text(birth.place),
        birthCountry: text(birth.country),
        nationality: text(entry.nationality),
        photoUrl: text(entry.photo),
        career,
        currentProviderTeamId: currentCoachSpell(career, options.fetchedAtMs)?.providerTeamId ?? '',
        fetchedAt,
      })
    );
  }
  return { rows, entries: envelope.response.length, dropped, providerErrors };
};
