import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type TrustTier = "raw" | "verified" | "policy-backed" | "deprecated";

export type NoteRecord = {
  id: string;
  created_at: string;
  source: string | null;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  trust_tier: TrustTier;
  expires_at: string | null;
  promoted_from_note_id: string | null;
  tags: string[];
  related_paths: string[];
  text: string;
  score?: number;
};

export type TranscriptRecord = {
  id: string;
  created_at: string;
  session_id: string;
  source_client: string;
  source_model: string | null;
  source_agent: string | null;
  kind: string;
  text: string;
  score?: number;
};

export type TranscriptLineRecord = {
  id: number;
  run_id: string | null;
  role: string | null;
  content: string;
  timestamp: string;
  is_squished: boolean;
  score?: number;
};

export type MemoryRecord = {
  id: number;
  content: string;
  keywords: string[];
  created_at: string;
  last_accessed_at: string;
  decay_score: number;
  score?: number;
};

export type MutationMeta = {
  idempotency_key: string;
  side_effect_fingerprint: string;
};

export type MutationStartResult = {
  replayed: boolean;
  result?: unknown;
};

export type RunEventRecord = {
  id: string;
  created_at: string;
  run_id: string;
  event_type: "begin" | "step" | "end";
  step_index: number;
  status: string;
  summary: string;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  details: Record<string, unknown>;
};

export type LockAcquireResult = {
  acquired: boolean;
  lock_key: string;
  owner_id?: string;
  lease_expires_at?: string;
  reason?: string;
};

export type IncidentRecord = {
  incident_id: string;
  created_at: string;
  updated_at: string;
  severity: string;
  status: string;
  title: string;
  summary: string;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
  tags: string[];
};

export type IncidentEventRecord = {
  id: string;
  created_at: string;
  incident_id: string;
  event_type: string;
  summary: string;
  details: Record<string, unknown>;
  source_client: string | null;
  source_model: string | null;
  source_agent: string | null;
};

export class Storage {
  private db: Database.Database;

  constructor(private dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  init(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        source TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT,
        trust_tier TEXT NOT NULL DEFAULT 'raw',
        expires_at TEXT,
        promoted_from_note_id TEXT,
        tags_json TEXT NOT NULL,
        related_paths_json TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_client TEXT NOT NULL,
        source_model TEXT,
        source_agent TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        role TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_squished BOOLEAN DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT,
        keywords TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        decay_score REAL DEFAULT 1.0
      );
      CREATE TABLE IF NOT EXISTS adrs (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        content TEXT
      );
      CREATE TABLE IF NOT EXISTS mutation_journal (
        idempotency_key TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        side_effect_fingerprint TEXT NOT NULL,
        payload_hash TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        error_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policy_evaluations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        policy_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        reason TEXT,
        violations_json TEXT NOT NULL,
        recommendations_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT,
        details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS locks (
        lock_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        consequences TEXT,
        rollback TEXT,
        links_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        run_id TEXT,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS decision_links (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
      CREATE TABLE IF NOT EXISTS incident_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        source_client TEXT,
        source_model TEXT,
        source_agent TEXT
      );
    `);

    this.ensureColumn("notes", "source_client", "TEXT");
    this.ensureColumn("notes", "source_model", "TEXT");
    this.ensureColumn("notes", "source_agent", "TEXT");
    this.ensureColumn("notes", "trust_tier", "TEXT NOT NULL DEFAULT 'raw'");
    this.ensureColumn("notes", "expires_at", "TEXT");
    this.ensureColumn("notes", "promoted_from_note_id", "TEXT");
    this.ensureColumn("transcripts", "source_model", "TEXT");
    this.ensureColumn("transcripts", "source_agent", "TEXT");

    this.ensureIndex("idx_notes_created", "notes", "created_at DESC");
    this.ensureIndex("idx_notes_trust", "notes", "trust_tier");
    this.ensureIndex("idx_transcripts_session", "transcripts", "session_id, created_at ASC");
    this.ensureIndex("idx_transcript_lines_run", "transcript_lines", "run_id, timestamp ASC");
    this.ensureIndex("idx_transcript_lines_squished", "transcript_lines", "is_squished, timestamp ASC");
    this.ensureIndex("idx_memories_created", "memories", "created_at DESC");
    this.ensureIndex("idx_memories_last_accessed", "memories", "last_accessed_at DESC");
    this.ensureIndex("idx_memories_keywords", "memories", "keywords");
    this.ensureIndex("idx_adrs_status", "adrs", "status");
    this.ensureIndex("idx_run_events_run", "run_events", "run_id, created_at ASC");
    this.ensureIndex("idx_incident_events_incident", "incident_events", "incident_id, created_at ASC");
  }

  insertNote(params: {
    text: string;
    source?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    trust_tier?: TrustTier;
    expires_at?: string;
    promoted_from_note_id?: string;
    tags?: string[];
    related_paths?: string[];
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const tags = params.tags ?? [];
    const relatedPaths = params.related_paths ?? [];
    const trustTier = params.trust_tier ?? "raw";
    const stmt = this.db.prepare(
      `INSERT INTO notes (
        id, created_at, source, source_client, source_model, source_agent,
        trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      id,
      createdAt,
      params.source ?? null,
      params.source_client ?? null,
      params.source_model ?? null,
      params.source_agent ?? null,
      trustTier,
      params.expires_at ?? null,
      params.promoted_from_note_id ?? null,
      JSON.stringify(tags),
      JSON.stringify(relatedPaths),
      params.text
    );
    return { id, created_at: createdAt };
  }

  getNoteById(noteId: string): NoteRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, created_at, source, source_client, source_model, source_agent,
                trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
         FROM notes
         WHERE id = ?`
      )
      .get(noteId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapNoteRow(row);
  }

  searchNotes(params: {
    query?: string;
    tags?: string[];
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    trust_tiers?: TrustTier[];
    include_expired?: boolean;
    limit: number;
  }): NoteRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query?.trim();
    const rows = query
      ? (this.db
          .prepare(
            `SELECT id, created_at, source, source_client, source_model, source_agent,
                    trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
             FROM notes
             WHERE text LIKE ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(`%${query}%`, limit * 20) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT id, created_at, source, source_client, source_model, source_agent,
                    trust_tier, expires_at, promoted_from_note_id, tags_json, related_paths_json, text
             FROM notes
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(limit * 20) as Array<Record<string, unknown>>);

    const nowIso = new Date().toISOString();
    const tagFilter = params.tags?.map((tag) => tag.toLowerCase()) ?? [];
    const trustFilter = new Set((params.trust_tiers ?? []).map((tier) => String(tier)));
    const includeExpired = params.include_expired ?? true;

    const results: NoteRecord[] = [];
    for (const row of rows) {
      const note = mapNoteRow(row);
      if (tagFilter.length > 0) {
        const lowerTags = note.tags.map((tag) => tag.toLowerCase());
        const hasAll = tagFilter.every((tag) => lowerTags.includes(tag));
        if (!hasAll) {
          continue;
        }
      }
      if (params.source_client && note.source_client !== params.source_client) {
        continue;
      }
      if (params.source_model && note.source_model !== params.source_model) {
        continue;
      }
      if (params.source_agent && note.source_agent !== params.source_agent) {
        continue;
      }
      if (trustFilter.size > 0 && !trustFilter.has(note.trust_tier)) {
        continue;
      }
      if (!includeExpired && note.expires_at && note.expires_at <= nowIso) {
        continue;
      }
      note.score = computeTermScore(note.text, query);
      results.push(note);
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  insertMemory(params: {
    content: string;
    keywords?: string[];
    decay_score?: number;
  }): { id: number; created_at: string; last_accessed_at: string } {
    const now = new Date().toISOString();
    const keywords = normalizeKeywords(params.keywords);
    const stmt = this.db.prepare(
      `INSERT INTO memories (content, keywords, created_at, last_accessed_at, decay_score)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      params.content,
      keywords.join(", "),
      now,
      now,
      params.decay_score ?? 1.0
    );
    return {
      id: Number(result.lastInsertRowid),
      created_at: now,
      last_accessed_at: now,
    };
  }

  getMemoryById(memoryId: number): MemoryRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, content, keywords, created_at, last_accessed_at, decay_score
         FROM memories
         WHERE id = ?`
      )
      .get(memoryId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapMemoryRow(row);
  }

  searchMemories(params: {
    query: string;
    limit: number;
  }): MemoryRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query.trim();
    if (!query) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT id, content, keywords, created_at, last_accessed_at, decay_score
         FROM memories
         WHERE content LIKE ? OR keywords LIKE ?
         ORDER BY last_accessed_at DESC, created_at DESC
         LIMIT ?`
      )
      .all(`%${query}%`, `%${query}%`, limit) as Array<Record<string, unknown>>;

    const accessedAt = new Date().toISOString();
    const result = rows.map((row) => {
      const memory = mapMemoryRow(row);
      memory.score = computeTermScore(`${memory.content} ${memory.keywords.join(" ")}`, query);
      memory.last_accessed_at = accessedAt;
      return memory;
    });

    if (result.length > 0) {
      const updateStmt = this.db.prepare(`UPDATE memories SET last_accessed_at = ? WHERE id = ?`);
      const tx = this.db.transaction((ids: number[]) => {
        for (const id of ids) {
          updateStmt.run(accessedAt, id);
        }
      });
      tx(result.map((entry) => entry.id));
    }

    return result;
  }

  decayNotes(params: {
    older_than_iso: string;
    from_tiers: TrustTier[];
    to_tier: TrustTier;
    limit: number;
  }): { updated_ids: string[] } {
    if (params.from_tiers.length === 0) {
      return { updated_ids: [] };
    }
    const limit = Math.max(1, Math.min(500, params.limit));
    const placeholders = params.from_tiers.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id
         FROM notes
         WHERE created_at <= ?
           AND trust_tier IN (${placeholders})
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(params.older_than_iso, ...params.from_tiers, limit) as Array<Record<string, unknown>>;
    const ids = rows.map((row) => String(row.id));
    if (ids.length === 0) {
      return { updated_ids: [] };
    }
    const updateStmt = this.db.prepare(`UPDATE notes SET trust_tier = ? WHERE id = ?`);
    const tx = this.db.transaction((noteIds: string[]) => {
      for (const noteId of noteIds) {
        updateStmt.run(params.to_tier, noteId);
      }
    });
    tx(ids);
    return { updated_ids: ids };
  }

  insertTranscript(params: {
    session_id: string;
    source_client: string;
    source_model?: string;
    source_agent?: string;
    kind: string;
    text: string;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO transcripts (id, created_at, session_id, source_client, source_model, source_agent, kind, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      id,
      createdAt,
      params.session_id,
      params.source_client,
      params.source_model ?? null,
      params.source_agent ?? null,
      params.kind,
      params.text
    );
    return { id, created_at: createdAt };
  }

  insertTranscriptLine(params: {
    run_id?: string;
    role: string;
    content: string;
    is_squished?: boolean;
  }): { id: number; timestamp: string } {
    const timestamp = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO transcript_lines (run_id, role, content, timestamp, is_squished)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      params.run_id ?? null,
      params.role,
      params.content,
      timestamp,
      params.is_squished ? 1 : 0
    );
    return {
      id: Number(result.lastInsertRowid),
      timestamp,
    };
  }

  getTranscriptLinesByRun(runId: string, limit = 1000): TranscriptLineRecord[] {
    const boundedLimit = Math.max(1, Math.min(5000, limit));
    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE run_id = ?
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(runId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTranscriptLineRow(row));
  }

  getUnsquishedTranscriptLines(runId: string, limit = 500): TranscriptLineRecord[] {
    const boundedLimit = Math.max(1, Math.min(5000, limit));
    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE run_id = ?
           AND is_squished = 0
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(runId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTranscriptLineRow(row));
  }

  searchTranscriptLines(params: {
    query: string;
    run_id?: string;
    include_squished?: boolean;
    limit: number;
  }): TranscriptLineRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query.trim();
    if (!query) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT id, run_id, role, content, timestamp, is_squished
         FROM transcript_lines
         WHERE content LIKE ?
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(`%${query}%`, limit * 20) as Array<Record<string, unknown>>;

    const includeSquished = params.include_squished ?? true;
    const result: TranscriptLineRecord[] = [];
    for (const row of rows) {
      const line = mapTranscriptLineRow(row);
      if (params.run_id && line.run_id !== params.run_id) {
        continue;
      }
      if (!includeSquished && line.is_squished) {
        continue;
      }
      line.score = computeTermScore(line.content, query);
      result.push(line);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  markTranscriptLinesSquished(lineIds: number[]): { updated_count: number } {
    if (lineIds.length === 0) {
      return { updated_count: 0 };
    }
    const stmt = this.db.prepare(`UPDATE transcript_lines SET is_squished = 1 WHERE id = ?`);
    const tx = this.db.transaction((ids: number[]) => {
      let updated = 0;
      for (const id of ids) {
        const result = stmt.run(id);
        updated += Number(result.changes ?? 0);
      }
      return updated;
    });
    return { updated_count: tx(lineIds) };
  }

  getTranscriptById(transcriptId: string): TranscriptRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
         FROM transcripts
         WHERE id = ?`
      )
      .get(transcriptId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapTranscriptRow(row);
  }

  getTranscriptsBySession(sessionId: string): TranscriptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
         FROM transcripts
         WHERE session_id = ?
         ORDER BY created_at ASC`
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => mapTranscriptRow(row));
  }

  searchTranscripts(params: {
    query?: string;
    session_id?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    limit: number;
  }): TranscriptRecord[] {
    const limit = Math.max(1, Math.min(50, params.limit));
    const query = params.query?.trim();
    const rows = query
      ? (this.db
          .prepare(
            `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
             FROM transcripts
             WHERE text LIKE ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(`%${query}%`, limit * 20) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT id, created_at, session_id, source_client, source_model, source_agent, kind, text
             FROM transcripts
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(limit * 20) as Array<Record<string, unknown>>);

    const results: TranscriptRecord[] = [];
    for (const row of rows) {
      const transcript = mapTranscriptRow(row);
      if (params.session_id && params.session_id !== transcript.session_id) {
        continue;
      }
      if (params.source_client && params.source_client !== transcript.source_client) {
        continue;
      }
      if (params.source_model && params.source_model !== transcript.source_model) {
        continue;
      }
      if (params.source_agent && params.source_agent !== transcript.source_agent) {
        continue;
      }
      transcript.score = computeTermScore(transcript.text, query);
      results.push(transcript);
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  beginMutation(toolName: string, mutation: MutationMeta, payload: unknown): MutationStartResult {
    const now = new Date().toISOString();
    const payloadHash = hashPayload(payload);
    const existing = this.db
      .prepare(
        `SELECT tool_name, side_effect_fingerprint, status, result_json, error_text
         FROM mutation_journal
         WHERE idempotency_key = ?`
      )
      .get(mutation.idempotency_key) as Record<string, unknown> | undefined;

    if (existing) {
      const existingTool = String(existing.tool_name ?? "");
      const existingFingerprint = String(existing.side_effect_fingerprint ?? "");
      const status = String(existing.status ?? "unknown");
      const resultJson = asNullableString(existing.result_json);
      const errorText = asNullableString(existing.error_text);

      if (existingTool !== toolName) {
        throw new Error(
          `Idempotency key already used by a different tool (expected ${existingTool}, got ${toolName}).`
        );
      }
      if (existingFingerprint !== mutation.side_effect_fingerprint) {
        throw new Error("Idempotency key reuse with mismatched side_effect_fingerprint.");
      }
      if (status === "done") {
        return {
          replayed: true,
          result: parseJsonUnknown(resultJson),
        };
      }
      if (status === "failed") {
        throw new Error(`Previous mutation failed for key ${mutation.idempotency_key}: ${errorText ?? "unknown"}`);
      }
      throw new Error(`Mutation key is already in progress: ${mutation.idempotency_key}`);
    }

    this.db
      .prepare(
        `INSERT INTO mutation_journal (
          idempotency_key, tool_name, side_effect_fingerprint, payload_hash,
          status, result_json, error_text, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'in_progress', NULL, NULL, ?, ?)`
      )
      .run(
        mutation.idempotency_key,
        toolName,
        mutation.side_effect_fingerprint,
        payloadHash,
        now,
        now
      );

    return { replayed: false };
  }

  completeMutation(idempotencyKey: string, result: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE mutation_journal
         SET status = 'done', result_json = ?, error_text = NULL, updated_at = ?
         WHERE idempotency_key = ?`
      )
      .run(stableStringify(result), now, idempotencyKey);
  }

  failMutation(idempotencyKey: string, errorText: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE mutation_journal
         SET status = 'failed', error_text = ?, updated_at = ?
         WHERE idempotency_key = ?`
      )
      .run(errorText, now, idempotencyKey);
  }

  getMutationStatus(idempotencyKey: string): {
    idempotency_key: string;
    tool_name: string;
    side_effect_fingerprint: string;
    status: string;
    created_at: string;
    updated_at: string;
    error_text: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT idempotency_key, tool_name, side_effect_fingerprint, status, created_at, updated_at, error_text
         FROM mutation_journal
         WHERE idempotency_key = ?`
      )
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      idempotency_key: String(row.idempotency_key),
      tool_name: String(row.tool_name),
      side_effect_fingerprint: String(row.side_effect_fingerprint),
      status: String(row.status),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      error_text: asNullableString(row.error_text),
    };
  }

  insertPolicyEvaluation(params: {
    policy_name: string;
    input: unknown;
    allowed: boolean;
    reason: string;
    violations: Array<Record<string, unknown>>;
    recommendations: string[];
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO policy_evaluations (
          id, created_at, policy_name, input_json, allowed, reason, violations_json, recommendations_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.policy_name,
        stableStringify(params.input),
        params.allowed ? 1 : 0,
        params.reason,
        stableStringify(params.violations),
        stableStringify(params.recommendations)
      );
    return { id, created_at: createdAt };
  }

  appendRunEvent(params: {
    run_id: string;
    event_type: "begin" | "step" | "end";
    step_index: number;
    status: string;
    summary: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
    details?: Record<string, unknown>;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const details = params.details ?? {};
    this.db
      .prepare(
        `INSERT INTO run_events (
          id, created_at, run_id, event_type, step_index, status, summary,
          source_client, source_model, source_agent, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.run_id,
        params.event_type,
        params.step_index,
        params.status,
        params.summary,
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null,
        stableStringify(details)
      );
    return { id, created_at: createdAt };
  }

  getRunTimeline(runId: string, limit: number): RunEventRecord[] {
    const boundedLimit = Math.max(1, Math.min(200, limit));
    const rows = this.db
      .prepare(
        `SELECT id, created_at, run_id, event_type, step_index, status, summary,
                source_client, source_model, source_agent, details_json
         FROM run_events
         WHERE run_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(runId, boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      created_at: String(row.created_at),
      run_id: String(row.run_id),
      event_type: String(row.event_type) as RunEventRecord["event_type"],
      step_index: Number(row.step_index ?? 0),
      status: String(row.status),
      summary: String(row.summary),
      source_client: asNullableString(row.source_client),
      source_model: asNullableString(row.source_model),
      source_agent: asNullableString(row.source_agent),
      details: parseJsonObject(row.details_json),
    }));
  }

  acquireLock(params: {
    lock_key: string;
    owner_id: string;
    lease_seconds: number;
    metadata?: Record<string, unknown>;
  }): LockAcquireResult {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.lease_seconds * 1000).toISOString();
    const metadata = stableStringify(params.metadata ?? {});

    const existing = this.db
      .prepare(`SELECT owner_id, lease_expires_at FROM locks WHERE lock_key = ?`)
      .get(params.lock_key) as Record<string, unknown> | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO locks (lock_key, owner_id, lease_expires_at, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(params.lock_key, params.owner_id, expiresAt, metadata, now, now);
      return {
        acquired: true,
        lock_key: params.lock_key,
        owner_id: params.owner_id,
        lease_expires_at: expiresAt,
      };
    }

    const currentOwner = String(existing.owner_id ?? "");
    const currentExpiry = String(existing.lease_expires_at ?? "");
    const isExpired = currentExpiry <= now;

    if (currentOwner === params.owner_id || isExpired) {
      this.db
        .prepare(
          `UPDATE locks
           SET owner_id = ?, lease_expires_at = ?, metadata_json = ?, updated_at = ?
           WHERE lock_key = ?`
        )
        .run(params.owner_id, expiresAt, metadata, now, params.lock_key);
      return {
        acquired: true,
        lock_key: params.lock_key,
        owner_id: params.owner_id,
        lease_expires_at: expiresAt,
        reason: currentOwner === params.owner_id ? "renewed" : "stolen-expired",
      };
    }

    return {
      acquired: false,
      lock_key: params.lock_key,
      owner_id: currentOwner,
      lease_expires_at: currentExpiry,
      reason: "held-by-active-owner",
    };
  }

  releaseLock(params: {
    lock_key: string;
    owner_id: string;
    force?: boolean;
  }): { released: boolean; reason: string } {
    const existing = this.db
      .prepare(`SELECT owner_id FROM locks WHERE lock_key = ?`)
      .get(params.lock_key) as Record<string, unknown> | undefined;
    if (!existing) {
      return { released: false, reason: "not-found" };
    }
    const ownerId = String(existing.owner_id ?? "");
    if (!params.force && ownerId !== params.owner_id) {
      return { released: false, reason: "owner-mismatch" };
    }
    this.db.prepare(`DELETE FROM locks WHERE lock_key = ?`).run(params.lock_key);
    return { released: true, reason: params.force ? "force-released" : "released" };
  }

  upsertDecision(params: {
    decision_id: string;
    title: string;
    rationale: string;
    consequences?: string;
    rollback?: string;
    links?: string[];
    tags?: string[];
    run_id?: string;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { decision_id: string; created: boolean } {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT decision_id FROM decisions WHERE decision_id = ?`)
      .get(params.decision_id) as Record<string, unknown> | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO decisions (
            decision_id, created_at, updated_at, title, rationale, consequences, rollback,
            links_json, tags_json, run_id, source_client, source_model, source_agent
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.decision_id,
          now,
          now,
          params.title,
          params.rationale,
          params.consequences ?? null,
          params.rollback ?? null,
          stableStringify(params.links ?? []),
          stableStringify(params.tags ?? []),
          params.run_id ?? null,
          params.source_client ?? null,
          params.source_model ?? null,
          params.source_agent ?? null
        );
      return { decision_id: params.decision_id, created: true };
    }

    this.db
      .prepare(
        `UPDATE decisions
         SET updated_at = ?, title = ?, rationale = ?, consequences = ?, rollback = ?,
             links_json = ?, tags_json = ?, run_id = ?, source_client = ?, source_model = ?, source_agent = ?
         WHERE decision_id = ?`
      )
      .run(
        now,
        params.title,
        params.rationale,
        params.consequences ?? null,
        params.rollback ?? null,
        stableStringify(params.links ?? []),
        stableStringify(params.tags ?? []),
        params.run_id ?? null,
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null,
        params.decision_id
      );
    return { decision_id: params.decision_id, created: false };
  }

  insertDecisionLink(params: {
    decision_id: string;
    entity_type: string;
    entity_id: string;
    relation: string;
    details?: Record<string, unknown>;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO decision_links (
          id, created_at, decision_id, entity_type, entity_id, relation, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.decision_id,
        params.entity_type,
        params.entity_id,
        params.relation,
        stableStringify(params.details ?? {})
      );
    return { id, created_at: createdAt };
  }

  openIncident(params: {
    severity: string;
    title: string;
    summary: string;
    tags?: string[];
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { incident_id: string; event_id: string; created_at: string } {
    const incidentId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO incidents (
          incident_id, created_at, updated_at, severity, status, title, summary,
          tags_json, source_client, source_model, source_agent
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        incidentId,
        now,
        now,
        params.severity,
        params.title,
        params.summary,
        stableStringify(params.tags ?? []),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    const event = this.appendIncidentEvent({
      incident_id: incidentId,
      event_type: "opened",
      summary: params.summary,
      details: { severity: params.severity, title: params.title },
      source_client: params.source_client,
      source_model: params.source_model,
      source_agent: params.source_agent,
    });

    return { incident_id: incidentId, event_id: event.id, created_at: now };
  }

  appendIncidentEvent(params: {
    incident_id: string;
    event_type: string;
    summary: string;
    details?: Record<string, unknown>;
    source_client?: string;
    source_model?: string;
    source_agent?: string;
  }): { id: string; created_at: string } {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO incident_events (
          id, created_at, incident_id, event_type, summary, details_json,
          source_client, source_model, source_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        createdAt,
        params.incident_id,
        params.event_type,
        params.summary,
        stableStringify(params.details ?? {}),
        params.source_client ?? null,
        params.source_model ?? null,
        params.source_agent ?? null
      );

    this.db
      .prepare(`UPDATE incidents SET updated_at = ? WHERE incident_id = ?`)
      .run(createdAt, params.incident_id);

    return { id, created_at: createdAt };
  }

  getIncidentTimeline(incidentId: string, limit: number): {
    incident: IncidentRecord | null;
    events: IncidentEventRecord[];
  } {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const incidentRow = this.db
      .prepare(
        `SELECT incident_id, created_at, updated_at, severity, status, title, summary,
                tags_json, source_client, source_model, source_agent
         FROM incidents
         WHERE incident_id = ?`
      )
      .get(incidentId) as Record<string, unknown> | undefined;

    if (!incidentRow) {
      return { incident: null, events: [] };
    }

    const eventRows = this.db
      .prepare(
        `SELECT id, created_at, incident_id, event_type, summary, details_json,
                source_client, source_model, source_agent
         FROM incident_events
         WHERE incident_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(incidentId, boundedLimit) as Array<Record<string, unknown>>;

    const incident: IncidentRecord = {
      incident_id: String(incidentRow.incident_id),
      created_at: String(incidentRow.created_at),
      updated_at: String(incidentRow.updated_at),
      severity: String(incidentRow.severity),
      status: String(incidentRow.status),
      title: String(incidentRow.title),
      summary: String(incidentRow.summary),
      source_client: asNullableString(incidentRow.source_client),
      source_model: asNullableString(incidentRow.source_model),
      source_agent: asNullableString(incidentRow.source_agent),
      tags: safeParseJsonArray(incidentRow.tags_json),
    };

    const events = eventRows
      .map((row) => ({
        id: String(row.id),
        created_at: String(row.created_at),
        incident_id: String(row.incident_id),
        event_type: String(row.event_type),
        summary: String(row.summary),
        details: parseJsonObject(row.details_json),
        source_client: asNullableString(row.source_client),
        source_model: asNullableString(row.source_model),
        source_agent: asNullableString(row.source_agent),
      }))
      .reverse();

    return { incident, events };
  }

  insertAdr(params: {
    id: string;
    title: string;
    status: string;
    content: string;
  }): { id: string } {
    this.db
      .prepare(`INSERT INTO adrs (id, title, status, content) VALUES (?, ?, ?, ?)`)
      .run(params.id, params.title, params.status, params.content);
    return { id: params.id };
  }

  getTableCounts(): Record<string, number> {
    const tables = [
      "notes",
      "transcripts",
      "transcript_lines",
      "memories",
      "adrs",
      "mutation_journal",
      "policy_evaluations",
      "run_events",
      "locks",
      "decisions",
      "decision_links",
      "incidents",
      "incident_events",
    ] as const;
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown>;
      counts[table] = Number(row.count ?? 0);
    }
    return counts;
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
    const exists = rows.some((row) => String(row.name) === column);
    if (!exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private ensureIndex(indexName: string, table: string, columns: string): void {
    this.db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (${columns})`);
  }
}

function mapNoteRow(row: Record<string, unknown>): NoteRecord {
  return {
    id: String(row.id),
    created_at: String(row.created_at),
    source: asNullableString(row.source),
    source_client: asNullableString(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
    trust_tier: normalizeTrustTier(row.trust_tier),
    expires_at: asNullableString(row.expires_at),
    promoted_from_note_id: asNullableString(row.promoted_from_note_id),
    tags: safeParseJsonArray(row.tags_json),
    related_paths: safeParseJsonArray(row.related_paths_json),
    text: String(row.text ?? ""),
  };
}

function mapTranscriptRow(row: Record<string, unknown>): TranscriptRecord {
  return {
    id: String(row.id),
    created_at: String(row.created_at),
    session_id: String(row.session_id),
    source_client: String(row.source_client),
    source_model: asNullableString(row.source_model),
    source_agent: asNullableString(row.source_agent),
    kind: String(row.kind),
    text: String(row.text ?? ""),
  };
}

function mapTranscriptLineRow(row: Record<string, unknown>): TranscriptLineRecord {
  return {
    id: Number(row.id ?? 0),
    run_id: asNullableString(row.run_id),
    role: asNullableString(row.role),
    content: String(row.content ?? ""),
    timestamp: String(row.timestamp ?? ""),
    is_squished: Number(row.is_squished ?? 0) === 1,
  };
}

function mapMemoryRow(row: Record<string, unknown>): MemoryRecord {
  return {
    id: Number(row.id ?? 0),
    content: String(row.content ?? ""),
    keywords: parseKeywords(row.keywords),
    created_at: String(row.created_at ?? ""),
    last_accessed_at: String(row.last_accessed_at ?? ""),
    decay_score: Number(row.decay_score ?? 1),
  };
}

function normalizeTrustTier(value: unknown): TrustTier {
  const normalized = String(value ?? "raw");
  if (normalized === "verified" || normalized === "policy-backed" || normalized === "deprecated") {
    return normalized;
  }
  return "raw";
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  return text.length > 0 ? text : null;
}

function normalizeKeywords(keywords: string[] | undefined): string[] {
  if (!keywords) {
    return [];
  }
  const unique = new Set<string>();
  for (const keyword of keywords) {
    const normalized = keyword.trim().toLowerCase();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

function parseKeywords(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeParseJsonArray(value: unknown): string[] {
  try {
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry));
      }
    }
  } catch {
    return [];
  }
  return [];
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    return {};
  }
  return {};
}

function parseJsonUnknown(value: string | null): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hashPayload(value: unknown): string {
  const normalized = stableStringify(value);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObject(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      sorted[key] = sortObject(entry);
    }
    return sorted;
  }
  return value;
}

function computeTermScore(text: string, query?: string): number {
  if (!query) {
    return 0;
  }
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const lowerText = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowerText.includes(term)) {
      score += 1;
    }
  }
  return score;
}
