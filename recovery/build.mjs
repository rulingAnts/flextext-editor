#!/usr/bin/env node
/* build.mjs — make the recovery tool ONE self-contained HTML file.
 *
 *   node recovery/build.mjs        → recovery/dist/flextext-recovery.html
 *
 * The output must open from a thumb drive (file://) on a machine with no network, so nothing may
 * be fetched: no module imports, no CDN, no fonts. Every ES module the page needs — this folder's
 * readers AND the engine's own docs/js format modules — is wrapped in a function scope and inlined
 * into one <script>. The engine modules go in unchanged apart from that wrapping, which is what lets
 * bundle.js claim the XML is the app's own.
 *
 * Deliberately not esbuild or rollup: this repo has no package.json and no build step, and a
 * recovery tool is the last thing that should depend on fetching one. The module forms this
 * understands are exactly the ones these files use, and it FAILS on anything else rather than
 * emitting a page that breaks on the laptop.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ENTRY = resolve(HERE, 'src/ui.js');
const TEMPLATE = resolve(HERE, 'index.html');
// The committed copy is what the researcher panel downloads (via jsDelivr). A path argument builds
// elsewhere, which is how the test compares a fresh build with the committed one.
const OUT = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, 'dist/flextext-recovery.html');

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm;
const REEXPORT_RE = /^export\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(async\s+function\*?|function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

const names = (list) => list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(s);
  if (!m) throw new Error(`cannot bundle the import/export specifier "${s}"`);
  return { from: m[1], to: m[2] || m[1] };
});

const modules = new Map();          // absolute path → { id, code, deps }
function load(path) {
  if (modules.has(path)) return modules.get(path);
  const src = readFileSync(path, 'utf8');
  const id = `__m${modules.size}`;
  const mod = { id, path, deps: [], code: '' };
  modules.set(path, mod);
  const exported = [];
  let code = src.replace(IMPORT_RE, (_, list, spec) => {
    const dep = load(resolve(dirname(path), spec));
    mod.deps.push(dep);
    return `const { ${names(list).map((n) => n.from === n.to ? n.from : `${n.from}: ${n.to}`).join(', ')} } = ${dep.id};`;
  });
  code = code.replace(/^import\s*\*\s*as\s+([\w$]+)\s+from\s*'([^']+)';?[ \t]*$/gm, (_, local, spec) => {
    const dep = load(resolve(dirname(path), spec));
    mod.deps.push(dep);
    return `const ${local} = ${dep.id};`;
  });
  code = code.replace(REEXPORT_RE, (_, list, spec) => {
    const dep = load(resolve(dirname(path), spec));
    mod.deps.push(dep);
    for (const n of names(list)) exported.push(`${n.to}: ${dep.id}.${n.from}`);
    return '';
  });
  code = code.replace(EXPORT_DECL_RE, (_, kind, name) => { exported.push(name); return `${kind} ${name}`; });
  const left = /^\s*(import|export)\b.*$/m.exec(code);
  if (left) throw new Error(`${relative(ROOT, path)}: unsupported module syntax: ${left[0].trim()}`);
  if (/\bimport\s*\(/.test(code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) {
    throw new Error(`${relative(ROOT, path)}: dynamic import() cannot work from a file:// page`);
  }
  mod.code = code;
  mod.exported = exported;
  return mod;
}

load(ENTRY);

// Dependencies first.
const order = [];
const seen = new Set();
(function visit(m) {
  if (seen.has(m)) return;
  seen.add(m);
  for (const d of m.deps) visit(d);
  order.push(m);
})(modules.get(ENTRY));

const engineVersion = /export const ENGINE_VERSION = '([^']+)'/.exec(readFileSync(resolve(ROOT, 'docs/js/i18n.js'), 'utf8'))[1];

let js = `const __RECOVERY_ENGINE_VERSION = ${JSON.stringify(engineVersion)};\n`;
for (const m of order) {
  js += `\n// ---- ${relative(ROOT, m.path)} ----\nconst ${m.id} = (() => {\n${m.code}\nreturn { ${m.exported.join(', ')} };\n})();\n`;
}
// Inside a <script>, "</script" anywhere — even in a string — ends the element. In JS strings,
// template literals and regexes "<\/" means the same as "</", so this escape changes nothing else.
js = js.replace(/<\/script/gi, '<\\/script');
if (/<!--/.test(js)) throw new Error('"<!--" in the bundle would put the HTML parser into escaped script mode');

const html = readFileSync(TEMPLATE, 'utf8');
if (!html.includes('<!--BUNDLE-->')) throw new Error('index.html has no <!--BUNDLE--> marker');
const out = html
  .replace('<!--BUNDLE-->', () => `<script type="module">\n${js}</script>`)
  .replace(/__ENGINE_VERSION__/g, engineVersion);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`wrote ${relative(ROOT, OUT)} (${(out.length / 1024).toFixed(0)} KB, engine ${engineVersion}, ${order.length} modules)`);
