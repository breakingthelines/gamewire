import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Every stream write goes through the protos SDK (`publishFact` in
// `@breakingthelines/protos/sdk/eventbus`), which resolves the shared events
// database. A Redis stream command spelled out in gamewire's own source would
// bypass that, so none may appear as a string literal outside tests. This is
// the TypeScript half of the events-bus rule the Go services enforce with
// forbidigo.
const STREAM_COMMANDS = /\b(XADD|XREADGROUP|XREAD|XGROUP|XAUTOCLAIM|XCLAIM|XACK)\b/i;

const srcRoot = fileURLToPath(new URL('../', import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'fixtures' || entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });

/** String and template literal texts in a file that name a stream command. */
const streamCommandLiterals = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
      STREAM_COMMANDS.test(node.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${file}:${line + 1}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('events bus: no direct stream commands in src', () => {
  it('finds a stream command literal when one is present', () => {
    // Proves the scan below would fire.
    const sample =
      "await client.send('XADD', ['btl:facts:x', '*']);\n// XADD in a comment is fine\n";
    expect(streamCommandLiterals('sample.ts', sample)).toEqual(['sample.ts:1: XADD']);
    expect(streamCommandLiterals('t.ts', 'const c = `xreadgroup ${g}`;')).toHaveLength(1);
  });

  it('has none outside tests', () => {
    const files = sourceFiles(srcRoot);
    expect(files.length).toBeGreaterThan(20);
    const hits = files.flatMap((file) =>
      streamCommandLiterals(relative(srcRoot, file), readFileSync(file, 'utf8'))
    );
    expect(hits).toEqual([]);
  });
});
