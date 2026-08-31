import { truncateResult, type Tool } from "./types.ts";

const DEFAULT_BASE_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const TIMEOUT_MS = 15_000;

interface CdpTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl?: string;
}

async function listTargets(baseUrl: string): Promise<CdpTarget[]> {
  const res = await fetch(`${baseUrl}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list returned ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

function sendCdpCommand(
  webSocketDebuggerUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP command ${method} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as CdpResponse;
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`CDP websocket error connecting to ${webSocketDebuggerUrl}`));
    });
  });
}

interface RuntimeEvaluateResult {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: { text: string };
}

async function evalInTarget(
  baseUrl: string,
  targetId: string | undefined,
  expression: string,
): Promise<unknown> {
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
  const evaluated = (await sendCdpCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as RuntimeEvaluateResult;
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
  return evaluated.result?.value ?? evaluated.result?.description ?? null;
}

export const cdpTool: Tool = {
  name: "cdp",
  description:
    'Talks to a browser over the Chrome DevTools Protocol. `action: "targets"` lists open ' +
    'pages/tabs; `action: "eval"` runs a JS expression in a page via Runtime.evaluate and ' +
    `returns its value. Connects to CDP_URL (default ${DEFAULT_BASE_URL}); pass \`baseUrl\` ` +
    "to override per call.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["targets", "eval"] },
      baseUrl: { type: "string", description: `CDP HTTP endpoint, e.g. ${DEFAULT_BASE_URL}.` },
      targetId: {
        type: "string",
        description: "Target id from `targets` to eval in. Defaults to the first open page.",
      },
      expression: { type: "string", description: 'JS expression to evaluate (action: "eval").' },
    },
    required: ["action"],
  },
  async run(input) {
    const { action, baseUrl, targetId, expression } = input as {
      action: "targets" | "eval";
      baseUrl?: string;
      targetId?: string;
      expression?: string;
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

    throw new Error(`unknown action ${JSON.stringify(action)}`);
  },
};

const t = await listTargets(DEFAULT_BASE_URL);
console.log(t)