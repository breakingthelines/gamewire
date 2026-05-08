# Contributing to @breakingthelines/gamewire

Thank you for considering contributing to Gamewire. This project makes provider data usable across BTL by normalising external formats into a single schema. We welcome contributions from developers and analytics enthusiasts alike.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Contribution Paths](#contribution-paths)
- [Development Workflow](#development-workflow)
- [Adding a New Adapter](#adding-a-new-adapter)
- [Pull Request Process](#pull-request-process)
- [Style Guide](#style-guide)

## Code of Conduct

This project and everyone participating in it is governed by our commitment to creating a welcoming, inclusive environment. Please be respectful in all interactions.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- Node.js >= 18
- Git

### Setup

```bash
# Fork and clone the repository
git clone https://github.com/breakingthelines/gamewire.git
cd gamewire

# Install dependencies
bun install

# Run tests to verify setup
bun test
```

### Useful Commands

| Command                | Description              |
| ---------------------- | ------------------------ |
| `bun test`             | Run tests with vitest    |
| `bun run check`        | TypeScript type checking |
| `bun run lint`         | Lint with oxlint         |
| `bun run format`       | Format code with oxfmt   |
| `bun run format:check` | Check formatting         |
| `bun run build`        | Build with bunchee       |

## Contribution Paths

We welcome different types of contributions:

| Contributor Type          | Entry Points                                                    |
| ------------------------- | --------------------------------------------------------------- |
| **Non-developer**         | Documentation improvements, bug reports, data provider research |
| **Junior developer**      | Issues labeled `good-first-issue`, test improvements, docs      |
| **Experienced developer** | New adapters, core improvements, performance optimisations      |
| **Analytics/Data person** | Validate adapters against real data, identify edge cases        |

### Finding Issues

- Look for issues labeled [`good-first-issue`](https://github.com/breakingthelines/gamewire/labels/good-first-issue)
- Check [`help-wanted`](https://github.com/breakingthelines/gamewire/labels/help-wanted) for more complex tasks
- Browse planned adapters in the README

## Development Workflow

### 1. Create a Branch

```bash
git checkout -b feature/skillcorner-adapter
# or
git checkout -b fix/statsbomb-coordinate-edge-case
```

### 2. Make Your Changes

- Write your code
- Add/update tests
- Update documentation if needed

### 3. Test Your Changes

```bash
# Run all checks
bun run lint && bun run format:check && bun run check && bun test
```

### 4. Commit Your Changes

We use conventional commits:

```bash
git commit -m "feat(skillcorner): add initial adapter implementation"
git commit -m "fix(statsbomb): handle missing location data"
git commit -m "docs: update README with new provider"
```

**Prefixes:**

- `feat:` — New feature (new adapter, new event type support)
- `fix:` — Bug fix
- `docs:` — Documentation only
- `refactor:` — Code change that neither fixes a bug nor adds a feature
- `test:` — Adding or updating tests
- `chore:` — Maintenance tasks

## Adding a New Adapter

This is the most common contribution. Follow these steps:

### 1. Copy the Template

```bash
cp -r src/adapters/template src/adapters/your-provider
```

### 2. Research the Provider's Data Format

- Find sample data (open-data repos, documentation, API responses)
- Understand their coordinate system (pitch dimensions)
- Map their event types to BTL's taxonomy
- Note any provider-specific quirks

### 3. Define Types (`types.ts`)

```typescript
// Map the provider's raw JSON structure
export interface YourProviderEvent {
  id: string;
  eventType: number;
  // ... match their schema exactly
}

// Document their constants
export const YOUR_PROVIDER_EVENT_TYPES = {
  SHOT: 10,
  PASS: 20,
  // ...
} as const;

// Pitch dimensions for coordinate normalisation
export const YOUR_PROVIDER_PITCH = {
  LENGTH: 105,
  WIDTH: 68,
} as const;
```

### 4. Implement the Adapter (`adapter.ts`)

Key responsibilities:

1. **Normalise coordinates** to 0-100 system
2. **Map event types** to `EventType` enum
3. **Map enum values** (outcomes, body parts, etc.)
4. **Extract team/player info** from events
5. **Set data source attribution**

Use `create()` from `@bufbuild/protobuf` for all proto messages:

```typescript
import { create } from '@bufbuild/protobuf';
import { MatchEventSchema, EventType } from '@breakingthelines/protos/...';

const event = create(MatchEventSchema, {
  id: rawEvent.id,
  type: EventType.SHOT,
  // ...
});
```

### 5. Write Tests (`adapter.test.ts`)

- Use real sample data when possible (fetch from provider's open-data repo)
- Test coordinate normalisation bounds (0-100)
- Test all supported event type mappings
- Test enum value mappings
- Test edge cases (missing data, unknown values)

```typescript
describe('YourProvider adapter', () => {
  let events: YourProviderEvent[];

  beforeAll(async () => {
    // Fetch real data
    const response = await fetch('https://...');
    events = await response.json();
  });

  it('normalises coordinates to 0-100', () => {
    const result = fromYourProvider(events);
    for (const event of result.events) {
      if (event.location) {
        expect(event.location.x).toBeGreaterThanOrEqual(0);
        expect(event.location.x).toBeLessThanOrEqual(100);
      }
    }
  });
});
```

### 6. Document (`README.md`)

Include:

- Quick start example
- Coordinate system explanation
- Supported event types table
- Enum mapping tables
- Data source attribution
- Any provider-specific notes

### 7. Export

Add to `src/index.ts`:

```typescript
export { fromYourProvider, type FromYourProviderOptions } from './adapters/your-provider/index.js';
```

Add to `package.json` exports:

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

### Adapter Checklist

Before submitting:

- [ ] Types match provider's data format exactly
- [ ] Coordinates normalised to 0-100
- [ ] All supported event types mapped
- [ ] Enum values mapped correctly
- [ ] Data source attribution included
- [ ] Tests pass with real sample data
- [ ] README documents usage and mappings
- [ ] Exports added to `src/index.ts` and `package.json`
- [ ] Type check passes (`bun run check`)
- [ ] Lint passes (`bun run lint`)

## Pull Request Process

### Before Submitting

- [ ] All tests pass (`bun test`)
- [ ] Type checking passes (`bun run check`)
- [ ] Linting passes (`bun run lint`)
- [ ] Formatting is correct (`bun run format:check`)
- [ ] Documentation is updated

### PR Description Template

```markdown
## Summary

Brief description of changes.

## Type of Change

- [ ] New adapter
- [ ] Bug fix
- [ ] Documentation update
- [ ] Core improvement

## For New Adapters

- [ ] Provider: [name and link]
- [ ] Data source: [open-data repo or API docs]
- [ ] Event types supported: [list]

## Checklist

- [ ] Tests added with real sample data
- [ ] README documents all mappings
- [ ] Exports added to index and package.json
```

### Review Process

1. **Automated checks** — CI runs lint, format, type check, test, build
2. **Code review** — Maintainer reviews implementation
3. **Data validation** — Verify with real match data
4. **Merge** — Squash and merge to main

### CI/CD

All PRs automatically run:

- `bun run lint` — oxlint
- `bun run format:check` — oxfmt
- `bun run check` — TypeScript
- `bun run test` — vitest
- `bun run build` — bunchee

PRs cannot be merged until all checks pass.

### Releases (Maintainers)

Releases are triggered by pushing a version tag:

```bash
# Update version in package.json, then:
git tag v0.1.0
git push origin v0.1.0
```

This triggers the publish workflow which builds and publishes to GitHub Packages.

## Style Guide

### TypeScript

- Use explicit types (no implicit `any`)
- Prefer interfaces over type aliases for objects
- Export types alongside functions
- Use JSDoc comments for public APIs

### File Naming

- Adapters: `src/adapters/provider-name/`
- Files: `kebab-case.ts`
- Use `index.ts` for barrel exports

### Code Patterns

Follow existing adapters for consistency:

```typescript
// Coordinate normalisation
function normalizeCoordinates(location: [number, number]): PitchCoordinates {
  return create(PitchCoordinatesSchema, {
    x: (location[0] / PROVIDER_PITCH.LENGTH) * 100,
    y: (location[1] / PROVIDER_PITCH.WIDTH) * 100,
  });
}

// Enum mapping
function mapEventType(typeId: number): EventType | null {
  switch (typeId) {
    case PROVIDER_TYPES.SHOT:
      return EventType.SHOT;
    // ...
    default:
      return null; // Unsupported events filtered out
  }
}
```

## Questions?

- Open a [Discussion](https://github.com/breakingthelines/gamewire/discussions) for questions
- Check existing adapters for reference implementations

## Contributor License Agreement

By contributing to this project, you agree that your contributions will be licensed under the same license as this project (AGPL-3.0).

---

Thank you for contributing!
