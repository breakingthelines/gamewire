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

| Provider                                                        | Import                                                  | Docs                                              | Status  |
| --------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- | ------- |
| [StatsBomb Open](https://github.com/statsbomb/open-data)        | `@breakingthelines/gamewire/adapters/statsbomb-open` | [README](./src/adapters/statsbomb-open/README.md) | Stable  |
| [SkillCorner](https://github.com/SkillCorner/opendata)          | -                                                       | -                                                 | Planned |
| [Metrica Sports](https://github.com/metrica-sports/sample-data) | -                                                       | -                                                 | Planned |
| [Opta Analyst](https://theanalyst.com)                          | -                                                       | -                                                 | Planned |

Want to add support for another provider? See [Creating a New Adapter](#creating-a-new-adapter).

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
