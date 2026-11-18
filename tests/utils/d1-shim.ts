import { Database } from "bun:sqlite";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
	D1Value,
} from "../../src/lib/types";

export class MemoryD1 implements D1Database {
	private readonly sqlite = new Database(":memory:");

	constructor() {
		this.sqlite.exec("PRAGMA foreign_keys = ON");
	}

	prepare(sql: string): D1PreparedStatement {
		return new MemoryStatement(this.sqlite, sql);
	}

	batch<T = unknown>(
		statements: D1PreparedStatement[],
	): Promise<D1Result<T>[]> {
		const transaction = this.sqlite.transaction(() =>
			statements.map((statement) => {
				if (!(statement instanceof MemoryStatement)) {
					throw new TypeError("Unsupported statement in memory D1 batch");
				}
				return statement.runForBatch<T>();
			}),
		);
		return Promise.resolve(transaction());
	}

	exec(sql: string): void {
		this.sqlite.exec(sql);
	}

	close(): void {
		this.sqlite.close();
	}
}

class MemoryStatement implements D1PreparedStatement {
	private values: D1Value[] = [];

	constructor(
		private readonly db: Database,
		private readonly sql: string,
	) {}

	bind(...values: D1Value[]): D1PreparedStatement {
		this.values = values;
		return this;
	}

	first<T = Record<string, unknown>>(): Promise<T | null> {
		return Promise.resolve(
			this.db.query<T, D1Value[]>(this.sql).get(...this.values) ?? null,
		);
	}

	all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		const results = this.db.query<T, D1Value[]>(this.sql).all(...this.values);
		return Promise.resolve({
			success: true,
			results,
			meta: this.meta(0, results.length, 0),
		});
	}

	run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return Promise.resolve(this.runForBatch<T>());
	}

	runForBatch<T>(): D1Result<T> {
		if (
			/\bRETURNING\b/i.test(this.sql) ||
			/^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql)
		) {
			const results = this.db.query<T, D1Value[]>(this.sql).all(...this.values);
			return { success: true, results, meta: this.meta(0, results.length, 0) };
		}
		const result = this.db.query(this.sql).run(...this.values);
		return {
			success: true,
			results: [],
			meta: this.meta(
				Number(result.lastInsertRowid),
				0,
				Number(result.changes),
			),
		};
	}

	private meta(lastRowId: number, rowsRead: number, rowsWritten: number) {
		return {
			changes: rowsWritten,
			last_row_id: lastRowId,
			rows_read: rowsRead,
			rows_written: rowsWritten,
		};
	}
}
