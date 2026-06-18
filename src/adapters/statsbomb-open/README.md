# StatsBomb Open Data Adapter

Transforms [StatsBomb Open Data](https://github.com/statsbomb/open-data) events
into BTL's Game-first football action contract:
`IngestGameOccurrencesRequest` containing `GameOccurrence` records with
`FootballActionPayload` payloads.

StatsBomb Open Data is a reference adapter. Production matchday coverage flows
through the provider tier list owned by `game-service`.

## Quick Start

```typescript
import { fromStatsBombOpen } from '@breakingthelines/gamewire/adapters/statsbomb-open';

const response = await fetch(
  'https://raw.githubusercontent.com/statsbomb/open-data/master/data/events/3869685.json'
);
const events = await response.json();

const ingest = fromStatsBombOpen(events, {
  gameId: 'btl_football_game_argentina_france_2022',
});

console.log(ingest.occurrences.length);
console.log(ingest.metadata?.provider); // "statsbomb-open"
```

## API

### `fromStatsBombOpen(events, options)`

Transforms raw StatsBomb events into a `btl.game.v1.IngestGameOccurrencesRequest`.

| Name      | Type                       | Description                    |
| --------- | -------------------------- | ------------------------------ |
| `events`  | `StatsBombEvent[]`         | Raw events from StatsBomb JSON |
| `options` | `FromStatsBombOpenOptions` | Game ID and replay metadata    |

```typescript
interface FromStatsBombOpenOptions {
  /** Canonical BTL game ID minted by game-service. */
  gameId: string;
  /** Provider replay identifier used for idempotency and backfills. */
  replayId?: string;
  /** Optional pointer to the raw payload in object storage. */
  rawPayloadRef?: string;
  /** Optional batch ID when a caller coordinates multiple normalizers. */
  normalizedBatchId?: string;
  /** Optional idempotency key for the ingest request. */
  idempotencyKey?: string;
}
```

### `gameFromStatsBombOpen(match, options)`

StatsBomb is a STANDALONE data source: it mints its own canonical game rather
than depending on another provider (e.g. api-football) having ingested the
match first. `gameFromStatsBombOpen` converts a single match-envelope entry
(one element of `matches/<competition>/<season>.json`) into a
`btl.game.v1.IngestGamesRequest`. `GameService.IngestGames` is find-or-mint: a
Game whose participants resolve to existing BTL teams attaches to the existing
canonical game, otherwise a new one is minted.

| Name      | Type                          | Description                          |
| --------- | ----------------------------- | ------------------------------------ |
| `match`   | `StatsBombMatch`              | One match object from `matches/…json` |
| `options` | `GameFromStatsBombOpenOptions`| Replay id + raw payload pointer       |

The minted `Game` carries:

- `provider_game_id = String(match_id)` (the crosswalk key
  `LookupGameByFixture('statsbomb-open', match_id)` reads back),
- two participants (HOME, AWAY), each an UNRESOLVED provider `resolution_ref`
  (the StatsBomb team id under the `statsbomb-open` provider) with `subject`
  left unset for game-service to resolve to a BTL team + crest via the identity
  crosswalk,
- `competition` / `season` as provider-scoped fallback `SubjectRef`s,
- `scheduled_start` from `match_date` + `kick_off` (UTC),
- `status` + `score` from the final scoreline when present, else `SCHEDULED`.

The `statsbomb-backfill` workflow uses this to mint each WC2022 game, then reads
back the canonical id and ingests occurrences (above) under it.

## Output Shape

The adapter returns the same proto request that `gamewire-worker` hands to
`GameService.IngestGameOccurrences`:

```typescript
interface IngestGameOccurrencesRequest {
  metadata?: IngestMetadata;
  gameId: string;
  occurrences: GameOccurrence[];
}
```

Each occurrence has `kind = ACTION` and a football payload:

```typescript
occurrence.payload = {
  case: 'action',
  value: {
    action: {
      case: 'football',
      value: FootballActionPayload,
    },
  },
};
```

## Coordinate System

StatsBomb uses a 120x80 coordinate system. BTL `PitchCoordinates` are normalized
to 0-100 for both axes:

| Axis | StatsBomb | BTL   | Description                           |
| ---- | --------- | ----- | ------------------------------------- |
| X    | 0-120     | 0-100 | Own goal line to opposition goal line |
| Y    | 0-80      | 0-100 | Left touchline to right touchline     |

## Supported Actions

| StatsBomb type    | BTL action type                   | Notes                               |
| ----------------- | --------------------------------- | ----------------------------------- |
| Shot (16)         | `FootballActionType.SHOT`         | Includes xG, outcome, body part     |
| Pass (30)         | `FootballActionType.PASS`         | Includes height, recipient, outcome |
| Carry (43)        | `FootballActionType.CARRY`        | Ball progression events             |
| Duel (4)          | `FootballActionType.TACKLE`       | Only tackle duels (`type.id = 11`)  |
| Interception (10) | `FootballActionType.INTERCEPTION` | Won/lost outcome                    |

Other StatsBomb event types are filtered out until mapped into
`FootballActionPayload`.

## Attribution

Every occurrence carries `ProviderAttribution` for `statsbomb-open`, including
the public dataset URL and license text.

## License

StatsBomb Open Data is provided under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
