import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { MAX_LONG_EDGE, prepareImage } from "../imaging.ts";
import { truncateResult, type Tool, type ToolBlock } from "./types.ts";

export const DEFAULT_PORT = process.env.CDP_PORT ?? 9333;
export const DEFAULT_BASE_URL =
  process.env.CDP_URL ?? `http://host.docker.internal:${DEFAULT_PORT}`;
export const TIMEOUT_MS = 15_000;

export interface CdpTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Chromium's DevTools HTTP server rejects any `Host` header that isn't `localhost` or a
 * literal IP (DNS-rebinding protection), so a name like `host.docker.internal` gets a 500
 * even though the TCP connection itself succeeds. Resolving it here rewrites the request's
 * `Host` to the literal IP the check accepts.
 */
async function resolveHostLiteral(baseUrl: string): Promise<string> {
  const url = new URL(baseUrl);
  if (url.hostname === "localhost" || isIP(url.hostname)) return baseUrl;
  // IPv4 is preferred because a link-local IPv6 address needs a zone id `fetch`/`WebSocket`
  // can't supply, and Docker Desktop's `host.docker.internal` resolves to an IPv4 address.
  const { address } = await lookup(url.hostname, { family: 4 });
  url.hostname = address;
  return url.toString().replace(/\/$/, "");
}

export async function listTargets(baseUrl: string): Promise<CdpTarget[]> {
  const resolved = await resolveHostLiteral(baseUrl);
  const res = await fetch(`${resolved}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list returned ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/**
 * Runs `body` over one websocket, so a sequence of commands shares a connection. Screenshot
 * capture needs that: its clip is computed from a `Page.getLayoutMetrics` reply, and a
 * reconnect between the two can land on a page that has since resized.
 */
async function withCdpSession<T>(
  webSocketDebuggerUrl: string,
  body: (send: CdpSend) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  const fail = (error: Error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => {
      const error = new Error(`CDP websocket error connecting to ${webSocketDebuggerUrl}`);
      reject(error);
      fail(error);
    });
    ws.addEventListener("close", () => fail(new Error("CDP websocket closed")), { once: true });
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as CdpResponse;
    if (msg.id === undefined) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  });

  const send: CdpSend = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  try {
    await opened;
    return await body(send);
  } finally {
    ws.close();
  }
}

interface RuntimeEvaluateResult {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: { text: string };
}

async function resolveDebuggerUrl(baseUrl: string, targetId: string | undefined): Promise<string> {
  const targets = await listTargets(baseUrl);
  const target = targetId
    ? targets.find((t) => t.id === targetId)
    : targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(
      targetId
        ? `no CDP target with id ${JSON.stringify(targetId)}`
        : "no CDP page target with an open websocket debugger url",
    );
  }
  return target.webSocketDebuggerUrl;
}

async function evalInTarget(
  baseUrl: string,
  targetId: string | undefined,
  expression: string,
): Promise<unknown> {
  const url = await resolveDebuggerUrl(baseUrl, targetId);
  const evaluated = (await withCdpSession(url, (send) =>
    send("Runtime.evaluate", { expression, returnByValue: true }),
  )) as RuntimeEvaluateResult;
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
  return evaluated.result?.value ?? evaluated.result?.description ?? null;
}

interface LayoutMetrics {
  cssLayoutViewport?: { clientWidth: number; clientHeight: number };
  cssContentSize?: { width: number; height: number };
  contentSize?: { width: number; height: number };
}

/**
 * Captures a page as PNG, downscaling in the browser through the capture clip's `scale` so
 * `MAX_LONG_EDGE` worth of pixels crosses the wire instead of a full-resolution frame.
 */
async function captureScreenshot(
  baseUrl: string,
  targetId: string | undefined,
  fullPage: boolean,
): Promise<Buffer> {
  const url = await resolveDebuggerUrl(baseUrl, targetId);
  return withCdpSession(url, async (send) => {
    await send("Page.enable");
    const metrics = (await send("Page.getLayoutMetrics")) as LayoutMetrics;
    const viewport = metrics.cssLayoutViewport;
    const content = metrics.cssContentSize ?? metrics.contentSize;
    const width = fullPage ? content?.width ?? 0 : viewport?.clientWidth ?? 0;
    const height = fullPage ? content?.height ?? 0 : viewport?.clientHeight ?? 0;
    if (width <= 0 || height <= 0) {
      throw new Error("Page.getLayoutMetrics reported an empty viewport");
    }
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(width, height));
    const shot = (await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
      clip: { x: 0, y: 0, width, height, scale },
    })) as { data?: string };
    if (!shot.data) throw new Error("Page.captureScreenshot returned no image data");
    return Buffer.from(shot.data, "base64");
  });
}

export const cdpTool: Tool = {
  name: "cdp",
  description:
    'Talks to a browser over the Chrome DevTools Protocol. `action: "targets"` lists open ' +
    'pages/tabs; `action: "eval"` runs a JS expression in a page via Runtime.evaluate and ' +
    'returns its value; `action: "screenshot"` captures a page as an image for you to look ' +
    `at. Connects to CDP_URL (default ${DEFAULT_BASE_URL}); pass \`baseUrl\` to override per ` +
    "call.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["targets", "eval", "screenshot"] },
      baseUrl: { type: "string", description: `CDP HTTP endpoint, e.g. ${DEFAULT_BASE_URL}.` },
      targetId: {
        type: "string",
        description: "Target id from `targets` to act on. Defaults to the first open page.",
      },
      expression: { type: "string", description: 'JS expression to evaluate (action: "eval").' },
      fullPage: {
        type: "boolean",
        description:
          'Capture the whole scrollable page rather than the viewport (action: "screenshot").',
      },
    },
    required: ["action"],
  },
  async run(input, ctx) {
    const { action, baseUrl, targetId, expression, fullPage } = input as {
      action: "targets" | "eval" | "screenshot";
      baseUrl?: string;
      targetId?: string;
      expression?: string;
      fullPage?: boolean;
    };
    const base = baseUrl ?? DEFAULT_BASE_URL;

    if (action === "targets") {
      const targets = await listTargets(base);
      const lines = targets.map((t) => `${t.id}  [${t.type}]  ${t.title}  ${t.url}`);
      return truncateResult(lines.join("\n") || "(no targets)");
    }

    if (action === "eval") {
      if (!expression) throw new Error('action "eval" requires "expression"');
      const value = await evalInTarget(base, targetId, expression);
      return truncateResult(JSON.stringify(value, null, 2));
    }

    if (action === "screenshot") {
      if (!ctx.visionCapable) {
        throw new Error(
          'refused: this session\'s model cannot read images, so action "screenshot" is ' +
            'unavailable. Use action "eval" to inspect the page as text instead.',
        );
      }
      const png = await captureScreenshot(base, targetId, fullPage ?? false);
      const { block, note } = await prepareImage(png, "image/png", "screenshot");
      const blocks: ToolBlock[] = [block, { type: "text", text: note }];
      return blocks;
    }

    throw new Error(`unknown action ${JSON.stringify(action)}`);
  },
};
