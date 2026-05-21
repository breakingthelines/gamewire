# API-Football Adapter

Transforms API-Football provider data into BTL GameService ingest request
shapes and owns provider-specific request paths, replay fixtures, and launch
coverage configuration.

Default beta coverage is the top five European leagues plus FIFA World Cup:
Premier League (`39`), La Liga (`140`), Serie A (`135`), Bundesliga (`78`),
Ligue 1 (`61`), and World Cup (`1`).

The worker imports this adapter for replay-safe payloads and request planning;
live HTTP, caching, quota, backoff, and secret handling remain worker
responsibilities.

Live fixture transforms treat API-Football ids as provider refs. They only
populate BTL team, player, competition, or season ids when the worker supplies
identity resolutions; misses stay unresolved instead of becoming synthetic
`btl_football_*_api_football_*` ids. Event payloads normalize to
`GameOccurrence` timeline rows, while empty lineup responses intentionally
produce no `IngestFootballLineups` rows.
