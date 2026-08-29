# Ideas

Tool for llm querying of codebases, interfaces with LSP servers.
All queries can search both for an exact symbol and also a
regexp used to search all symbols matching it.

## Potetial Example

example of potential usage:

```
== path/to/file:32-37:ref:call: ==
  inside (script root)
32: bleh
33: a line
34: some_regexp();
36: final line
37: last line
== path/to/file2:15-20:pref:call ==
  inside SomeClass.Bleh.closure1
15:
16: const closure1 = (arg: baseFunctionInterface) => {
17:   arg();
18: }
19:

```

a `--json` form:

```
node cli.js --query regexp "/some_.*" --what-refs --include-line \
  --exclude-column --context-lines 2 --search-castable-types
  --include-class-trace src/**.ts

some_regexp {
  references: {
    file: "path/to/file",
    line: 10,
    snippet: "some_thing()" with 2 context lines above and below,
    type: "function call"
  }
},
baseFunctionInterface: {
  file: "path/to/file",
  line: 10,
  snippet: "castedFunction()" with 2 context lines above and below,
  type: "possible function call"
}
```

notes:

- the `--include-class-trace` flag includes a lexical call trace in the
  result, shown above as 'inside SomeClass.Bleh.closure1'.
- the `--context-lines` flag controls how much context is shown around the
  search result
