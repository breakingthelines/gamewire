# StatsBomb Open Data Adapter

Transforms [StatsBomb Open Data](https://github.com/statsbomb/open-data) events into BTL's normalised proto schema.

## Quick Start

```typescript
import { fromStatsBombOpen } from '@breakingthelines/gamewire/adapters/statsbomb-open';

// 1. Fetch events from StatsBomb Open Data repo
const response = await fetch(
  'https://raw.githubusercontent.com/statsbomb/open-data/master/data/events/3869685.json'
);
const events = await response.json();

// 2. Transform to BTL proto format
const matchData = fromStatsBombOpen(events);

// 3. Use the normalised data
console.log(matchData.homeTeam?.name); // "Argentina"
console.log(matchData.awayTeam?.name); // "France"
console.log(matchData.events.length);  // Number of transformed events
```

## API

### `fromStatsBombOpen(events, options?)`

Transforms an array of StatsBomb events into a `NormalizedMatchData` proto message.

**Parameters:**

| Name      | Type                       | Description                        |
| --------- | -------------------------- | ---------------------------------- |
| `events`  | `StatsBombEvent[]`         | Raw events from StatsBomb JSON     |
| `options` | `FromStatsBombOpenOptions` | Optional configuration (see below) |

**Returns:** `NormalizedMatchData` - A proto message ready for use in BTL visualisations.

### Options

```typescript
interface FromStatsBombOpenOptions {
  /** Match metadata (from matches.json) */
  match?: StatsBombMatch;
  /** Override home team info */
  homeTeam?: { shortName?: string; primaryColor?: string; secondaryColor?: string };
  /** Override away team info */
  awayTeam?: { shortName?: string; primaryColor?: string; secondaryColor?: string };
  /** Additional metadata to include */
  meta?: Record<string, string>;
}
```

## Usage Examples

### Basic Usage

```typescript
import { fromStatsBombOpen } from '@breakingthelines/gamewire/adapters/statsbomb-open';

const matchData = fromStatsBombOpen(events);
```

### With Team Customisation

```typescript
const matchData = fromStatsBombOpen(events, {
  homeTeam: { shortName: 'ARG', primaryColor: '#75AADB', secondaryColor: '#FFFFFF' },
  awayTeam: { shortName: 'FRA', primaryColor: '#002654', secondaryColor: '#ED2939' },
});
```

### With Custom Metadata

```typescript
const matchData = fromStatsBombOpen(events, {
  meta: {
    competition: 'FIFA World Cup',
    season: '2022',
    round: 'Final',
  },
});
```

### Using Type Guards

```typescript
import { fromStatsBombOpen } from '@breakingthelines/gamewire/adapters/statsbomb-open';
import { isShot, isPass, EventType } from '@breakingthelines/gamewire/core';

const matchData = fromStatsBombOpen(events);

// Filter specific event types
const shots = matchData.events.filter(isShot);
const passes = matchData.events.filter(isPass);

// Access typed event data
for (const shot of shots) {
  console.log(`xG: ${shot.eventData.value.xg}`);
  console.log(`Outcome: ${shot.eventData.value.outcome}`);
}

// Use enum values
const passEvents = matchData.events.filter((e) => e.type === EventType.PASS);
```

### With Match Metadata

```typescript
// If you have the match info from matches.json
const matchInfo = {
  match_id: 3869685,
  home_team: { home_team_id: 771, home_team_name: 'Argentina' },
  away_team: { away_team_id: 773, away_team_name: 'France' },
  // ... other fields
};

const matchData = fromStatsBombOpen(events, { match: matchInfo });
```

## Working with the Output

The adapter returns a `NormalizedMatchData` proto message with this structure:

```typescript
interface NormalizedMatchData {
  matchId: string;
  homeTeam?: Team;
  awayTeam?: Team;
  events: MatchEvent[];
  source?: DataSource;
  meta: Record<string, string>;
}

interface MatchEvent {
  id: string;
  type: EventType;
  timestamp: number;          // Minutes as decimal (e.g., 45.5)
  player?: Player;
  team?: Team;
  location?: PitchCoordinates; // Normalised 0-100
  eventData: { case: string; value: EventData }; // Discriminated union
  meta: Record<string, string>;
}
```

## Coordinate System

StatsBomb uses a **120x80** coordinate system. This adapter normalises to **0-100** for both axes:

| Axis | StatsBomb | BTL   | Description                |
| ---- | --------- | ----- | -------------------------- |
| X    | 0-120     | 0-100 | Own goal → Opposition goal |
| Y    | 0-80      | 0-100 | Left touchline → Right     |

```
StatsBomb (120x80)              BTL (0-100)
┌────────────────────┐          ┌────────────────────┐
│         80         │          │        100         │
│                    │          │                    │
│ 0              120 │    →     │ 0               100│
│                    │          │                    │
│          0         │          │         0          │
└────────────────────┘          └────────────────────┘
```

## Supported Event Types

| StatsBomb Type    | BTL Type       | Notes                               |
| ----------------- | -------------- | ----------------------------------- |
| Shot (16)         | `SHOT`         | Includes xG, outcome, body part     |
| Pass (30)         | `PASS`         | Includes height, recipient, outcome |
| Carry (43)        | `CARRY`        | Ball progression events             |
| Duel (4)          | `TACKLE`       | Only tackle duels (type.id=11)      |
| Interception (10) | `INTERCEPTION` | Won/lost outcome                    |

Other StatsBomb event types (clearances, fouls, etc.) are filtered out.

## Data Source Attribution

All transformed data includes StatsBomb attribution in the `source` field:

```typescript
{
  source: {
    provider: 'statsbomb-open',
    name: 'StatsBomb Open Data',
    logo: 'https://static.hudl.com/craft/productAssets/statsbomb_icon.svg',
    url: 'https://github.com/statsbomb/open-data',
  }
}
```

## Enum Mappings

### Shot Outcomes

| StatsBomb                      | BTL Enum              |
| ------------------------------ | --------------------- |
| Goal (97)                      | `ShotOutcome.GOAL`    |
| Saved (100, 115, 116)          | `ShotOutcome.SAVED`   |
| Off Target (98), Wayward (101) | `ShotOutcome.MISSED`  |
| Blocked (96)                   | `ShotOutcome.BLOCKED` |
| Post (99)                      | `ShotOutcome.POST`    |

### Pass Heights

| StatsBomb       | BTL Enum            |
| --------------- | ------------------- |
| Ground Pass (1) | `PassHeight.GROUND` |
| Low Pass (2)    | `PassHeight.LOW`    |
| High Pass (3)   | `PassHeight.HIGH`   |

### Body Parts

| StatsBomb       | BTL Enum              |
| --------------- | --------------------- |
| Right Foot (40) | `BodyPart.RIGHT_FOOT` |
| Left Foot (38)  | `BodyPart.LEFT_FOOT`  |
| Head (37)       | `BodyPart.HEAD`       |
| Other           | `BodyPart.OTHER`      |

## License

StatsBomb Open Data is provided under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
