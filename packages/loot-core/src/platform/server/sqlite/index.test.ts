// @ts-strict-ignore
import type { Database } from '@jlongster/sql.js';

import { patchFetchForSqlJS } from '#mocks/util';

import {
  closeDatabase,
  execQuery,
  init,
  openDatabase,
  runQuery,
  transaction,
} from './index';

const baseURL = `${__dirname}/../../../../../../node_modules/@jlongster/sql.js/dist/`;

beforeAll(async () => {
  patchFetchForSqlJS(baseURL);

  return init({ baseURL });
});

// The afterEach below calls vi.restoreAllMocks(), which is file-scoped rather
// than spy-scoped, so it takes down the global.fetch spy this file's beforeAll
// installed, along with any console spies a test has installed. Nothing breaks
// today, because init() has already run and sql.js caches the compiled wasm —
// but before the beforeEach below re-armed the fetch patch, from the second
// test on, global.fetch was the real jsdom fetch again. patchFetchForSqlJS is
// a vi.spyOn(...).mockImplementation(...) with no restore of its own, so
// calling it once per test is idempotent and the blanket restore can no longer
// outrun it.
beforeEach(() => {
  patchFetchForSqlJS(baseURL);
});

const initSQL = `
CREATE TABLE numbers (id TEXT PRIMARY KEY, number INTEGER);
CREATE TABLE textstrings (id TEXT PRIMARY KEY, string TEXT);
`;

describe('Web sqlite', () => {
  // Teardown lives here rather than at the tail of a test body: an assertion
  // failing above it would skip the cleanup. What survives that is narrower
  // than it looks, so each half is scoped to what it actually covers.
  //
  // vi.restoreAllMocks() restores every spy in the file. Five of the ten tests
  // mock console.log — the three transaction tests, the once-per-pattern test
  // and the once-per-handle test — and each of those restores its own spy at
  // the tail of its body anyway; this is the backstop for an assertion that
  // fails before it gets there. The other five mock no console.log, so for them
  // there is nothing to restore.
  //
  // The loop closes the handles that were pushed into it, and exactly one test
  // pushes any: 'should report an unparseable pattern once per database handle,
  // not once per process'. Eight of the other nine call openDatabase() without
  // registering the handle, so those are untouched either way; the fetch-patch
  // test at the end opens no database at all.
  //
  // Mirrors ./index.electron.test.ts on both halves — restore mocks, then
  // close handles — where each of that file's three tests registers both.
  const handles: Database[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const handle of handles.splice(0)) {
      closeDatabase(handle);
    }
  });

  it('should rollback transactions', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 4)");

    let rows = runQuery(db, 'SELECT * FROM numbers', null, true);
    expect(rows.length).toBe(1);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[0].number).toBe(4);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => null);
    expect(() => {
      transaction(db, () => {
        runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id2', 5)");
        runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id3', 6)");
        // Insert an invalid one that will error
        runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 1)");
      });
    }).toThrow(/constraint failed/);
    consoleSpy.mockRestore();

    // Nothing should have changed in the db
    rows = runQuery(db, 'SELECT * FROM numbers', null, true);
    expect(rows.length).toBe(1);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[0].number).toBe(4);
  });

  it('should support nested transactions', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 4)");

    let rows = runQuery(db, 'SELECT * FROM numbers', null, true);
    expect(rows.length).toBe(1);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[0].number).toBe(4);

    transaction(db, () => {
      runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id2', 5)");
      runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id3', 6)");

      // Only this transaction should fail
      const consoleSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => null);
      expect(() => {
        transaction(db, () => {
          runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id4', 7)");
          // Insert an invalid one that will error
          runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 1)");
        });
      }).toThrow(/constraint failed/);
      consoleSpy.mockRestore();
    });

    // Nothing should have changed in the db
    rows = runQuery(db, 'SELECT * FROM numbers', null, true);
    expect(rows.length).toBe(3);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[0].number).toBe(4);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[1].number).toBe(5);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[2].number).toBe(6);
  });

  it('should support immediate transactions with rollback and nesting', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    transaction(
      db,
      () => {
        runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 1)");
        // Nested transactions become savepoints regardless of the mode
        transaction(
          db,
          () => {
            runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id2', 2)");
          },
          { immediate: true },
        );
      },
      { immediate: true },
    );
    expect(runQuery(db, 'SELECT * FROM numbers', null, true).length).toBe(2);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => null);
    expect(() => {
      transaction(
        db,
        () => {
          runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id3', 3)");
          runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 1)");
        },
        { immediate: true },
      );
    }).toThrow(/constraint failed/);
    consoleSpy.mockRestore();

    expect(runQuery(db, 'SELECT * FROM numbers', null, true).length).toBe(2);
    // The failed transaction must have released the write lock
    runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id4', 4)");
    expect(runQuery(db, 'SELECT * FROM numbers', null, true).length).toBe(3);
  });

  it('should use the crdt index for a batched cell lookup', async () => {
    // Mirrors the query `compareMessages` in server/sync builds for a
    // full chunk. If the planner ever falls back to a table scan on the
    // web build's SQLite, bulk edits get slow again.
    const db = await openDatabase();
    execQuery(
      db,
      `
      CREATE TABLE messages_crdt (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL UNIQUE,
        dataset TEXT NOT NULL,
        row TEXT NOT NULL,
        column TEXT NOT NULL,
        value BLOB NOT NULL
      );
      CREATE INDEX messages_crdt_search ON messages_crdt(dataset, row, column, timestamp);
      `,
    );

    const termCount = 100;
    const term = '(dataset = ? AND row = ? AND column = ? AND timestamp >= ?)';
    const sql =
      'SELECT dataset, row, column, timestamp FROM messages_crdt WHERE ' +
      Array(termCount).fill(term).join(' OR ');
    const params = Array.from({ length: termCount }, (_, index) => [
      'transactions',
      `row${index}`,
      'amount',
      '2024-01-01T00:00:00.000Z-0000-0000000000000000',
    ]).flat();

    const plan = runQuery<{ detail: string }>(
      db,
      'EXPLAIN QUERY PLAN ' + sql,
      params,
      true,
    );
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.some(step => step.detail.includes('SCAN'))).toBe(false);
    expect(
      plan.some(step => step.detail.includes('messages_crdt_search')),
    ).toBe(true);

    // And the query itself runs within the parameter limits
    expect(runQuery(db, sql, params, true)).toEqual([]);
  });

  it('should match regex on text fields', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    runQuery(
      db,
      "INSERT INTO textstrings (id, string) VALUES ('id1', 'not empty string')",
    );
    runQuery(db, "INSERT INTO textstrings (id) VALUES ('id2')");

    const rows = runQuery(
      db,
      'SELECT id FROM textstrings where REGEXP("n.", string)',
      null,
      true,
    );
    expect(rows.length).toBe(1);
    // @ts-expect-error Property 'id' does not exist on type 'unknown'
    expect(rows[0].id).toBe('id1');
  });

  it('should not throw on an unparseable regex, matching nothing instead', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    runQuery(
      db,
      "INSERT INTO textstrings (id, string) VALUES ('id1', '#mortgage note')",
    );

    // A partially typed regex is a normal transient state while editing a
    // `matches` filter, and must not throw out of the SQL engine. Note the
    // seeded row: SQLite only calls a user function when it scans a row, so
    // without one the broken behaviour is invisible.
    expect(
      runQuery(
        db,
        "SELECT id FROM textstrings where REGEXP('\\', string)",
        null,
        true,
      ),
    ).toEqual([]);

    expect(
      runQuery(
        db,
        "SELECT id FROM textstrings where REGEXP('#[', string)",
        null,
        true,
      ),
    ).toEqual([]);

    expect(
      runQuery(
        db,
        "SELECT id FROM textstrings where REGEXP('(', string)",
        null,
        true,
      ),
    ).toEqual([]);
  });

  it('should report an unparseable regex once per pattern, not once per scanned row', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    // SQLite calls the REGEXP user function once per candidate row, and the
    // rule editor re-runs its live preview on every keystroke. Logging from
    // inside the function therefore multiplies by the size of the budget: on
    // the demo budget one filter query produced 1203 lines. A single-row table
    // cannot tell per-row logging apart from per-pattern logging, so the seed
    // is load-bearing here.
    for (let i = 0; i < 300; i++) {
      runQuery(
        db,
        `INSERT INTO textstrings (id, string) VALUES ('id${i}', '#mortgage note')`,
      );
    }

    // Patterns used by no other case in this file, so the count starts from an
    // unreported pattern. That each is reported exactly once is a statement
    // about this handle's rows, not about the lifetime of the dedupe set — the
    // Set lives in the closure createRegexp returns in ./index.ts, and the test
    // below is what pins that lifetime.
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => null);
    const invalidRegexLogs = () =>
      consoleSpy.mock.calls.filter(
        call => call[0] === 'invalid regexp in sqlite REGEXP',
      ).length;

    expect(
      runQuery(
        db,
        "SELECT id FROM textstrings where REGEXP('(?<', string)",
        null,
        true,
      ),
    ).toEqual([]);
    expect(invalidRegexLogs()).toBe(1);

    // Deduplicated per pattern, not globally: a second broken pattern is still
    // reported, so a genuinely bad saved rule does not go unnoticed.
    expect(
      runQuery(
        db,
        "SELECT id FROM textstrings where REGEXP('[a-', string)",
        null,
        true,
      ),
    ).toEqual([]);
    expect(invalidRegexLogs()).toBe(2);

    // And the dedupe is not a blanket suppression: a valid pattern still
    // matches every row, silently.
    expect(
      runQuery(
        db,
        "SELECT id FROM textstrings where REGEXP('#mortgage', string)",
        null,
        true,
      ).length,
    ).toBe(300);
    expect(invalidRegexLogs()).toBe(2);

    consoleSpy.mockRestore();
  });

  it('should report an unparseable pattern once per database handle, not once per process', async () => {
    // The assertion above cannot tell a Set scoped to createRegexp()'s closure
    // from one at module scope: every pattern it uses is unique to this file,
    // so both implementations report the same number of lines. Two handles
    // reporting the same pattern is what separates them — a process-wide Set
    // silences the second handle and the count stays at 1.
    const seed = db => {
      execQuery(db, initSQL);
      for (const id of ['1', '2', '3']) {
        runQuery(
          db,
          `INSERT INTO textstrings (id, string) VALUES ('id${id}', '#mortgage note')`,
        );
      }
    };

    const db1 = await openDatabase();
    handles.push(db1);
    seed(db1);
    const db2 = await openDatabase();
    handles.push(db2);
    seed(db2);

    // A pattern used by no other case in this file, so the count starts from
    // zero regardless of which tests ran before this one.
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => null);
    const invalidRegexLogs = () =>
      consoleSpy.mock.calls.filter(
        call => call[0] === 'invalid regexp in sqlite REGEXP',
      ).length;

    // This backend binds its params, so it takes null where the native one
    // takes [].
    const query = (db, pattern) =>
      runQuery(
        db,
        `SELECT id FROM textstrings where REGEXP('${pattern}', string)`,
        null,
        true,
      );

    expect(query(db1, '(?<handle')).toEqual([]);
    expect(invalidRegexLogs()).toBe(1);

    // The same pattern over a second handle in the same process is reported
    // again: the dedupe set belongs to the handle, not the process.
    expect(query(db2, '(?<handle')).toEqual([]);
    expect(invalidRegexLogs()).toBe(2);

    // And each handle still dedupes on its own afterwards.
    expect(query(db1, '(?<handle')).toEqual([]);
    expect(invalidRegexLogs()).toBe(2);

    consoleSpy.mockRestore();
  });

  it('should still match a valid regex that does match, and not throw on one that does not', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    runQuery(
      db,
      "INSERT INTO textstrings (id, string) VALUES ('id1', '#mortgage note')",
    );

    expect(
      runQuery(
        db,
        "SELECT id FROM textstrings where REGEXP('#mortgage', string)",
        null,
        true,
      ).length,
    ).toBe(1);

    // Well-formed, but matches nothing: that is an empty result, not an error
    expect(
      runQuery(
        db,
        "SELECT id FROM textstrings where REGEXP('normal', string)",
        null,
        true,
      ),
    ).toEqual([]);

    expect(
      runQuery(
        db,
        "SELECT id FROM textstrings where REGEXP('#\\d+', string)",
        null,
        true,
      ),
    ).toEqual([]);
  });

  // Last on purpose, and the position is load-bearing. Placed first this would
  // still see the beforeAll's patch, because no afterEach has run yet, so it
  // would pass for the wrong reason; and it would be vacuous whenever -t
  // selects it alone (measured: with the beforeEach above removed,
  // `vitest --run --config vitest.web.config.ts -t 'keeps the sql.js wasm fetch
  // patched'` still reports 1 passed | 15 skipped). This test therefore has
  // power only in a full-file run.
  it('keeps the sql.js wasm fetch patched for each test, not just the first', async () => {
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);

    const res = await globalThis.fetch(`${baseURL}sql-wasm.wasm`);
    expect(res.status).toBe(200);
  });
});
