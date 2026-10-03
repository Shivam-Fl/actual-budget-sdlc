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

  // Named rather than inline so the last test in this describe can call it
  // directly. A teardown proved only by a later test noticing its aftermath is
  // a claim about whichever test happens to run next, not about this function.
  function teardown() {
    vi.restoreAllMocks();
    for (const handle of handles.splice(0)) {
      handle.close();
    }
  }

  afterEach(teardown);

  // The failure below is deliberate — this test is meant to fail, so that the
  // afterEach above is the only thing standing between it and the next test.
  // Its aftermath is observed by the test below, which asserts it starts from
  // an unmocked console.log; this one cannot observe its own teardown, because
  // it passes whether or not the afterEach exists.
  //
  // it.fails passes on ANY failure in the body, so this guard only establishes
  // the scenario — cleanup has to survive an assertion failing partway through
  // a test — and verifies nothing about whether teardown happened. It is kept
  // because it is the only exercise of that scenario. The last test in this
  // describe is what actually proves the teardown — see there for why.
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
    // It is also vacuous whenever the guard above did not run — under `-t`
    // filtering or reordering nothing has mocked console.log yet, so this is
    // true for the wrong reason. The last test covers what this cannot.
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

  // Last on purpose. This drives teardown() itself instead of reading another
  // test's aftermath, so it proves both halves of the teardown no matter which
  // tests ran before it — and, unlike the assertion above, it stays falsifiable
  // when it is the only test selected.
  //
  // Its position is load-bearing. It has to follow the guard and the test that
  // observes it: teardown() here would otherwise clean up the guard's leaked
  // mock and handle before that observer looks, and deleting the
  // afterEach(teardown) registration would then leave the suite green.
  it('closes every handle it collected and restores the console', () => {
    vi.spyOn(console, 'log').mockImplementation(() => null);
    const db = openDatabase(':memory:');
    handles.push(db);
    // Two handles, so the teardown's loop has to run more than once: with one
    // handle, `expect(handles).toHaveLength(0)` above is satisfied by the
    // splice whether or not close() was called on anything.
    const db2 = openDatabase(':memory:');
    handles.push(db2);

    teardown();

    // Nothing left for the next test to trip over.
    expect(handles).toHaveLength(0);
    expect(vi.isMockFunction(console.log)).toBe(false);
    // better-sqlite3 exposes its own closed state, so these are the handles'
    // reports rather than an inference from the array being empty.
    expect(db.open).toBe(false);
    expect(db2.open).toBe(false);
  });
});
