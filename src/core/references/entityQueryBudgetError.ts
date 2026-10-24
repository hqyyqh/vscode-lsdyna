/** Keep resource limits distinct from unrelated JavaScript RangeErrors. */
export class EntityQueryBudgetError extends RangeError {
    constructor(readonly reason: 'entity-query-index-budget' | 'entity-query-result-budget',
        readonly budgetBytes: number) {
        super(`${reason} (${budgetBytes} bytes)`);
    }
}
