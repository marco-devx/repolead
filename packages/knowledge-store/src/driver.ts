export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction(fn: () => void): () => void;
  close(): void;
}

/**
 * Driver dual: bun:sqlite bajo Bun (better-sqlite3 no carga en Bun) y
 * better-sqlite3 bajo Node (bun:sqlite no existe ahí y el node:sqlite de
 * Node 22 no trae FTS5). Ambos exponen la misma API estructural mínima.
 * El comentario webpackIgnore evita que Rspack intente resolver el
 * specifier en build time.
 */
export async function openDatabase(path: string): Promise<SqlDatabase> {
  const specifier = process.versions.bun ? 'bun:sqlite' : 'better-sqlite3';
  const loaded = (await import(/* webpackIgnore: true */ specifier)) as {
    Database?: new (path: string) => SqlDatabase;
    default?: new (path: string) => SqlDatabase;
  };
  const Database = loaded.Database ?? loaded.default;
  if (!Database) {
    throw new Error(`No se pudo cargar el driver SQLite (${specifier})`);
  }
  return new Database(path);
}
