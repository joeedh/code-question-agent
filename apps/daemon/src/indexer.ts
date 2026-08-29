import { readFile } from "node:fs/promises";
import {
  classifyOccurrenceKind,
  type Database,
  mapDocumentSymbolsToRows,
  mapReferencesToOccurrences,
  recordFileState,
  replaceFileIndex,
} from "@code-question-agent/db";
import { fromFileUri, type LspBridge, toFileUri } from "@code-question-agent/lsp-bridge";
import { type Kysely } from "kysely";
import { type DocumentSymbol, type Location } from "vscode-languageserver-protocol/node";

interface OccurrenceWork {
  symbolId: number;
  uri: string;
  line: number;
  character: number;
}

export interface Indexer {
  indexFile: (absolutePath: string) => Promise<void>;
  removeFile: (absolutePath: string) => Promise<void>;
  /** Resolves once the background occurrence-indexing queue has drained — for tests. */
  waitForIdle: () => Promise<void>;
}

function locationKey(location: Location): string {
  return `${location.uri}:${location.range.start.line}:${location.range.start.character}`;
}

/**
 * Wires `lsp-bridge` and `db` together: symbol/containment indexing runs eagerly per file
 * change; occurrence indexing (one `references()` call per symbol) runs off a background
 * queue, so a file's symbols are queryable immediately and its references fill in shortly
 * after, per `docs/plans/03-daemon-implementation.md`.
 */
export function createIndexer(db: Kysely<Database>, bridge: LspBridge): Indexer {
  const openedUris = new Set<string>();
  const queue: OccurrenceWork[] = [];
  let drain: Promise<void> = Promise.resolve();

  async function ensureOpen(absolutePath: string, text: string): Promise<string> {
    const uri = toFileUri(absolutePath);
    if (openedUris.has(uri)) {
      await bridge.changeDocument(uri, text);
    } else {
      await bridge.openDocument(absolutePath, text);
      openedUris.add(uri);
    }
    return uri;
  }

  async function classifyLocations(locations: Location[]): Promise<Map<string, "read" | "call">> {
    const textByUri = new Map<string, string>();
    const kinds = new Map<string, "read" | "call">();
    for (const location of locations) {
      let text = textByUri.get(location.uri);
      if (text === undefined) {
        text = await readFile(fromFileUri(location.uri), "utf8").catch(() => "");
        textByUri.set(location.uri, text);
      }
      const lineText = text.split("\n")[location.range.start.line] ?? "";
      kinds.set(locationKey(location), classifyOccurrenceKind(lineText, location.range.end.character));
    }
    return kinds;
  }

  async function processOne(item: OccurrenceWork): Promise<void> {
    const stillExists = await db
      .selectFrom("symbols")
      .select("id")
      .where("id", "=", item.symbolId)
      .executeTakeFirst();
    if (!stillExists) return; // the file was re-indexed before this item drained.

    const locations =
      (await bridge.references(item.uri, { line: item.line, character: item.character }, false)) ?? [];
    if (locations.length === 0) return;

    const kinds = await classifyLocations(locations);
    const rows = mapReferencesToOccurrences(item.symbolId, locations, (location) => {
      return kinds.get(locationKey(location)) ?? "read";
    });
    if (rows.length > 0) {
      await db.insertInto("occurrences").values(rows).execute();
    }
  }

  function scheduleDrain(): void {
    drain = drain.then(async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        await processOne(item).catch(() => undefined);
      }
    });
  }

  async function indexFile(absolutePath: string): Promise<void> {
    const text = await readFile(absolutePath, "utf8");
    const uri = await ensureOpen(absolutePath, text);
    const symbols = (await bridge.documentSymbols(uri)) as DocumentSymbol[] | null;
    const rows = mapDocumentSymbolsToRows(uri, symbols ?? []);
    await replaceFileIndex(db, uri, { symbols: rows, occurrences: [] });
    await recordFileState(db, uri);

    const stored = await db
      .selectFrom("symbols")
      .select(["id", "def_line", "def_col"])
      .where("file", "=", uri)
      .execute();
    for (const row of stored) {
      queue.push({ symbolId: row.id, uri, line: row.def_line, character: row.def_col });
    }
    scheduleDrain();
  }

  async function removeFile(absolutePath: string): Promise<void> {
    const uri = toFileUri(absolutePath);
    await replaceFileIndex(db, uri, { symbols: [], occurrences: [] });
    await db.deleteFrom("file_state").where("file", "=", uri).execute();
  }

  return {
    indexFile,
    removeFile,
    waitForIdle: () => drain,
  };
}
