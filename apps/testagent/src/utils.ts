const exts = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  /* defer for now
    '.py',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.java',
    '.kt',
    '.ktm',
    '.kts',
    '.go',
    '.rs',
    '.swift',
    '.sh'
    */
];
const extPattern = exts.join("|");
const regexp = new RegExp(`.*(${extPattern})$`);
export function isCode(path: string) {
  path = path.toLowerCase();
  return path.search(regexp) !== -1;
}

export function stripJSComments(text: string) {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          // preserve newlines
          out += text[i] == "\n" || text[i] === "\r" ? text[i] : "";
          i++;
        }
      }
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < n) {
          out += text.slice(i, i + 2);
          i += 2;
        } else {
          out += text[i];
          i++;
        }
      }
      if (i < n) {
        out += text[i];
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

export function stripComments(text: string, path: string) {
  return stripJSComments(text);
}

function test() {
  const test = `
/**
 * '/** */' /* \`/* */\` */
*/
a //
// b
c //
`;

  console.log(
    stripComments(test, "a.ts"),
    test.split("\n").length,
    stripComments(test, "a.ts").split("\n").length,
  );
}

export const fileCache = new Map<string, string>();
