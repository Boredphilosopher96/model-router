import { Database } from "bun:sqlite";
import type { ResponseCache } from "./types.ts";

function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  const sorted: Record<string, any> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}

export function cacheKey(provider: string, body: any): string {
  const toHash = {
    provider,
    model: body?.model,
    system: body?.system,
    messages: body?.messages,
    // OpenAI Responses API equivalents
    input: body?.input,
    instructions: body?.instructions,
    max_output_tokens: body?.max_output_tokens,
    tools: body?.tools,
    tool_choice: body?.tool_choice,
    max_tokens: body?.max_tokens,
    temperature: body?.temperature,
    top_p: body?.top_p,
  };

  const stable = JSON.stringify(sortObjectKeys(toHash));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(stable);
  return hasher.digest("hex");
}

export function createCache(dbPath: string, ttlMs: number): ResponseCache {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");

  // Initialize table
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Prepare statements
  const getStmt = db.prepare(
    "SELECT body, model, created_at FROM cache WHERE key = ?"
  );
  const setStmt = db.prepare(
    "INSERT OR REPLACE INTO cache (key, body, model, created_at) VALUES (?, ?, ?, ?)"
  );
  const deleteStmt = db.prepare("DELETE FROM cache WHERE key = ?");
  const deleteExpiredStmt = db.prepare(
    "DELETE FROM cache WHERE created_at + ? < ?"
  );
  const countStmt = db.prepare("SELECT COUNT(*) as count FROM cache");

  return {
    get(key: string): { body: string; model: string } | null {
      const row = getStmt.get(key) as
        | {
            body: string;
            model: string;
            created_at: number;
          }
        | undefined;

      if (!row) {
        return null;
      }

      const now = Date.now();
      if (now - row.created_at > ttlMs) {
        deleteStmt.run(key);
        return null;
      }

      return { body: row.body, model: row.model };
    },

    set(key: string, body: string, model: string): void {
      setStmt.run(key, body, model, Date.now());
    },

    prune(): number {
      const now = Date.now();
      const result = deleteExpiredStmt.run(ttlMs, now) as { changes: number };
      return result.changes;
    },

    size(): number {
      const result = countStmt.get() as { count: number } | undefined;
      return result?.count ?? 0;
    },
  };
}
