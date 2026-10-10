/* db.js storableRecord — the one storage chokepoint (v718) — lifted from the SOURCE with the real
 * segments.js storableSegments in scope. Importing db.js itself under node is not an option: it opens
 * a BroadcastChannel at load, which holds node's event loop open and hangs the run. What is tested is
 * still the code that ships (test/lib/lift.mjs). */
import { readFileSync } from 'node:fs';
import { liftDecl } from './lift.mjs';
import { storableSegments } from '../../docs/js/segments.js';

export const DB_SRC = readFileSync(new URL('../../docs/js/db.js', import.meta.url), 'utf8');
export const storableRecord = new Function('storableSegments',
  `${liftDecl(DB_SRC, 'storableRecord')}; return storableRecord;`)(storableSegments);
