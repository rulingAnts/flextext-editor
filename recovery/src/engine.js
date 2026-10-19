/* engine.js — the app's own format modules, as bundle.js uses them.
 *
 * Nothing here is ported: these are the engine's serializers, imported from docs/js and embedded
 * byte for byte by build.mjs. A recovered file is therefore written by the same code that writes
 * the app's own Save.
 */
export { serializeFlextext, segmentsFromOffsets } from '../../docs/js/flextext.js';
export { assembleSegEntries, conversionCaps, derivedWavName, mediaNameFor, sanitizeBase } from '../../docs/js/seg-exports.js';
export { makeZip } from '../../docs/js/zip.js';
