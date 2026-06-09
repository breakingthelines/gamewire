// Provide default btl-auth-context env vars so module-level `loadConfig()`
// calls in worker source files don't throw at import time during the test
// run. Tests that intentionally exercise the misconfigured path pass an
// explicit env map to `loadConfig({})` and aren't affected by these.
process.env.GAMEWIRE_AUTH_CONTEXT_JWKS_URL ??= 'https://auth.test/.well-known/jwks.json';
process.env.GAMEWIRE_AUTH_CONTEXT_ISSUER ??= 'auth-service-test';
process.env.GAMEWIRE_AUTH_CONTEXT_AUDIENCE ??= 'gamewire-worker';
process.env.GAMEWIRE_AUTH_CONTEXT_REQUIRED_SCOPE ??= 'gamewire.workflow.invoke';

// The sweep-missing-payloads workflow sleeps between provider fetches in prod
// (200ms by default — keeps a 500-fixture run under api-football's per-minute
// cap). Tests that fan out a few-hundred mocked fetches would otherwise stall
// for tens of seconds; override to 0 so the unit suite stays sub-second.
// The dedicated throttle test sets a non-zero value via the workflow's
// `intercallDelayMs` input override.
process.env.SWEEP_INTER_CALL_DELAY_MS ??= '0';
