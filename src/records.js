// Big keyed collections (pages, patterns) kept in SQLite (data/crawler.db) instead of in memory.
// They held a record per page the crawler ever visited and per URL template it ever saw, half a
// million each and ~100k more a day, and filled Node's heap.
//
// A Records object is used like a map of plain objects: get(key) returns the record, which the
// caller changes in place as before. Records handed out stay in memory while in use and are
// written back on flush() (every save): those used in the last KEEP_MS, and any older one still
// referenced somewhere (held through a WeakRef). So code that holds a record across an await keeps
// one object per key, and its changes reach the database.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const KEEP_MS = 15 * 60 * 1000;

let db = null;
export function openDb(dir) {
  if (db) return db;
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'crawler.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -32000;
  `);
  return db;
}

export class Records {
  /**
   * `name` is the table. `columns` are extra indexed columns derived from (key, record), e.g. a
   * page's urlKey: { name: (key, rec) => value }. They're refreshed whenever the record is written,
   * and at once through touchColumns().
   */
  constructor(database, name, columns = {}) {
    this.db = database;
    this.name = name;
    this.columns = columns;
    const cols = Object.keys(columns);
    database.exec(`CREATE TABLE IF NOT EXISTS ${name} (key TEXT PRIMARY KEY, data TEXT NOT NULL${cols.map((c) => `, ${c} TEXT`).join('')}) WITHOUT ROWID`);
    for (const c of cols) database.exec(`CREATE INDEX IF NOT EXISTS ${name}_${c} ON ${name}(${c})`);
    const colList = cols.map((c) => `, ${c}`).join('');
    const colParams = cols.map(() => ', ?').join('');
    const colSet = cols.map((c) => `, ${c} = excluded.${c}`).join('');
    this.q = {
      get: database.prepare(`SELECT data FROM ${name} WHERE key = ?`),
      put: database.prepare(`INSERT INTO ${name} (key, data${colList}) VALUES (?, ?${colParams}) ON CONFLICT(key) DO UPDATE SET data = excluded.data${colSet}`),
      del: database.prepare(`DELETE FROM ${name} WHERE key = ?`),
      count: database.prepare(`SELECT count(*) AS n FROM ${name}`),
      all: database.prepare(`SELECT key, data FROM ${name}`),
      keys: database.prepare(`SELECT key FROM ${name}`),
    };
    this.live = new Map(); // key -> { rec, at, json }: in use lately; json = as last read or written
    this.weak = new Map(); // key -> { ref: WeakRef(rec), json }: used earlier, maybe still held
    this.gone = new FinalizationRegistry((key) => {
      const w = this.weak.get(key);
      if (w && !w.ref.deref()) this.weak.delete(key);
    });
  }

  /** The record, or undefined. */
  get(key) {
    const l = this.live.get(key);
    if (l) { l.at = Date.now(); return l.rec; }
    const w = this.weak.get(key);
    const held = w?.ref.deref();
    if (held) {
      this.weak.delete(key);
      this.live.set(key, { rec: held, at: Date.now(), json: w.json });
      return held;
    }
    const row = this.q.get.get(key);
    if (!row) return undefined;
    const rec = JSON.parse(row.data);
    this.live.set(key, { rec, at: Date.now(), json: row.data });
    return rec;
  }

  /** The record, created from make() (and stored) if missing. */
  ensure(key, make = () => ({})) {
    return this.get(key) ?? this.set(key, make());
  }

  set(key, rec) {
    this.weak.delete(key);
    this.live.set(key, { rec, at: Date.now(), json: null });
    if (Object.keys(this.columns).length) this.write(key, rec); // indexed columns are looked up at once
    return rec;
  }

  delete(key) {
    this.live.delete(key);
    this.weak.delete(key);
    this.q.del.run(key);
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  count() {
    this.flush();
    return this.q.count.get().n;
  }

  /** Write the record (and its indexed columns) now. */
  write(key, rec) {
    const json = JSON.stringify(rec);
    this.q.put.run(key, json, ...Object.values(this.columns).map((f) => f(key, rec) ?? null));
    const l = this.live.get(key);
    if (l && l.rec === rec) l.json = json;
    return json;
  }

  /** Write back the records in use that changed, and let go of those not used lately. */
  flush() {
    const old = Date.now() - KEEP_MS;
    this.db.exec('BEGIN');
    try {
      for (const [key, l] of this.live) {
        const json = JSON.stringify(l.rec);
        if (json !== l.json) { this.write(key, l.rec); l.json = json; }
        if (l.at < old) {
          this.live.delete(key);
          this.weak.set(key, { ref: new WeakRef(l.rec), json: l.json });
          this.gone.register(l.rec, key);
        }
      }
      for (const [key, w] of this.weak) {
        const rec = w.ref.deref();
        if (!rec) { this.weak.delete(key); continue; }
        const json = JSON.stringify(rec);
        if (json !== w.json) { this.write(key, rec); w.json = json; }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Every [key, record], read from the database after a flush (records in use come from memory,
   * so changes to them stick). Changes to other records are lost unless the caller set()s them.
   * Use for reading; it doesn't load everything at once.
   */
  *entries() {
    this.flush();
    for (const row of this.q.all.iterate()) {
      const l = this.live.get(row.key);
      yield [row.key, l ? l.rec : this.weak.get(row.key)?.ref.deref() ?? JSON.parse(row.data)];
    }
  }

  *keys() {
    this.flush();
    for (const row of this.q.keys.iterate()) yield row.key;
  }

  /** Keys of the records whose indexed column `col` is `value` (columns are kept current). */
  keysWhere(col, value) {
    if (!(col in this.columns)) throw new Error(`${this.name}: ${col} isn't an indexed column`);
    this.q[`by_${col}`] ??= this.db.prepare(`SELECT key FROM ${this.name} WHERE ${col} = ?`);
    return this.q[`by_${col}`].all(value).map((r) => r.key);
  }

  /** Rows of a query on this table (`sql` may use the table's name). */
  query(sql, ...params) {
    this.flush();
    return this.db.prepare(sql).all(...params);
  }

  /** Bring a record's indexed columns up to date now (e.g. a page's finalUrl was just set). */
  touchColumns(key) {
    const rec = this.get(key);
    if (rec) this.write(key, rec);
  }

  /** Import a plain { key: record } object (the old JSON file) in one transaction. */
  importObject(obj) {
    this.db.exec('BEGIN');
    try {
      let n = 0;
      for (const [k, rec] of Object.entries(obj)) {
        this.q.put.run(k, JSON.stringify(rec), ...Object.values(this.columns).map((f) => f(k, rec) ?? null));
        n++;
      }
      this.db.exec('COMMIT');
      return n;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
