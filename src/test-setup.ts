// Provide default btl-auth-context env vars so module-level `loadConfig()`
// calls in worker source files don't throw at import time during the test
// run. Tests that intentionally exercise the misconfigured path pass an
// explicit env map to `loadConfig({})` and aren't affected by these.
process.env.GAMEWIRE_AUTH_CONTEXT_JWKS_URL ??= 'https://auth.test/.well-known/jwks.json';
process.env.GAMEWIRE_AUTH_CONTEXT_ISSUER ??= 'auth-service-test';
process.env.GAMEWIRE_AUTH_CONTEXT_AUDIENCE ??= 'gamewire-worker';
process.env.GAMEWIRE_AUTH_CONTEXT_REQUIRED_SCOPE ??= 'gamewire.workflow.invoke';
