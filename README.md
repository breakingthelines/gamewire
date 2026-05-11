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
resolution must use a published `@breakingthelines/identity-data-football`
version, or the deployed `identity-server`, once `identity` `0.1.0` is actually
released.

Call budget modelling is available from the worker export:

```typescript
import { estimateMatchdayCallBudget } from '@breakingthelines/gamewire/worker';

const budget = estimateMatchdayCallBudget('api-football');
console.log(budget.warnings);
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
