import { readFileSync } from 'node:fs';
import path from 'node:path';

// Reads a sibling source file and flattens it enough that a claim about a
// comment cannot be satisfied or dodged purely by where the line breaks and
// `//` markers fall.
//
// The base path is a parameter rather than this module's own location because
// the callers assert on files that sit beside *their* test files, not beside
// this one.
export function readNormalizedSource(basePath: string, file: string): string {
  return readFileSync(path.resolve(basePath, file), 'utf8')
    .replaceAll(/^\s*\/\//gm, ' ')
    .replaceAll(/\s+/g, ' ');
}
