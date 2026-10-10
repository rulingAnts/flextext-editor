/* Lift named top-level declarations out of an engine file's SOURCE, so a test can run the real code
 * with its collaborators stubbed — app.js and segment-strips.js are DOM modules that cannot be
 * imported whole under node, but the functions that decide what gets written are plain code.
 *
 * Handles `function NAME(` (async and export too) and `const|let NAME =`. The scan skips strings and
 * comments, so a brace inside either cannot end a body early; it does not parse regex literals, so a
 * lifted body must not hold an unbalanced bracket inside one. */
export function liftDecl(src, name) {
  const re = new RegExp(`\\n((?:export )?(?:async )?function ${name}\\(|(?:export )?(?:const|let) ${name}\\b)`);
  const m = re.exec(src);
  if (!m) throw new Error('no top-level declaration of ' + name);
  const start = m.index + 1;
  const isFn = /function /.test(m[1]);
  let i = start, depth = 0, opened = false, paramsDone = !isFn;
  const skip = () => {   // past a string or a comment starting at i; returns true if it skipped one
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { i = src.indexOf('\n', i); if (i < 0) i = src.length; return true; }
    if (c === '/' && d === '*') { i = src.indexOf('*/', i + 2) + 2; return true; }
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      i++; return true;
    }
    return false;
  };
  if (isFn) i = src.indexOf('(', start);
  while (i < src.length) {
    if (skip()) continue;
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') {
      if (isFn && paramsDone && c === '{' && depth === 0) opened = true;
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (isFn && !paramsDone && depth === 0) paramsDone = true;
      else if (isFn && opened && depth === 0) return src.slice(start, i + 1).replace(/^export /, '');
    } else if (!isFn && c === ';' && depth === 0) return src.slice(start, i + 1).replace(/^export /, '');
    i++;
  }
  throw new Error('unterminated declaration of ' + name);
}

/** Several declarations, in order, as one block of source. */
export const liftAll = (src, names) => names.map((n) => liftDecl(src, n)).join('\n');
