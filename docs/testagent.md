A test agent

- Uses (.gitignored) claude key in keys/claude.txt
- Also runs models hosted on OpenRouter, using the (.gitignored) key in
  keys/openrouter.txt. A `model` containing a slash (`z-ai/glm-5.3-flash`) is
  read as an OpenRouter model id and routes to OpenRouter's
  Anthropic-compatible Messages endpoint; anything else goes straight to
  Anthropic. Tool calls and prompt-cache breakpoints work over both.
- Supports prompt caching
- Invoked with `pnpm testagent [path-to-workspace-dir]`
- Has only a few tools that are explicitly specified on the command line:
  (e.g. 'pnpm testagent path --tools=grep,cli'):
  - cli - the code question agent cli
  - grep - a tool that invokes grep, should only expose
    a path filter, context lines amount (capped at 25 above and below)
    recurses by default.
  - a read tool
  - an ls tool
  - cdp - talks to a browser over the Chrome DevTools Protocol: lists
    targets, evaluates a JS expression in a page, and captures a page
    screenshot as an image
  - image - views an image file from the workspace (png, jpeg, gif, webp)
- All the tools have a maximum number of times the model may use them,
  something the model is informed off in its system prompt.
  - these limits are defined in .testagent-config.json that's
    gitignored, a .testagent-config.json.example is committed to
    this repo. a limit of -1 means unlimited.
- .testagent-config also has a field to specify which tools are enabled
- .testagent-config also has a max total token budget field (`maxTokenBudget`,
  -1 for unlimited), and fields to select the model and effort level
  (`model`, `effort`).
- .testagent-config.json is looked up in the target workspace dir first; if
  it's not there, it's looked up in the directory `pnpm testagent` was
  invoked from instead.
- The task the agent works on is passed with `--goal <text>`.
- The testagent saves session transcripts in a .testagent folder in the
  directory `pnpm testagent` was invoked from (not committed to it) — always
  there, never under the target workspace dir.
- Give the cli tool a --llm-help argument for llm optimized help
  text.
- if the cli tool is enabled its --llm-help output should be prepended
  to the system prompt.

## Images

- A tool returns either a string or a list of content blocks, so a result can
  carry an `image` block the model looks at directly. `image` and the `cdp`
  screenshot action are the two that do.
- Images are downscaled to a 1568px long edge before upload, since the API
  scales anything larger down itself and bills the scaled size. A CDP
  screenshot is scaled during capture through the clip's `scale`, so the
  full-resolution frame never crosses the wire.
- Downscaling uses `sharp`. Without it an image under the API's hard caps
  (8000px, 5MB) is sent unresized and one above them is refused, naming the
  install command.
- Base64 payloads are elided from the console log and from the session
  transcript, leaving a media type and size in their place.
- `visionCapable` in .testagent-config overrides the guess about whether
  `model` reads images. A Claude model (the default) is taken as capable and
  an OpenRouter `<vendor>/<name>` id as not, because sending an image to a
  text-only model there fails the whole request. Without vision the `image`
  tool is dropped from the session and the screenshot action is refused.
