import type { Database } from 'better-sqlite3';

// Reach index.electron.ts through the './index.api' re-export, which is
// `export * from './index.electron'`. Not '#platform/server/sqlite': tsgo has no
// `customConditions` for this package, so it resolves that subpath's `default`
// export to the sql.js backend and types this test against the wrong
// implementation. './index.electron' would typecheck but trips the
// no-restricted-imports '**/*.electron' pattern. Mirrors
// ../connection/index.api.test.ts.
// oxlint-disable-next-line no-restricted-imports
import { execQuery, openDatabase, runQuery } from './index.api';

const initSQL = `
CREATE TABLE textstrings (id TEXT PRIMARY KEY, string TEXT);
`;

// Patterns used by no other case in this file, so the log count below starts
// from zero regardless of which tests ran before this one.
const PATTERN_ONE = '(?<electron-lifetime-one';
const PATTERN_TWO = '(?<electron-lifetime-two';

describe('Native sqlite REGEXP guard', () => {
  // Teardown lives here rather than at the tail of a test body: an assertion
  // failing above it would skip the cleanup and leave a mocked console.log and
  // an open handle behind for the next test. Mirrors
  // ../connection/index.api.test.ts:6-8.
  const handles: Database[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const handle of handles.splice(0)) {
      handle.close();
    }
  });

  // The failure below is deliberate — this test is meant to fail, so that the
  // afterEach above is the only thing standing between it and the next test.
  // Its aftermath is observed by the test below, which asserts it starts from
  // an unmocked console.log; this one cannot observe its own teardown, because
  // it passes whether or not the afterEach exists.
  it.fails('leaves nothing behind when an assertion fails mid-test', () => {
    vi.spyOn(console, 'log').mockImplementation(() => null);
    const db = openDatabase(':memory:');
    handles.push(db);
    execQuery(db, initSQL);

    expect('never called').toBe('called');
  });

  it('reports an unparseable pattern once per database handle, not once per process', () => {
    // Only meaningful above this test's own spy: below it, this would observe
    // the mock installed two statements down and pass unconditionally.
    expect(vi.isMockFunction(console.log)).toBe(false);

    // SQLite calls the REGEXP function once per candidate row, so a single-row
    // table cannot tell per-pattern logging apart from per-row logging. Several
    // rows, therefore.
    const seed = (db: Database) => {
      execQuery(db, initSQL);
      for (const id of ['1', '2', '3']) {
        runQuery(
          db,
          `INSERT INTO textstrings (id, string) VALUES ('id${id}', '#mortgage note')`,
        );
      }
    };

    const db1 = openDatabase(':memory:');
    handles.push(db1);
    seed(db1);
    const db2 = openDatabase(':memory:');
    handles.push(db2);
    seed(db2);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => null);
    const invalidRegexLogs = () =>
      consoleSpy.mock.calls.filter(
        call => call[0] === 'invalid regexp in sqlite REGEXP',
      ).length;

    // This backend's runQuery takes [] for params — passing null throws
    // 'params is not iterable'.
    const query = (db: Database, pattern: string) =>
      runQuery(
        db,
        `SELECT id FROM textstrings where REGEXP('${pattern}', string)`,
        [],
        true,
      );

    expect(query(db1, PATTERN_ONE)).toEqual([]);
    expect(invalidRegexLogs()).toBe(1);

    // The dedupe set is created by createRegexp(), which openDatabase() calls
    // per handle — so the same pattern over a second handle in the same
    // process is reported again. Hoisting that set to module scope silences
    // the second handle and leaves the count at 1.
    expect(query(db2, PATTERN_ONE)).toEqual([]);
    expect(invalidRegexLogs()).toBe(2);

    // Each handle keeps deduping on its own afterwards.
    expect(query(db1, PATTERN_ONE)).toEqual([]);
    expect(invalidRegexLogs()).toBe(2);

    // Deduplicated per pattern, not globally: a second broken pattern over the
    // same handle is still reported.
    expect(query(db2, PATTERN_TWO)).toEqual([]);
    expect(invalidRegexLogs()).toBe(3);

    // And a valid pattern still matches every row, silently.
    expect(query(db1, '#mortgage')).toHaveLength(3);
    expect(invalidRegexLogs()).toBe(3);
  });
});
