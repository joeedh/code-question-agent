# CDP Setup: devcontainer → Windows Electron shell

How the `apps/electronshell` app and the testagent `cdp` tool
(`apps/testagent/src/tools/cdp.ts`) reach each other across the
devcontainer/WSL2/Windows boundary, and the Windows Firewall rule that's
required for it.

## Topology

- `apps/electronshell` runs natively on **Windows**, listening for Chrome
  DevTools Protocol connections on `0.0.0.0:9333` (`CDP_PORT` env var to
  override; see `apps/testagent/src/tools/cdp.ts`'s `DEFAULT_PORT`).
- The devcontainer runs under **Docker Desktop** (confirm with
  `docker context ls` — this project's setup uses the `desktop-linux`
  context). Docker Desktop injects `host.docker.internal` into every
  container, resolving to the real Windows host.
- `.devcontainer/devcontainer.json`'s `runArgs` intentionally does **not**
  set `--network=host` — under Docker Desktop that would attach to the
  `docker-desktop` VM's network namespace instead of Windows, which breaks
  `host.docker.internal` resolution for no benefit.

## Windows Firewall rule

Chromium/Electron's DevTools port only accepts connections that clear
Windows Firewall first. Add an inbound rule for the CDP port (run as
Administrator):

```powershell
New-NetFirewallRule -DisplayName "WSL CDP 9333" -Direction Inbound -Protocol TCP -LocalPort 9333 -Action Allow -Profile Private
```

Or via the GUI:

1. `Win+R` → `wf.msc` → Enter
2. Inbound Rules → New Rule → **Port**
3. TCP, Specific local port: `9333`
4. Allow the connection
5. Apply to Private (and Domain if relevant) — skip Public unless needed
6. Name it `WSL CDP 9333`

Without this rule, a connection from the container's `host.docker.internal`
address (a real Windows-facing IP, not loopback) times out/refuses even
though `127.0.0.1:9333` works fine from Windows itself.

## Chromium's Host-header check

Getting past the firewall isn't sufficient on its own. Chromium's DevTools
HTTP server (`/json/*` endpoints) rejects any request whose `Host` header
isn't `localhost` or a literal IP address — a DNS-rebinding protection. A
request with `Host: host.docker.internal` gets a **500** even though the TCP
connection succeeds:

```
500 Host header is specified and is not an IP address or localhost.
```

`cdp.ts`'s `resolveHostLiteral()` works around this: before every request it
resolves the base URL's hostname to a literal IPv4 address via
`dns/promises.lookup(hostname, { family: 4 })` and rewrites the request URL
to use that IP instead of the hostname. `localhost` and URLs that are
already IP literals skip resolution. IPv4 is requested explicitly because a
bare `lookup()` can return a link-local IPv6 address that needs a zone id
neither `fetch` nor `WebSocket` can supply.

## Electron startup flags

`apps/electronshell/src/index.ts` sets, before `app` becomes ready:

- `--remote-debugging-port=$CDP_PORT` (default `9333`)
- `--remote-debugging-address=0.0.0.0` — binds all interfaces, not just
  loopback, since the devcontainer's `host.docker.internal` connection
  isn't loopback from Windows's point of view.

## Security note

`--remote-debugging-address=0.0.0.0` plus an open firewall port exposes the
DevTools protocol to anything that can reach it on the network — CDP has no
authentication, so that's full browser control (arbitrary JS execution,
file:// reads). Scope the firewall rule's profile to Private, and don't run
this shell on an untrusted network.

## Quick verification

From Windows, with the shell running:

```bash
curl http://127.0.0.1:9333/json/version   # 200, confirms the shell is up
```

From inside the devcontainer, once the firewall rule is in place:

```bash
curl http://host.docker.internal:9333/json/version
```

A `500 Host header...` response here means the container is reaching
Windows fine and the client just needs to hit the endpoint by IP instead of
hostname — which is what the testagent `cdp` tool does automatically.
