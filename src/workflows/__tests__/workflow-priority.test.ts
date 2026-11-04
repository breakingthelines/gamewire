import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WORKFLOW_PROVIDER_PRIORITY } from '../types.js';

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every provider call a `/workflows/*` entry point makes must run as
 * background (verdict D5). Backfills reuse live workload names, so the class
 * can never be inferred from the workload; each call site passes it. The type
 * makes `priority` required; this test pins the value.
 */
describe('workflow provider priority', () => {
  it('is background', () => {
    expect(WORKFLOW_PROVIDER_PRIORITY).toBe('background');
  });

  it('every fetchWorkload call in src/workflows passes WORKFLOW_PROVIDER_PRIORITY', () => {
    const files = readdirSync(workflowsDir).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')
    );
    let calls = 0;
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(workflowsDir, file), 'utf8');
      const pattern = /\.fetchWorkload\(\{([\s\S]*?)\}\)/g;
      for (const match of source.matchAll(pattern)) {
        calls += 1;
        if (!/priority:\s*WORKFLOW_PROVIDER_PRIORITY\b/.test(match[1] ?? '')) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${file}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // 7 season-backfill + 7 daily-anchor + 5 webhook-completed + 2
    // hourly-matchday + 1 squad-sweep + 1 sweep-missing-payloads.
    expect(calls).toBeGreaterThanOrEqual(23);
  });
});
