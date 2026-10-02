import { Query } from '@actual-app/core/shared/query';

// `$sumOver` compiles to
// `SUM(amount) OVER (ORDER BY <the query's own orders> ROWS BETWEEN CURRENT ROW
// AND UNBOUNDED FOLLOWING)`, so the running balance is only correct when that
// window runs newest-to-oldest. Ordering the window explicitly keeps the
// balances right no matter which direction the transaction list is displayed
// in. `sort_order` mirrors the tiebreaker `applySort` appends, so rows sharing
// a date stay in a deterministic order.
const balanceOrderExpressions = [{ date: 'desc' }, { sort_order: 'desc' }];

/**
 * Rebuild `query` so its running-balance window always runs newest-to-oldest,
 * whatever the display sort is.
 *
 * Everything else about the query - its filters, options and selection - is
 * carried over untouched, so the balances are still computed over exactly the
 * rows the table shows.
 */
export function getBalanceQuery(query: Query): Query {
  return new Query({
    ...query.serialize(),
    orderExpressions: balanceOrderExpressions,
  });
}
