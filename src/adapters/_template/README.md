# Creating a New Adapter

This template provides a starting point for adding support for a new data provider.

## Getting Started

1. **Copy this folder** to `src/adapters/your-provider/`
2. **Rename files and exports** from `template` to your provider name
3. **Define types** in `types.ts` matching your provider's data format
4. **Implement transformations** in `adapter.ts`
5. **Write tests** in `adapter.test.ts`
6. **Export from main index** in `src/index.ts`

## Step-by-Step Guide

### 1. Define Raw Types (`types.ts`)

Study your provider's data format (JSON schema, API docs, sample files) and create TypeScript interfaces:

```typescript
// Your provider's event structure
export interface YourProviderEvent {
  id: string;
  eventType: number;
  minute: number;
  second: number;
  playerId: number;
  playerName: string;
  teamId: number;
  x: number;
  y: number;
  // ... provider-specific fields
}

// Event type constants
export const YOUR_PROVIDER_EVENT_TYPES = {
  SHOT: 10,
  PASS: 20,
  // ... map to your provider's IDs
} as const;

// Pitch dimensions for coordinate transformation
export const YOUR_PROVIDER_PITCH = {
  LENGTH: 105,  // metres or units
  WIDTH: 68,
} as const;
```

### 2. Implement Coordinate Transformation

BTL uses a normalised 0-100 coordinate system:

- **X**: 0 = own goal line, 100 = opposition goal line
- **Y**: 0 = left touchline, 100 = right touchline

```typescript
function normalizeCoordinates(x: number, y: number): PitchCoordinates {
  return create(PitchCoordinatesSchema, {
    x: (x / YOUR_PROVIDER_PITCH.LENGTH) * 100,
    y: (y / YOUR_PROVIDER_PITCH.WIDTH) * 100,
  });
}
```

### 3. Map Action Types

Create a function to map your provider's event types to BTL's
`FootballActionType` enum:

```typescript
function getActionType(event: YourProviderEvent): FootballActionType | null {
  switch (event.eventType) {
    case YOUR_PROVIDER_EVENT_TYPES.SHOT:
      return FootballActionType.SHOT;
    case YOUR_PROVIDER_EVENT_TYPES.PASS:
      return FootballActionType.PASS;
    // ... more mappings
    default:
      return null; // Unsupported events are filtered out
  }
}
```

### 4. Map Enum Values

Map your provider's enums to BTL enums:

```typescript
function mapShotOutcome(outcomeCode: string): ShotOutcome {
  switch (outcomeCode) {
    case 'GOAL':
      return ShotOutcome.GOAL;
    case 'SAVE':
      return ShotOutcome.SAVED;
    case 'MISS':
    case 'OFF_TARGET':
      return ShotOutcome.MISSED;
    case 'BLOCK':
      return ShotOutcome.BLOCKED;
    case 'POST':
    case 'BAR':
      return ShotOutcome.POST;
    default:
      return ShotOutcome.UNSPECIFIED;
  }
}
```

### 5. Transform Events

Use `create()` from `@bufbuild/protobuf` to construct Game-first proto
messages:

```typescript
function transformEvent(event: YourProviderEvent, gameId: string): GameOccurrence | null {
  const actionType = getActionType(event);
  if (!actionType) return null;

  const action = create(FootballActionPayloadSchema, {
    type: actionType,
    teamId: String(event.teamId),
    playerId: String(event.playerId),
    location: normalizeCoordinates(event.x, event.y),
  });

  // Add type-specific data
  if (actionType === FootballActionType.SHOT) {
    action.actionData = {
      case: 'shot',
      value: create(ShotEventDataSchema, {
        xg: event.expectedGoals,
        outcome: mapShotOutcome(event.shotOutcome),
        bodyPart: mapBodyPart(event.bodyPart),
      }),
    };
  }

  return create(GameOccurrenceSchema, {
    id: String(event.id),
    gameId,
    kind: GameOccurrenceKind.ACTION,
    payload: {
      case: 'action',
      value: create(SportActionPayloadSchema, {
        action: { case: 'football', value: action },
      }),
    },
  });
}
```

### 6. Add Data Source Attribution

Include proper attribution on each `GameOccurrence`:

```typescript
source: create(ProviderAttributionSchema, {
  provider: 'your-provider',
  name: 'Your Provider Name',
  logo: 'https://your-provider.com/logo.svg',
  url: 'https://your-provider.com',
}),
```

### 7. Write Tests

Use real sample data when possible:

```typescript
describe('YourProvider adapter', () => {
  let events: YourProviderEvent[];

  beforeAll(() => {
    // Load real fixture data
    const content = readFileSync('./fixtures/sample-match.json', 'utf-8');
    events = JSON.parse(content);
  });

  it('transforms events correctly', () => {
    const result = fromYourProvider(events, { gameId: 'btl_football_game_example' });
    expect(result.occurrences.length).toBeGreaterThan(0);
  });

  it('normalises coordinates to 0-100', () => {
    const result = fromYourProvider(events, { gameId: 'btl_football_game_example' });
    for (const occurrence of result.occurrences) {
      if (occurrence.payload.case === 'action') {
        const action = occurrence.payload.value.action;
        if (action.case === 'football' && action.value.location) {
          expect(action.value.location.x).toBeGreaterThanOrEqual(0);
          expect(action.value.location.x).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});
```

### 8. Export Your Adapter

Add exports to `src/index.ts`:

```typescript
export { fromYourProvider, type FromYourProviderOptions } from './adapters/your-provider/index.js';
```

And add package exports to `package.json`:

```json
{
  "exports": {
    "./adapters/your-provider": {
      "types": "./dist/adapters/your-provider/index.d.ts",
      "import": "./dist/adapters/your-provider/index.js"
    }
  }
}
```

## BTL Event Types

Currently supported event types:

| Type | Proto enum | Event data schema |
| --- | --- | --- |
| Shot | `FootballActionType.SHOT` | `ShotEventDataSchema` |
| Pass | `FootballActionType.PASS` | `PassEventDataSchema` |
| Carry | `FootballActionType.CARRY` | `CarryEventDataSchema` |
| Tackle | `FootballActionType.TACKLE` | `TackleEventDataSchema` |
| Interception | `FootballActionType.INTERCEPTION` | `InterceptionEventDataSchema` |

## Checklist

Before submitting your adapter:

- [ ] Types match provider's data format
- [ ] Coordinates normalised to 0-100
- [ ] All supported event types mapped
- [ ] Enum values mapped correctly
- [ ] Data source attribution included
- [ ] Tests pass with real sample data
- [ ] README documents usage and mappings
- [ ] Exports added to `src/index.ts` and `package.json`
- [ ] Type check passes (`bun run check`)
- [ ] Lint passes (`bun run lint`)

## Need Help?

Look at the StatsBomb Open adapter (`src/adapters/statsbomb-open/`) for a complete example.
