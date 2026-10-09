/* TWO REAL TIMING SKELETONS, rebuilt line for line — the .flextext files this suite wrote before
 * every timed phrase carried a media-file link (test/flex-media-link.test.mjs).
 *
 * WHERE THEY CAME FROM. Two real segmented texts (18 and 29 lines), exported by the editor's own
 * serializer: a <media-files> block from ensureMediaRef, a begin/end-time-offset on every phrase, a
 * visible "audio 0:00.000–0:01.748" note — and not one media-file attribute, which is the shape FLEx
 * imports with every time thrown away. What survives here is only the SHAPE: the paragraph and
 * phrase structure, the real offsets, which lines are blank (timed silence), which carry a free
 * translation or an estimated boundary, how many words and glosses each line has, the punctuation
 * tokens, and the two quirks a real file had (a phrase guid repeated after a split; a baseline token
 * count that differs from the word list). Every word is "w", every gloss "g", every free translation
 * "ft"; there is no title, no speaker, no language text; the recording is "recording.wav" (the real
 * files named a Drive relay URL); and every guid is re-minted by the scheme below, so nothing here
 * identifies a text, a person or a FLEx project.
 *
 * WHY A BUILDER AND NOT A FILE. Fixtures live in the .mjs in this repo, and the rows are 2 KB where
 * the files were 55. The builder writes the SAME bytes the sanitized files hold — checked when it
 * was made, by rebuilding both and comparing them to the sanitized originals byte for byte.
 *
 * A row is [begin ms, end ms, baseline token count, words, flags, phrase-guid-of-row?]:
 *   words  space-separated, one per <word>: 'g' = word + gloss, 'w' = word alone, anything else is a
 *          punctuation token, written as itself;
 *   flags  'f' = the line has a free translation, '~' = its boundary is estimated (the note's '~');
 *   6th    present when this phrase REUSES an earlier row's phrase guid (a real file did). */

const SKELETONS = {
  lines18: [[0,1748,0,'',''],[1748,4184,6,'g g g g g g','f'],[4184,5433,0,'',''],[5433,6837,5,'g g g g g','f'],[6837,9049,9,'g g g g g g g g g','f'],[9049,10053,0,'',''],[10053,11748,6,'g g g g g g','f',4],[11748,13265,0,'',''],[13265,14872,6,'g g g g g g ?','f'],[14872,17065,0,'',''],[17065,18923,9,'g g g g g g g g g','f'],[18923,19398,0,'',''],[19398,20179,3,'g g g','f'],[20179,23387,0,'',''],[23387,24162,2,'g g','f'],[24162,24740,0,'',''],[24740,25525,3,'g g g','f'],[25525,25797,0,'','']],
  lines29: [[0,2675,3,'g g g','f'],[2675,5720,6,'g g g g g g','f'],[5720,5840,0,'','~'],[5840,6975,5,'g g g g w','f~'],[6975,8018,4,'w w w w',''],[8018,9446,5,'w w w w w','',4],[9446,13948,8,'g g g g g g g g','f'],[13948,17083,7,'g g g g g g g','f'],[17083,19915,5,'g g g g g','f'],[19915,20739,3,'g g g','f~'],[20739,21945,7,'g g g g g g g','f~',9],[21945,23907,2,'g g','f'],[23907,24573,4,'g g g g','f~'],[24573,25447,6,'w w w w w w','~',12],[25447,26244,3,'w w w',''],[26244,27920,4,'w w w w',''],[27920,29698,3,'w w w',''],[29698,30996,6,'w w w w w w',''],[30996,32399,4,'w w w w',''],[32399,34718,6,'w w w w w w',''],[34718,37127,2,'w w .. w',''],[37127,39421,4,'w w w w',''],[39421,40694,4,'w w w w',''],[40694,43300,6,'w w w w w w','~'],[43300,44603,3,'w w w','~',23],[44603,46418,6,'w w w w w w',''],[46418,47332,4,'w w w w',''],[47332,48803,4,'w w w w',''],[48803,50879,2,'w w','']],
};

// Deterministic, well-formed guids: kind 0 text, 1 paragraph, 2 phrase, 3 word, 4 media.
export const skelGuid = (kind, n) => `00000000-0000-4000-8${kind}00-${String(n).padStart(12, '0')}`;
export const SKELETON_MEDIA_GUID = skelGuid(4, 0);
export const skeletonNames = () => Object.keys(SKELETONS);

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;

/* The .flextext exactly as the pre-fix serializer wrote it (segnum items and all — this is what is
 * sitting in Drive folders and on disks today). `timedRows(name)` gives the rows for assertions. */
export function skeletonXml(name) {
  const rows = SKELETONS[name];
  if (!rows) throw new Error('no skeleton ' + name);
  const L = ['<?xml version="1.0" encoding="utf-8"?>', '<document version="2">',
    `  <interlinear-text guid="${skelGuid(0, 0)}">`, '    <item type="title" lang="id">Timing skeleton</item>',
    '    <paragraphs>'];
  let w = 0;
  rows.forEach(([b, e, nBase, words, flags, sameAs], i) => {
    L.push(`      <paragraph guid="${skelGuid(1, i)}">`, '        <phrases>',
      `          <phrase guid="${skelGuid(2, sameAs ?? i)}" begin-time-offset="${b}" end-time-offset="${e}">`,
      `            <item type="txt" lang="fau">${Array(nBase).fill('w').join(' ')}</item>`,
      `            <item type="segnum" lang="id">${i + 1}</item>`, '            <words>');
    for (const tok of words ? words.split(' ') : []) {
      L.push(`              <word guid="${skelGuid(3, w++)}">`);
      if (tok === 'g' || tok === 'w') {
        L.push('                <item type="txt" lang="fau">w</item>');
        if (tok === 'g') L.push('                <item type="gls" lang="id">g</item>');
      } else L.push(`                <item type="punct" lang="fau">${tok}</item>`);
      L.push('              </word>');
    }
    L.push('            </words>');
    if (flags.includes('f')) L.push('            <item type="gls" lang="id">ft</item>');
    L.push(`            <item type="note" lang="id">audio ${flags.includes('~') ? '~' : ''}${clock(b)}–${clock(e)}</item>`,
      '          </phrase>', '        </phrases>', '      </paragraph>');
  });
  L.push('    </paragraphs>', '    <languages>', '      <language lang="fau" vernacular="true" />',
    '      <language lang="id" />', '    </languages>', '    <media-files offset-type="milliseconds">',
    `    <media guid="${SKELETON_MEDIA_GUID}" location="recording.wav" />`, '    </media-files>',
    '  </interlinear-text>', '</document>');
  return L.join('\n') + '\n';
}

export const timedRows = (name) => SKELETONS[name].map(([begin, end]) => ({ begin, end }));
