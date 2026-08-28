import { type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  type Definition,
  type DocumentSymbol,
  type Hover,
  type InitializeResult,
  InitializeRequest,
  InitializedNotification,
  type Location,
  type LocationLink,
  type Position,
  type ProtocolConnection,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentSymbolRequest,
  ExitNotification,
  HoverRequest,
  ReferencesRequest,
  ShutdownRequest,
  type SymbolInformation,
} from "vscode-languageserver-protocol/node";
import { spawnLspServer } from "./process.ts";
import { toFileUri } from "./uri.ts";

export interface LspBridgeOptions {
  /** Path to the `tsc` binary built from the TypeScript checkout, e.g. `tsc.exe --lsp --stdio`. */
  tscPath: string;
  /** Workspace root the server should treat as its project root. */
  rootDir: string;
}

/** Tracks the open-document version numbers the bridge itself assigns. */
class OpenDocuments {
  private versions = new Map<string, number>();

  open(uri: string): number {
    this.versions.set(uri, 1);
    return 1;
  }

  bump(uri: string): number {
    const next = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, next);
    return next;
  }
}

/** Drives a real TypeScript LSP server (`tsc --lsp --stdio`) over stdio. */
export class LspBridge {
  private readonly connection: ProtocolConnection;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<number | null>;
  private readonly documents = new OpenDocuments();
  private readonly rootDir: string;
  private capabilities: InitializeResult["capabilities"] | undefined;

  constructor(options: LspBridgeOptions) {
    const handle = spawnLspServer(options.tscPath, options.rootDir);
    this.connection = handle.connection;
    this.process = handle.process;
    this.exited = handle.exited;
    this.rootDir = options.rootDir;
  }

  /** Runs the `initialize`/`initialized` handshake and records the server's capabilities. */
  async initialize(): Promise<InitializeResult> {
    const result = await this.connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: toFileUri(this.rootDir),
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
      },
    });
    this.capabilities = result.capabilities;
    await this.connection.sendNotification(InitializedNotification.type, {});
    return result;
  }

  /** The capabilities the server reported in its `initialize` response. */
  getCapabilities(): InitializeResult["capabilities"] {
    if (!this.capabilities) {
      throw new Error("initialize() has not completed yet");
    }
    return this.capabilities;
  }

  async openDocument(filePath: string, text: string, languageId = "typescript"): Promise<string> {
    const uri = toFileUri(filePath);
    const version = this.documents.open(uri);
    await this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId, version, text },
    });
    return uri;
  }

  /** Replaces a document's whole text, as opposed to an on-disk edit the watcher would pick up. */
  async changeDocument(uri: string, text: string): Promise<void> {
    const version = this.documents.bump(uri);
    await this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  async definition(uri: string, position: Position): Promise<Definition | LocationLink[] | null> {
    return this.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position,
    });
  }

  async references(
    uri: string,
    position: Position,
    includeDeclaration = true,
  ): Promise<Location[] | null> {
    return this.connection.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
  }

  async hover(uri: string, position: Position): Promise<Hover | null> {
    return this.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position,
    });
  }

  async documentSymbols(uri: string): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    return this.connection.sendRequest(DocumentSymbolRequest.type, {
      textDocument: { uri },
    });
  }

  /** Sends a request by raw method name, bypassing the typed helpers above. */
  async sendRawRequest<R>(method: string, params: unknown): Promise<R> {
    return this.connection.sendRequest(method, params);
  }

  /** Runs the `shutdown`/`exit` sequence and waits for the process to exit. */
  async dispose(): Promise<void> {
    try {
      await this.connection.sendRequest(ShutdownRequest.type);
      await this.connection.sendNotification(ExitNotification.type);
    } finally {
      this.connection.dispose();
      if (!this.process.killed) {
        this.process.kill();
      }
      await this.exited;
    }
  }
}
