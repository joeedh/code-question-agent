A test agent 

* Uses (.gitignored) claude key in keys/claude.txt
* Supports prompt caching
* Invoked with `pnpm testagent [path-to-workspace-dir]`
* Has only a few tools that are explicitly specified on the command line:
  (e.g. 'pnpm testagent path --tools=grep,cli'):
  - cli - the code question agent cli
  - grep - a tool that invokes grep, should only expose 
    a path filter, context lines amount (capped at 25 above and below)
    recurses by default.
  - a read tool
  - an ls tool
* All the tools have a maximum number of times the model may use them,
  something the model is informed off in its system prompt.
  - these limits are defined in .testagent-config.json that's
    gitignored, a .testagent-config.json.example is committed to 
    this repo.  a limit of -1 means unlimited.
* .testagent-config also has a field to specify which tools are enabled
* The testagent saves session transcripts in .testagent
  inside the repo (but not committed to it).
* Give the cli tool a --llm-help argument for llm optimized help 
  text.
* if the cli tool is enabled its --llm-help output should be prepended 
  to the system prompt.
