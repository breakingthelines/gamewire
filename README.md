# @breakingthelines/gamewire

Provider adapter library and ingestion runtime for BTL game data.

## Why This Exists

Different data providers use different coordinate systems, event taxonomies, and data structures. This library normalises everything to a single schema, making it easy to build visualisations and analysis tools that work with any source.

Each adapter:

- **Normalises coordinates** to a 0-100 system (X: own goal → opposition goal, Y: left → right touchline)
- **Maps event types** to a standard taxonomy (shots, passes, carries, tackles, interceptions)
- **Preserves attribution** so you always know where data originated
- **Outputs proto messages** that are type-safe and consistent across all providers

## Installation

```bash
bun add @breakingthelines/gamewire
```

## Quick Start

```typescript
import { fromStatsBombOpen } from '@breakingthelines/gamewire/adapters/statsbomb-open';

// Fetch the 2022 World Cup Final from StatsBomb's open-data repo
const response = await fetch(
  'https://raw.githubusercontent.com/statsbomb/open-data/master/data/events/3869685.json'
);
const events = await response.json();

// Transform to normalised format
const matchData = fromStatsBombOpen(events, {
  homeTeam: { shortName: 'ARG', primaryColor: '#75AADB' },
  awayTeam: { shortName: 'FRA', primaryColor: '#002654' },
});

// Now you have clean, typed data ready for visualisation
console.log(matchData.homeTeam?.name);  // "Argentina"
console.log(matchData.awayTeam?.name);  // "France"
console.log(matchData.events.length);   // ~3000 events
```

## Supported Providers

| Provider                                                        | Import                                               | Docs                                              | Status  |
| --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ------- |
| [StatsBomb Open](https://github.com/statsbomb/open-data)        | `@breakingthelines/gamewire/adapters/statsbomb-open` | [README](./src/adapters/statsbomb-open/README.md) | Stable  |
| [SkillCorner](https://github.com/SkillCorner/opendata)          | -                                                    | -                                                 | Planned |
| [Metrica Sports](https://github.com/metrica-sports/sample-data) | -                                                    | -                                                 | Planned |
| [Opta Analyst](https://theanalyst.com)                          | -                                                    | -                                                 | Planned |

Want to add support for another provider? See [Creating a New Adapter](#creating-a-new-adapter).

## Worker Import Harness

The `./worker` export is the provider-facing runtime boundary for BTL game
ingestion. It defaults to `GAMEWIRE_PROVIDER_ID=api-football`,
`GAMEWIRE_PROVIDER_BASE_URL=https://v3.football.api-sports.io`, and
`GAMEWIRE_PROVIDER_MODE=replay`, which means local and CI runs produce typed
payloads without using provider credentials or making live HTTP calls.

Current replay coverage:

- `FetchFixtures` produces a non-empty `IngestGamesRequest`.
- `FetchGame` produces a replayable single-game `IngestGamesRequest`.
- `FetchLineup` produces a non-empty `IngestFootballLineupsRequest`.
- `FetchStandings` produces a non-empty `IngestFootballStandingsRequest`.
- `FetchOccurrences` produces a non-empty `IngestGameOccurrencesRequest`.
- `PollLiveGame` exercises the latest-updated/live polling path without network
  I/O.

The default API-Football beta coverage plan is the top five European leagues
plus the FIFA World Cup: Premier League (`39`), La Liga (`140`), Serie A
(`135`), Bundesliga (`78`), Ligue 1 (`61`), and World Cup (`1`). Fixture and
standing request plans expand to one league/season path per competition; live
polling uses the global `/fixtures?live=all` feed instead of per-match polling.
Provider-specific API-Football types, replay transforms, and request paths live
in `src/adapters/api-football/`; the worker imports that adapter and only owns
runtime orchestration, caching, quota, backoff, and secret handling.

Every replay activity also emits a runtime report containing request shape,
cache key, TTL, quota bucket/cost, redacted secret headers, and backoff policy.
For API-Football, the live implementation must send the key as
`x-apisports-key`; the runtime report redacts that header name explicitly. This
is the call-efficiency contract for the later live provider implementation.

`gamewire` does not depend on local `identity` artifacts. Runtime provider-key
resolution uses the deployed `identity-server`: API-Football team, player,
competition, and season provider ids resolve to canonical BTL ids when the
snapshot has a match, and stay as explicit provider refs when it does not.
Provider fixture ids resolve to canonical game ids through game-service because
game-service owns the live provider fixture crosswalk.

For live API-Football fixture detail payloads, gamewire leaves game ids
uncanonicalized and carries `provider_game_id` plus structured provider refs;
game-service derives the service-owned `btl_football_game_g<hash>` id and route.
The ingestion loop also fetches `/fixtures/events` for timeline occurrences and
`/fixtures/lineups` for team sheets. Empty lineup responses are skipped so
lineups remain honestly missing.

Every provider call carries a priority class (`live`, `near-live`,
`background`). A per-minute limiter admits it against that class's ceiling
(`GAMEWIRE_PROVIDER_MINUTE_CAP_{LIVE,NEARLIVE,BACKGROUND}`, default 800 / 650 /
450 on one shared bucket), then the daily tracker applies the hard cap, the soft
cap and the background daily cap (`GAMEWIRE_PROVIDER_BACKGROUND_DAILY_CAP`).
With `GAMEWIRE_PROVIDER_QUOTA_SOURCE=provider-header` the daily count is
max(local, provider-reported), read from the `x-ratelimit-requests-*` headers.
Workflows always call as `background`. Code defaults are the Mega plan values
(hard 140,000, soft 130,000, plan ceiling 150,000, background min(110,000, soft
cap)); deployments set the caps in env. Each provider request has a deadline
(`GAMEWIRE_PROVIDER_REQUEST_TIMEOUT_MS`, default 10,000) and a timed-out request
counts as `failed`.

The per-minute buckets live in each worker process. Prod and staging share one
API-Football key, so each gets its own full set of minute ceilings; staging needs
its own lower minute caps before the live tick gets faster.

Provider enrichment runs through `POST /workflows/provider-enrichment`. A
dataset runs only when `GAMEWIRE_ENRICHMENT_DATASETS` names it; the default is
empty, so nothing runs. Calls are `background`, held to
`GAMEWIRE_ENRICHMENT_MINUTE_CAP` (default 120, never above the background
ceiling) and to a per-run `limit` (default per dataset, at most 4,000). Provider
responses are not cached: each one goes straight to its game-service ingest RPC.
A provider null is left out of the row's `values`; it is never written as 0.

| dataset               | provider call                                                     | scope when the request names none                                         | default limit | ingest RPC                        |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------- | --------------------------------- |
| `player-season-stats` | `/players?league&season&page`                                     | catalogue domestic leagues at their catalogue season                      | 1,500         | `IngestProviderPlayerSeasonStats` |
| `injuries-league`     | `/injuries?league&season`                                         | catalogue leagues with injuries coverage (`INJURIES_COVERED_LEAGUE_IDS`)  | 60            | `IngestAvailability` (INJURIES)   |
| `player-sidelined`    | `/sidelined?players=a-b`, 20 a call                               | players `injuries-league` listed for a fixture in the last 30 days        | 300           | `IngestAvailability` (SIDELINED)  |
| `team-transfers`      | `/transfers?team=T`                                               | teams in the fixture lists of the catalogue domestic leagues              | 500           | `IngestTransfers`                 |
| `trophies`            | `/players/squads?team=T`, then `/trophies?players=a-b`, 20 a call | teams whose id mod 4 is the week counter mod 4 (or `partition` 0 to 3)    | 600           | `IngestTrophies`                  |
| `team-season-stats`   | `/teams/statistics?league&season&team`                            | domestic teams with a final whistle in 36h; every domestic team on Monday | 500           | `IngestProviderTeamSeasonStats`   |
| `team-coaches`        | `/coachs?team=T`                                                  | teams in the fixture lists of the catalogue domestic leagues, every night | 500           | `IngestCoachProfiles`             |

The GW-6b datasets keep only a small marker per finished unit (a league-season,
a team, or a batch of ids) so a stopped run resumes, and `injuries-league` keeps
a digest of player ids and kickoffs (the sidelined scope). An injuries pull
sends every batch with the same `replace_scope` and `sync_id` and sets
`final_batch` on the last one only, so game-service removes absences the
provider no longer lists. An empty list, a reply with provider errors, or a
failed batch removes nothing. Trophies and sidelined spells use the provider's
multi-id form (`players=a-b-c`, up to 20 ids), which costs one call. Coach
trophies run only for `coachIds` named in the request.

- Sidelined markers are per player, so a stopped run resumes however the next
  run's scope is batched.
- The team scope reads each league's fixture list from the key the live loop's
  discovery caches (6h). A missing list is fetched once through the same cached
  path and counts against the run's limit. A league still without teams is
  reported as a `failed` target and the run ends `incomplete`.
- Trophy rows are packed so a request holds at most 500 trophies (the
  game-service limit). A subject with more than 500 loses exact repeats, then
  places other than Winner, and the count shows in `rowsDropped`.
- The trophies week counter steps every Monday 00:00 UTC and runs on across
  year ends, so the partition never repeats in consecutive weeks.
- `injuries-league` accepts only catalogue leagues in `leagueIds`; a league
  outside it is reported as `failed` unless the request sets
  `allowUncatalogued: true`.
- `team-season-stats` takes each team's league from the catalogue fixture list
  it appears in, at the catalogue season. A nightly run reads final whistles
  from the cached lists (finished, or kicked off over two hours ago and not
  postponed, cancelled, abandoned or suspended), so scoping costs no call.
  `nightly` on a Monday (UTC) and `full` cover every domestic team. `teamIds`
  and `leagueIds` narrow the scope; `seasons` is refused. Values are keyed by
  `TeamSeasonStats` names (`matches_played`, `wins`, `draws`, `losses`,
  `goals_for`, `goals_against`) plus `clean_sheets`, `failed_to_score`,
  `penalties_scored` and `penalties_missed`; `form` is copied as sent. A
  completed team keeps a 20h marker.
- `team-coaches` writes every coach the provider links to the team, former and
  current, with the whole career. The coach's current team is the spell that
  started last, when it is still open (provider careers keep stale open
  spells, so an older open spell never counts); a coach whose latest spell
  has ended has none. Dates are month-granular. game-service serves the
  team's manager from these rows (`coach_profiles`), team by team: the spell
  at the team that started last wins, and when it has ended the post is
  vacant. A vacancy still writes every coach, so the fresh `fetched_at` tells
  game-service the team was fetched. An empty answer writes nothing and keeps
  the stored profiles. A completed team keeps a 20h marker, so the nightly run
  refetches every team: about 414 calls a day.

```jsonc
// history backfill: leagues and seasons are explicit, nothing is gated on a season's end
{"dataset": "player-season-stats", "mode": "full", "leagueIds": [39, 88], "seasons": [2025, 2024, 2023], "limit": 1500}
// nightly current-season refresh: catalogue domestic leagues at their catalogue season
{"dataset": "player-season-stats", "mode": "nightly"}
// GW-6b: the K-2 schedule bodies, and explicit scopes
{"dataset": "injuries-league"}
{"dataset": "player-sidelined"}
{"dataset": "team-transfers"}
{"dataset": "trophies", "partition": "auto"}
{"dataset": "injuries-league", "mode": "full", "leagueIds": [88], "seasons": [2025]}
{"dataset": "trophies", "playerIds": [276, 874], "coachIds": [1]}
{"dataset": "team-transfers", "teamIds": [194]}
// GW-6c: the K-2 body (Monday covers every team), and a full run
{"dataset": "team-season-stats"}
{"dataset": "team-season-stats", "mode": "full", "leagueIds": [39]}
// team coaches: the nightly body, and one team
{"dataset": "team-coaches"}
{"dataset": "team-coaches", "teamIds": [33]}
```

`mode` is `nightly` (the default) or `full`. The spec's `auto` and `dirty`, which
the K-2 schedule sends, are accepted as `nightly`. `full` never uses a default
scope: `player-season-stats` and `injuries-league` need `leagueIds` and
`seasons` (walked latest first), `team-season-stats` needs nothing (every
domestic team), the others need `playerIds`, `coachIds` or `teamIds`. Only one run in a process works on a unit at a time; a second run
reports it as `in-progress` and fetches nothing for it.

Provider fixture results run through `POST /workflows/provider-fixture-results`
and feed game-service `IngestProviderFixtureResults` on the profile jobs Service
(`GAME_SERVICE_JOBS_URL`) for club Elo and pi-ratings. `mode` is required:
`history` walks `/fixtures?league&season` for the 20 reference leagues plus
UEFA 2, 3 and 848 across 2023 to 2026 (92 calls); `nightly` fetches a three-day
`from`/`to` window for reference leagues outside the catalogue (about 11 calls).
League ids outside that allowlist are dropped, so national teams and friendlies
are never written. Seasons must be 2010 to the current year + 1. A run spends
at most 200 calls, at `background` priority, and pages are not cached. A target
whose rows game-service skips is `failed`. `GAMEWIRE_PROVIDER_FIXTURE_RESULTS=off`
turns the endpoint off (503); it is on by default.

```jsonc
{"mode": "history"}
{"mode": "history", "leagueIds": [88], "seasons": [2024, 2025]}
{"mode": "nightly"}
```

Row `values` keys for `player-season-stats` (`PLAYER_SEASON_STAT_KEYS` in
`src/adapters/api-football/enrichment-decoders.ts`). Keys on `PlayerSeasonStats`
use its field names; the rest are `extra_stats` keys named after the
`PlayerMatchStats` field where one exists, so provider values and BTL fold deltas
line up by key. xG and xA are never sent.

| key                | provider field                                            |     | key                   | provider field          |
| ------------------ | --------------------------------------------------------- | --- | --------------------- | ----------------------- |
| `appearances`      | `games.appearences`                                       |     | `passes`              | `passes.total`          |
| `starts`           | `games.lineups`                                           |     | `blocks`              | `tackles.blocks`        |
| `minutes`          | `games.minutes`                                           |     | `interceptions`       | `tackles.interceptions` |
| `avg_rating`       | `games.rating`                                            |     | `duels`               | `duels.total`           |
| `goals`            | `goals.total`                                             |     | `duels_won`           | `duels.won`             |
| `assists`          | `goals.assists`                                           |     | `dribbles`            | `dribbles.attempts`     |
| `shots`            | `shots.total`                                             |     | `dribbles_completed`  | `dribbles.success`      |
| `shots_on_target`  | `shots.on`                                                |     | `dribbled_past`       | `dribbles.past`         |
| `key_passes`       | `passes.key`                                              |     | `fouls_drawn`         | `fouls.drawn`           |
| `passes_accuracy`  | `passes.accuracy` (raw: a percentage or a per-game count) |     | `fouls_committed`     | `fouls.committed`       |
| `tackles`          | `tackles.total`                                           |     | `penalties_won`       | `penalty.won`           |
| `yellow_cards`     | `cards.yellow`                                            |     | `penalties_committed` | `penalty.commited`      |
| `red_cards`        | `cards.red`                                               |     | `penalties_scored`    | `penalty.scored`        |
| `yellow_red_cards` | `cards.yellowred`                                         |     | `penalties_missed`    | `penalty.missed`        |
| `substitute_in`    | `substitutes.in`                                          |     | `penalties_saved`     | `penalty.saved`         |
| `substitute_out`   | `substitutes.out`                                         |     | `goals_conceded`      | `goals.conceded`        |
| `substitute_bench` | `substitutes.bench`                                       |     | `saves`               | `goals.saves`           |

Match stats (`/fixtures/statistics` and `/fixtures/players`):

- Team statistics are requested with `half=true`, which adds `statistics_1h`
  and `statistics_2h` to the same response at no extra call. The cache key is
  the workload and fixture id, so the path change shares the existing key.
- "Shots insidebox", "Shots outsidebox" and "goals_prevented" are typed
  (`shots_inside_box`, `shots_outside_box`, `goals_prevented`). When "Passes %"
  is missing, `pass_completion_pct` is 100 x "Passes accurate" / "Total passes".
- Other team metrics go to `extra_stats` under `teamStatKey(type)`: the type
  slugged, with `%` spelled `pct` ("Free Kicks" is `free-kicks`). Half splits
  use the same key for every type, typed or not, prefixed `first-half:` or
  `second-half:` (`first-half:shots-on-goal`, `second-half:ball-possession`).
  A response without the half arrays adds no half keys.
- A player's `passes.accuracy` is the count of accurate passes. It is stored
  as `passes_completed`, and `pass_completion_pct` is derived from it and
  `passes.total`. `dribbles.past` is `dribbled_past` and `games.captain` is
  `is_captain`, each with provenance only when the provider sent a value.

The call budget model works from the real per-fixture mechanism:

```typescript
import { estimateCallBudget, MEGA_LOAD_ASSUMPTIONS } from '@breakingthelines/gamewire/worker';

const budget = estimateCallBudget('api-football', MEGA_LOAD_ASSUMPTIONS);
console.log(budget.totals, budget.warnings);
```

API-Football is the only active Phase A provider harness. Hudl/StatsBomb Live
belongs in a later rich event adapter, while the existing StatsBomb Open adapter
remains the open-data replay path for rich action shape validation.

## Working with the Output

### Type Guards

Filter events by type with full TypeScript inference:

```typescript
import { isShot, isPass, isCarry } from '@breakingthelines/gamewire/core';

const shots = matchData.events.filter(isShot);

for (const shot of shots) {
  // TypeScript knows this is a shot event
  console.log(`xG: ${shot.eventData.value.xg}`);
  console.log(`Outcome: ${shot.eventData.value.outcome}`);
  console.log(`Body part: ${shot.eventData.value.bodyPart}`);
}
```

### Enum Values

Use enums for filtering and comparisons:

```typescript
import { EventType, ShotOutcome } from '@breakingthelines/gamewire/core';

// Filter by event type
const passes = matchData.events.filter(e => e.type === EventType.PASS);

// Check outcomes
const goals = shots.filter(s => s.eventData.value.outcome === ShotOutcome.GOAL);
```

### Human-Readable Names

Convert enum values to display strings:

```typescript
import { eventTypeName, shotOutcomeName } from '@breakingthelines/gamewire/core';

console.log(eventTypeName[EventType.SHOT]);           // "shot"
console.log(shotOutcomeName[ShotOutcome.GOAL]);       // "goal"
```

## The Normalised Schema

All adapters output `NormalizedMatchData` proto messages:

```typescript
interface NormalizedMatchData {
  matchId: string;
  homeTeam?: Team;
  awayTeam?: Team;
  events: MatchEvent[];
  source?: DataSource;        // Attribution to original provider
  meta: Record<string, string>;
}

interface MatchEvent {
  id: string;
  type: EventType;            // SHOT, PASS, CARRY, TACKLE, INTERCEPTION
  timestamp: number;          // Match minute as decimal (45.5 = 45:30)
  player?: Player;
  team?: Team;
  location?: PitchCoordinates; // Normalised 0-100
  eventData: {                // Discriminated union
    case: 'shot' | 'pass' | 'carry' | 'tackle' | 'interception';
    value: ShotEventData | PassEventData | ...;
  };
  meta: Record<string, string>;
}
```

### Coordinate System

All coordinates are normalised to 0-100:

| Axis | Range   | Meaning                              |
| ---- | ------- | ------------------------------------ |
| X    | 0 → 100 | Own goal line → Opposition goal line |
| Y    | 0 → 100 | Left touchline → Right touchline     |

This means (50, 50) is always center pitch, regardless of the original provider's system.

## Creating a New Adapter

We welcome contributions for new data providers. The process:

1. **Copy the template**: `cp -r src/adapters/template src/adapters/your-provider`
2. **Define types**: Map the provider's raw JSON structure in `types.ts`
3. **Implement transforms**: Convert coordinates, map event types and enums in `adapter.ts`
4. **Write tests**: Use real sample data to verify correctness
5. **Document**: Update the README with usage examples and enum mappings

See the [Template Adapter Guide](src/adapters/_template/README.md) for detailed instructions.

The [StatsBomb Open adapter](./src/adapters/statsbomb-open/) is a complete reference implementation.

## Core Module Exports

Everything you need from `@breakingthelines/gamewire/core`:

```typescript
import {
  // Type guards
  isShot, isPass, isTackle, isCarry, isInterception,

  // Enum name helpers
  eventTypeName, shotOutcomeName, passHeightName,
  passOutcomeName, tackleOutcomeName, bodyPartName,

  // Proto types
  type NormalizedMatchData, type MatchEvent,
  type Team, type Player, type PitchCoordinates,
  type ShotEventData, type PassEventData,

  // Proto enums
  EventType, ShotOutcome, PassHeight, PassOutcome,
  TackleOutcome, InterceptionOutcome, BodyPart, DuelType,

  // Proto schemas (for create())
  NormalizedMatchDataSchema, MatchEventSchema, TeamSchema,

  // Protobuf helper
  create,
} from '@breakingthelines/gamewire/core';
```

## Development

```bash
bun install          # Install dependencies
bun test             # Run tests
bun run check        # TypeScript type check
bun run lint         # Lint with oxlint
bun run format       # Format with oxfmt
bun run build        # Build with bunchee
```

## License

AGPL-3.0
