/* i18n.js — UI localization (English / Indonesian).
 * Language is auto-detected from the browser, can be overridden by the user
 * (persisted), and can arrive via the setup link (?lang=id).
 */

const LANG_KEY = 'flextext-lang';
export const LANGS = ['en', 'id'];

const S = {
en: {
  'tabs.texts': 'Texts',
  'tabs.research': 'Settings',
  'tabs.baseline': 'Baseline',
  'tabs.gloss': 'Gloss',
  'btn.saveSend': 'Save and send…',
  'btn.back': 'Back to texts',
  'btn.help': 'Help',
  'help.close': '← Back',

  'texts.new': '+ New text',
  'texts.newAudio': '+ New text from audio…',
  'record.btn': 'Record new text…',
  'record.title': 'Record new text',
  'record.start': '● Record',
  'record.stop': '■ Stop',
  'record.save': 'Save',
  'record.redo': 'Re-record',
  'record.idle': 'Press Record and speak. You can listen and re-record before saving.',
  'record.recording': 'Recording… {time}',
  'record.review': 'Listen to check the recording, then Save — or Re-record and try again.',
  'record.converting': 'Saving recording… {pct}%',
  'record.micError': 'Could not use the microphone: {msg}',
  'record.noAudio': 'No sound was recorded — please try again.',
  'record.clipWarn': '⚠ Too loud — move back a little.',
  'record.distanceHint': 'Hold the phone about a hand\'s width from your mouth.',
  'record.gainLabel': 'Recording level',
  'record.fellBack': '⚠ This browser can\'t record lossless audio, so this take was saved as compressed MP3. For archival WAV/FLAC, use a recent Chrome, Edge, or Firefox.',
  'record.titleLabel': 'Title for this text',
  'record.titlePh': 'Give this recording a name',
  'record.appName': 'Flextext Recorder',
  'record.welcomeDefault': 'Record {lang} texts here.',
  'record.savedH': 'Your recordings',
  'record.empty': 'No recordings yet. Tap Record to make one.',
  'record.send': 'Send',
  'record.saved': 'Recording saved.',
  'record.sentRemoved': 'Sent to Google Drive — removed from this device: {name}',
  'recordlink.h': 'Phone Recording link',
  'recordlink.note': 'Make a link that opens a stripped-down <em>recording-only</em> app on a coworker\'s phone — no editor, no glossing, just record and send. They can install it as a separate app ("Flextext Recorder") and keep many recordings offline. The speaker-permission step and Drive upload folder you set above also apply here.',
  'recordlink.welcome': 'Welcome message / heading (shown on the phone — include the language name)',
  'recordlink.welcomePh': 'e.g. Record Fayu stories here',
  'recordlink.needWelcome': 'Type a welcome message first — it appears on the coworker\'s phone and should name the language.',
  'recordlink.whatsapp': '⚠ Audio sent through WhatsApp is recompressed and loses quality, even inside a zip. Prefer Upload to Google Drive.',
  'buttons.legend': 'Buttons on the coworker\'s Texts screen',
  'buttons.note': 'These travel with your setup/task links and decide which "new text" buttons the coworker sees on their Texts screen. (Texts can still arrive through a task link even with all buttons off.)',
  'recordlink.copy': 'Copy Phone Recording link',
  'recformat.h': 'Recording format',
  'recformat.note': 'How new recordings are captured — here and on any phone you send a recording link to. Recordings are your primary data, so record lossless (<b>WAV</b>) and keep it that way; they\'re captured <b>raw</b>, with no automatic gain or noise processing. Lossless needs a recent Chrome, Edge, or Firefox; elsewhere it falls back to MP3 with a warning.',
  'recformat.label': 'Format for new recordings',
  'recformat.wav24': 'WAV · 24-bit (recommended)',
  'recformat.wav16': 'WAV · 16-bit (smaller)',
  'recformat.wav32': 'WAV · 32-bit float (expert — pro hardware)',
  'recformat.flac24': 'FLAC · 24-bit (lossless, smaller — for limited bandwidth)',
  'recformat.mp3': 'MP3 (compressed — not for archiving)',
  'recformat.gainToggle': 'Show a recording-level (gain) slider while recording',
  'recformat.gainNote': 'Off by default — recordings capture the raw microphone level. Turn this on to let a too-quiet or too-loud device be adjusted.',
  'recfmt.helpLink': 'Which format should I choose?',
  'recfmt.helpTitle': 'Choosing a recording format',
  'recfmt.helpKeep': '<b>Record in WAV, and keep it in WAV.</b> Your recordings are primary research data — what an archive preserves, and what any future acoustic or phonetic analysis depends on. Record at archive quality from the start; don\'t plan to record in one format and convert it later.',
  'recfmt.helpRaw': '<b>Faithful, unprocessed capture.</b> Browsers normally apply automatic gain, noise reduction, and echo cancellation to microphone audio — this app switches all three off, so the lossless formats capture the raw signal with nothing added or removed. The only thing that can change the level is the optional recording-level slider, if a researcher turns it on.',
  'recfmt.helpBits': '<b>Bit depth — 24-bit is the default.</b> 24-bit WAV captures everything a phone microphone can actually produce, and is the depth archives expect. <b>16-bit</b> is smaller and perfectly fine for speech on modest devices. <b>32-bit float</b> is available but <b>not recommended on a phone</b>: its one real advantage — being impossible to clip — needs professional field-recorder hardware that phones don\'t have (and a browser can\'t pass that headroom through anyway), and 32-bit float isn\'t standard archival PCM, so <b>many archives reject it</b>. Use it only when you know a professional audio interface is feeding the recording.',
  'recfmt.helpWavFlac': '<b>WAV vs FLAC.</b> Both are lossless and identical in quality. <b>WAV</b> is the universal archival format, accepted everywhere. <b>FLAC</b> is lossless too and about half the size, which can help when upload bandwidth is very limited — but most archives don\'t accept FLAC for deposit, so you\'d have to convert it back to WAV, against the "record one format and keep it" rule. Prefer WAV; reach for FLAC only when limited data really forces it.',
  'recfmt.helpMono': '<b>Always mono.</b> A single voice through a single microphone gains nothing from stereo, which would only double the file size. This app always records and sends mono.',
  'recfmt.helpRate': '<b>Sample rate.</b> Recordings use the device\'s native rate (usually 48 kHz) — well beyond what speech or tone needs. There is nothing to set.',
  'recfmt.helpMp3': '<b>MP3 — not for archiving.</b> MP3 is lossy: it permanently throws away audio data, and no archive accepts it for preservation. It is only defensible for quick brainstorming, for collecting material you plan to have re-recorded properly later, or when storage and bandwidth are severely limited.',
  'recfmt.helpArchives': '<b>Check your archive.</b> Requirements vary a little between archives, but <b>record 24-bit WAV at 48 kHz, mono, and you satisfy every major one below.</b> (16-bit is also accepted by several; 96 kHz is only the strictest preservation tier — and phones cannot reach it.)',
  'recfmt.helpTable': '<div class="help-scroll"><table class="archive-table"><thead><tr><th>Archive</th><th>Format</th><th>Bit depth / rate</th><th>FLAC</th><th>Source</th></tr></thead><tbody><tr><td>Library of Congress</td><td>uncompressed Broadcast WAVE</td><td>24-bit / 96 kHz preferred; 16-bit / 44.1 kHz floor</td><td>not named</td><td><a href="https://www.loc.gov/preservation/resources/rfs/audio.html" target="_blank" rel="noopener noreferrer">loc.gov</a></td></tr><tr><td>PARADISEC</td><td>uncompressed WAV</td><td>24-bit / 96 kHz target; 48 kHz accepted</td><td>not listed</td><td><a href="https://www.paradisec.org.au/deposit/file-formats/" target="_blank" rel="noopener noreferrer">paradisec.org.au</a></td></tr><tr><td>ELAR</td><td>uncompressed WAV</td><td>not published (16-bit min; 48 kHz / 24-bit in practice)</td><td>unstated</td><td><a href="https://www.elararchive.org/deposit-with-elar/" target="_blank" rel="noopener noreferrer">elararchive.org</a></td></tr><tr><td>FADGI (US federal)</td><td>WAVE / BWF, LPCM</td><td>24-bit / 96 kHz; 48 kHz tolerated</td><td>no</td><td><a href="https://www.digitizationguidelines.gov/guidelines/digitize-audio.html" target="_blank" rel="noopener noreferrer">digitizationguidelines.gov</a></td></tr><tr><td>AILLA (UT Austin)</td><td>WAV (MP3 also allowed)</td><td>24-bit; 16-bit min; 44.1 kHz</td><td>no</td><td><a href="https://guides.lib.utexas.edu/ailla/deposit" target="_blank" rel="noopener noreferrer">guides.lib.utexas.edu</a></td></tr><tr><td>The Language Archive (MPI Nijmegen)</td><td>uncompressed WAV PCM</td><td>16 or 24-bit / 44.1 or 48 kHz</td><td>no</td><td><a href="https://archive.mpi.nl/accepted-file-formats" target="_blank" rel="noopener noreferrer">archive.mpi.nl</a></td></tr><tr><td>SIL — REAP / RAMP</td><td>uncompressed WAV / PCM</td><td>not mandated (16 or 24-bit)</td><td>unstated</td><td><a href="https://reap.sil.org/" target="_blank" rel="noopener noreferrer">reap.sil.org</a></td></tr></tbody></table></div>',
  'recfmt.helpCourse': 'New to archiving field recordings? AILLA\'s free course <a href="https://archivingforthefuture.teachable.com/" target="_blank" rel="noopener noreferrer">Archiving for the Future</a> walks through formats and workflows for language documentation.',
  'recfmt.helpClose': 'Close',
  'consent.legend': 'Speaker permission before recording',
  'consent.mode': 'When the coworker records a new text, first ask…',
  'consent.modeOff': "Don't ask anything",
  'consent.modeText': 'Show a written reminder',
  'consent.modeAudio': 'Play a spoken reminder (audio)',
  'consent.msg': 'Written reminder shown to the coworker',
  'consent.audioUrl': 'Spoken reminder audio (Drive share link or direct MP3 URL)',
  'consent.resp': 'How the coworker confirms',
  'consent.respYesNo': 'Tap Yes / No',
  'consent.respRecord': 'Record the speaker saying yes (kept in the bundle)',
  'consent.respSignature': 'Type the speaker\'s name as a signature',
  'consent.signLabel': 'Type your name to give permission',
  'consent.signBtn': 'Sign & continue',
  'consent.needName': 'Please type your name first.',
  'consent.note': 'This reminder appears on the coworker\'s device before each new recording. Every consent is logged in a consent-receipt file (with the date, the exact prompt shown, the device\'s IP when online, and an approximate location if the speaker allows it — asked just once at first use) bundled with the text. A recorded "yes" or typed signature is saved alongside it, and for a spoken prompt a copy of the exact recording the speaker heard is bundled too — so the question and the answer can be verified side by side even after you later refine the prompt.',
  'consent.title': 'Speaker permission',
  'consent.yes': 'Yes — I have permission',
  'consent.no': 'No',
  'consent.recYes': 'Record the "yes"',
  'consent.recStop': 'Stop',
  'consent.continue': 'Continue',
  'consent.assentReview': 'Listen to check, then Continue — or Re-record.',
  'consent.declined': 'Recording needs the speaker\'s permission. Ask first, then try again.',
  'consent.loadingAudio': 'Loading the spoken reminder…',
  'consent.audioFailed': 'Could not load the spoken reminder. You can still continue.',
  'texts.open': 'Open .flextext file…',
  'texts.empty': 'No texts yet. Tap <b>New text</b> to start transcribing, or open an existing <code>.flextext</code> file.',
  'texts.deleteTitle': 'Delete',
  'texts.confirmDelete': 'Delete "{title}" from this device?\n(Make sure it has been saved/sent if you need it.)',
  'texts.meta': '{n} sentences · {g} glossed · {date}',
  'untitled': 'Untitled text',

  'banner.set': 'Writing systems: {vern} → {anal}',
  'banner.unset': 'No writing systems set yet — new texts will use placeholder codes. Ask your researcher for a setup link, or use the <b>Settings</b> tab.',

  'baseline.hint': 'Type or paste the text. Press <b>Enter</b> for a new paragraph. Sentences are split automatically at <code>. ! ?</code>',
  'baseline.placeholder': 'Type the text here in the vernacular language…',

  'gloss.empty': 'Nothing to gloss yet — enter the text on the <b>Baseline</b> tab first.',
  'gloss.wordLabel': 'Word',
  'gloss.glossLabel': 'Gloss',
  'gloss.freeLabel': 'Free',
  'gloss.freePlaceholder': 'Free translation…',
  'gloss.chainTitle': 'Merge these two words into one phrase',
  'gloss.confirmMerge': 'Join "{a}" and "{b}" together into one unit (phrase)?\nThey will share a single meaning. You can separate them again with "✂ break".',
  'gloss.breakLabel': '✂ break',
  'gloss.breakTitle': 'Break this phrase back into separate words',

  'share.title': 'Save and send',
  'share.share': 'Share…',
  'share.upload': 'Upload',
  'share.saveas': 'Save to file…',
  'share.download': 'Download',
  'share.cancel': 'Cancel',

  'upload.starting': 'Preparing the upload…',
  'upload.progress': 'Uploading {name}… {pct}% ({got} of {size} MB)',
  'upload.working': 'Uploading {name}… please wait.',
  'upload.paused': 'Upload paused — {pct}% sent. It will continue from here.',
  'upload.error': 'Upload problem: {msg}',
  'upload.done': 'Uploaded to Google Drive: {name}',
  'upload.retry': 'Retry',
  'upload.cancel': 'Cancel the upload',
  'upload.more': '{n} more waiting',
  'upload.waiting': '{n} file(s) waiting to upload — they will send automatically when you are online.',
  'upload.retrying': '{n} file(s) waiting to upload — will retry shortly.',
  'upload.pausedSummary': 'Paused: {name}',
  'upload.sendNow': 'Send now',
  'upload.pause': 'Pause',
  'upload.resume': 'Resume',
  'upload.queuedToast': 'Added to the upload queue — it will send when you are online.',
  'upload.uploadingShort': 'Sending…',
  'upload.queuedShort': 'Waiting',
  'upload.errorShort': 'Failed — will retry',
  'upload.pausedItem': 'Paused',

  'research.sendLegend': 'Saving & sending on the coworker\'s device',
  'research.uploadUrl': 'Google Drive upload folder (share it as "Anyone with the link can edit")',
  'research.sendNote': 'These choices travel with your setup/task links and decide which buttons the coworker sees under "Save and send…".',
  'research.autoDel': 'Delete each text from the device after it uploads to Drive',
  'research.autoDelNote': 'Best for collecting recordings on a phone — frees storage and keeps the list to what still needs sending. Leave OFF if coworkers edit texts over several sessions. (The Flextext Recorder app deletes after upload by default.)',
  'relay.summary': 'Advanced: audio files larger than ~500 MB',
  'relay.note': 'Google Drive links already work with no setup, and no longer hit Google\'s old daily download limit — nothing to configure. The only exception is a single file bigger than about 500 MB. For that, host it on your own free Cloudflare R2 bucket and paste its public link in the audio field, exactly like a Drive link:<ol><li>Create a free Cloudflare account, then an R2 bucket.</li><li>Upload your audio file to the bucket.</li><li>Turn on public access (enable the r2.dev URL, or connect a custom domain).</li><li>Copy the file\'s public link and paste it wherever you\'d paste a Drive link.</li></ol>Cloudflare\'s free tier includes 10 GB of storage and unlimited downloads. <a href="https://developers.cloudflare.com/r2/buckets/public-buckets/" target="_blank" rel="noopener">Cloudflare R2 setup guide →</a>',
  'research.badFolder': 'That does not look like a Google Drive folder link — paste the folder\'s share link (…drive.google.com/drive/folders/…).',

  'research.h1': 'Language & writing system setup',
  'research.note': 'Set the writing systems this device will use for <em>new</em> texts. Files that are opened keep the writing systems declared inside them.',
  'research.vernLegend': 'Vernacular (text language)',
  'research.analLegend': 'Analysis (gloss / translation language)',
  'research.code': 'Code',
  'research.name': 'Name',
  'research.font': 'Font',
  'research.save': 'Save settings',
  'research.copyLink': 'Copy setup link for coworker',
  'research.checkerH': 'Writing system checker',
  'research.checkerNote': 'Open a <code>.flextext</code> file to see which writing system codes are used on each interlinear line, fix any wrong codes, and download the corrected file. (This edits the raw file directly and preserves everything else in it.)',
  'research.checkBtn': 'Check a .flextext file…',
  'research.declared': '{name} — declared writing systems: {list}',
  'research.noneDeclared': '(none declared)',
  'research.lang': 'Language / Bahasa',
  'research.disableBox': 'Hide the Settings tab on the coworker\'s device (included in the link above)',
  'research.hideHere': 'Hide the Settings tab on THIS device now',
  'research.hideHereNote': 'Use this when you set up a coworker\'s own phone in person. To bring the Settings tab back: tap the ? (Help) button 7 times (or press Ctrl+Alt+R on a keyboard).',
  'research.hideHereConfirm': 'Hide the Settings tab on THIS device? To bring it back, tap the ? (Help) button 7 times (or press Ctrl+Alt+R on a keyboard).',
  'research.analBlankConfirm': 'The analysis writing-system code is blank — coworkers won\'t have a language for word glosses and free translations. Create the link anyway?',
  'research.enabled': 'Settings tab enabled.',
  'research.disabled': 'Settings tab hidden. To bring it back, tap the ? (Help) button 7 times (or press Ctrl+Alt+R).',
  'ws.line': 'Interlinear line',
  'ws.code': 'Code in file',
  'ws.count': 'Uses',
  'ws.changeTo': 'Change to',
  'ws.keepPh': '(keep)',
  'research.downloadCorrected': 'Download corrected file',

  'wsline.baseline': 'Baseline (phrase text)',
  'wsline.word': 'Word',
  'wsline.punct': 'Punctuation',
  'wsline.wordgloss': 'Word gloss',
  'wsline.pos': 'Word category',
  'wsline.morph': 'Morpheme',
  'wsline.morphgloss': 'Morpheme gloss',
  'wsline.cf': 'Lex. entry (citation form)',
  'wsline.msa': 'Lex. gram. info',
  'wsline.free': 'Free translation',
  'wsline.lit': 'Literal translation',
  'wsline.note': 'Note',
  'wsline.segnum': 'Segment number',
  'wsline.meta': 'Text metadata (title etc.)',

  'toast.settingsSaved': 'Settings saved.',
  'toast.linkCopied': 'Setup link copied — send it to your coworker.',
  'toast.linkCopyManual': 'Copy this link and send it to your coworker.',
  'toast.needVern': 'Enter at least the vernacular code first.',
  'toast.opened': 'Opened {name}',
  'toast.importedMany': 'Imported {n} texts from {name} — each is now a separate text in the list.',
  'toast.importFailed': 'Import failed: {msg}',
  'toast.cantOpen': 'Could not open that text.',
  'toast.autosaveFailed': 'Autosave failed: {msg}',
  'toast.setupReceived': 'Language settings received and saved. You’re ready to start a new text.',
  'toast.saved': 'Saved.',
  'toast.shareFailed': 'Share failed: {msg}',
  'toast.saveFailed': 'Save failed: {msg}',
  'toast.storageFull': 'This device is running out of storage space, so the recording or text could not be saved. Delete some photos/videos or unused apps to free up space — the app will try again.',
  'toast.corrected': 'Corrected file downloaded.',
  'toast.noChanges': 'No changes entered — downloaded as-is.',

  'player.play': 'Play / pause',
  'player.back3': 'Back 3 seconds',
  'player.speed': 'Playback speed',
  'player.zoom': 'Zoom',
  'player.remove': 'Remove audio from this text',
  'player.attach': 'Attach audio…',
  'player.preparing': 'Preparing waveform…',
  'player.error': 'Could not play this audio file.',
  'player.pending': 'Audio not downloaded yet — it will download automatically when there is a connection.',
  'player.downloading': 'Downloading audio… {pct}% ({got} of {size} MB)',
  'player.downloadingBytes': 'Downloading audio… {got} MB so far',
  'player.pauseDl': 'Pause',
  'player.resumeDl': 'Resume',
  'player.resetDl': 'Start over',
  'player.pausedAt': 'Download paused — {got} of {size} MB saved. It will continue from here.',
  'player.storagePaused': 'Download paused — this device is out of storage space. Delete some photos, videos, or unused apps, then press Resume. What was already downloaded is saved.',
  'player.downloaded': 'Audio downloaded — ready to transcribe.',
  'player.downloadFailed': 'Audio could not be downloaded now — the app will keep trying when online.',
  'player.tooLarge': 'This audio is too large to download here. Please ask the researcher for a smaller version.',
  'player.confirmRemove': 'Remove the audio recording from this text?',

  'task.h': 'Task link (text + audio)',
  'task.note': 'Create a link that sets up your coworker\'s device <em>and</em> opens a new text for them — with an audio recording that downloads automatically and plays right above the typing area. For audio in Google Drive: share the file as "Anyone with the link" and paste the share link here — nothing else to set up.',
  'task.title': 'Text title',
  'task.audio': 'Audio (Drive share link, file ID, or direct URL)',
  'task.copy': 'Copy task link',
  'task.needRelay': 'This build has no Drive relay configured — see the README to set DEFAULT_RELAY.',
  'task.badAudio': 'Could not understand the audio link. Paste a Google Drive share link or a direct https:// audio URL.',
  'task.checking': 'Checking the audio file…',
  'task.checkOk': 'Audio OK: {name} ({size})',
  'task.checkFailed': 'Cannot use this audio: {msg}',
  'task.cantPlay': 'This is an AIFF file, which the in-app player can\'t open in Chrome, Edge, or Firefox. Convert it to WAV, FLAC, or MP3 and link that instead.',
  'task.tooBig': 'This file is {mb} MB — over the ~500 MB limit. Convert it to a smaller mono MP3 with the converter below, or host the original on your own R2 bucket (see "audio files larger than ~500 MB" under the setup form) and paste its direct link.',
  'task.notAudio': 'This link is not an audio file (it returned a {mime} page) — it may be a Drive FOLDER link, not a file. Open the audio file in Drive and use its share link, or paste a direct audio URL.',
  'task.received': 'New task received — listen and type. The audio is downloading…',
  'task.alreadyHere': 'This task is already on this device — opening it.',
  'task.flextext': 'Existing transcription (optional — a .flextext file\'s Drive share link, file ID, or direct URL)',
  'task.flextextNote': 'Optional: send an already-transcribed (or fully glossed) FLEx text for checking/editing. The app reads its writing-system codes and will not build a link unless they match your vern/anal setup above.',
  'task.badFlextext': 'Could not understand the flextext link. Paste a Google Drive share link or a direct https:// URL.',
  'task.ftChecking': 'Checking the transcription file…',
  'task.ftFetchFailed': 'Could not download the transcription: {msg}',
  'task.ftParseFailed': 'Not a readable flextext file: {msg}',
  'task.ftNone': '(none)',
  'task.ftDetected': 'Transcription OK — vernacular: {vern}; analysis: {anal}',
  'task.ftMismatch': 'Writing-system codes don\'t match your setup — vernacular: {vern} (your setup uses {vernWant}); analysis: {anal} (your setup uses {analWant}). Fix the file\'s codes (e.g. with the Writing System checker below) so they match, then try again.',
  'task.ftMultiText': 'This file has {n} texts in it. Please attach a file with a single text (export just one interlinear text from FLEx).',
  'task.ftReceiving': 'The assigned text will appear once it finishes downloading…',
  'task.ftArrived': 'The assigned text has arrived.',
  'task.ftFailed': 'The assigned text could not be loaded: {msg}. Ask your researcher to re-share it.',
  'task.replacing': 'Updating this text with the newer version from your researcher…',
  'task.cleanupConfirm': 'This link will delete {n} text(s) already on this device. Continue?',
  'task.cleanupDone': 'Removed {n} text(s) as requested.',
  'task.ftSkipped': 'The assigned text could not replace what you already started typing, so it was skipped.',

  'convert.h': 'Audio converter',
  'convert.note': 'Recorders often produce huge WAV files (a 2-minute 32-bit stereo WAV is ~40 MB) that are far too heavy to send. Convert any recording here to a small task-ready MP3 (~0.5 MB per minute at the default settings), then upload the MP3 to Google Drive for your task link. Works offline.',
  'convert.kbps': 'Quality (bitrate)',
  'convert.rate': 'Sample rate',
  'convert.mono': 'Always converted to mono — one voice through one microphone gains nothing from stereo, which would only double the file size.',
  'convert.pick': 'Choose audio file & convert…',
  'convert.working': 'Converting… {pct}%',
  'convert.done': 'Done: {name} — {out} (was {in}). The file has been downloaded; upload it to Google Drive.',
  'convert.failed': 'Conversion failed: {msg}',

  'update.available': 'A new version of the app is available.',
  'update.now': 'Update',

  'install.text': 'You can install this app on your device — it then works without internet, like a normal app.',
  'install.btn': 'Install app',
  'install.done': 'App installed — find it on your home screen or desktop.',
  'webkit.warning': 'This app does not fully work in Safari, or in any browser on an iPhone or iPad. On Apple phones and tablets, even Chrome and Firefox secretly use Safari underneath, so switching browsers there will not help. On a Mac, use Chrome or Firefox instead of Safari. On an iPhone or iPad, switch to a computer (Windows, Mac, or Linux) or an Android device.',

  'help.title': 'Help',
  'help.html': `
<h3>For transcribers</h3>
<ol>
  <li><b>Keep this app:</b> when a blue bar offers <b>Install app</b>, tap it — one tap puts the
  app on your home screen or desktop, and it then works without internet. (In Chrome or Edge you
  can also use the browser menu → <i>Install app</i> / <i>Add to Home screen</i>. In Firefox on
  Android: menu → <i>Add to Home screen</i>. Firefox on a computer cannot install apps — the
  page still works there, or use Chrome/Edge for a desktop app. Not supported in Safari or on
  iPhone/iPad.)</li>
  <li><b>Start:</b> tap <b>New text</b> and give it a name at the top.</li>
  <li><b>Type the story</b> on the <b>Baseline</b> tab, in your own language. Press Enter to start a new paragraph.</li>
  <li><b>Give word meanings:</b> open the <b>Gloss</b> tab. Under each blue word, type what it means. Press Enter to jump to the next word.</li>
  <li><b>Join words:</b> if two words belong together as one unit, tap the small 🔗 between them. Tap <b>✂ break</b> to separate them again.</li>
  <li><b>Translate the sentence:</b> on the <b>Free</b> line, write the meaning of the whole sentence.</li>
  <li><b>Send your work:</b> tap <b>Save and send…</b> and choose WhatsApp, email, another app —
  or <b>Upload</b>, which sends it straight to the researcher's Google Drive folder. A bar at the
  bottom shows <i>Uploading… please wait</i>; you can keep working, or cancel it. If it does not go
  through — for example the connection dropped — just tap <b>Upload</b> again; nothing is ever
  overwritten. If your text has a recording you made, it travels along automatically.</li>
</ol>
<p><b>Other ways to start a text:</b> <b>New text from audio…</b> turns a sound file already on
your device into a new text with the recording in the player; <b>Open .flextext file…</b>
continues from a file someone sent you; and a <b>link from your researcher</b> sets everything up
for you — sometimes with a recording already waiting to be transcribed.</p>
<p><b>Permission to record</b> (if your researcher turned this on): the first time you record, the
app asks for the speaker's permission. Read the message — or tap ▶ to play it aloud — then either
tap <b>Yes</b> / <b>No</b>, or <b>record the speaker giving permission</b> out loud, whichever
your researcher chose. Your answer is sent together with the work.</p>
<p><b>Recording:</b> <b>Record new text…</b> lets you record straight into the app — give the text
a name first, then record, listen, and re-record until you are happy, then Save. The recording
appears in the player above the typing area.</p>
<p><b>Audio:</b> if your researcher sent you a link with a recording, a player appears above the
typing area: ▶ plays and pauses, <b>↺3s</b> jumps back three seconds, and the speed menu slows
the voice down. The picture of the sound (waveform) shows where you are — tap it to jump, and
use <b>Zoom</b> to see more detail. The recording is saved on your device, so it works without
internet after the first time.</p>
<p>Your work is saved automatically on this device — you can close the app and continue later from the <b>Texts</b> list. If you change the story text afterwards, the word meanings of changed sentences may need to be typed again.</p>

<div id="help-research-hidden" hidden>
<p><i>The researcher setup guide is hidden on this device. If you are the researcher, tap the ? (Help) button 7 times — or press <b>Ctrl+Alt+R</b> on a keyboard — to show the Settings tab and this guide.</i></p>
</div>
<div id="help-researchers">
<h3>For researchers</h3>
<ul>
  <li><b>Set up a project:</b> on the <b>Settings</b> tab, enter the vernacular and analysis writing systems (code, e.g. <code>fau</code> / <code>en</code>, plus name and font). Click <b>Copy setup link for coworker</b> and send the link. Opening it configures their device — including the interface language you are currently using.</li>
  <li><b>Files:</b> the app reads and writes FLEx <code>.flextext</code> files. Existing analyses it does not edit (morphemes, word categories, notes) are preserved on export, except in sentences whose baseline was changed — same behavior as FLEx. Files containing several texts are imported as separate texts in the list.</li>
  <li><b>Back into FLEx:</b> in FieldWorks use <i>Texts &amp; Words → Import → FLExText interlinear document</i>.
  Files sent with <b>Share</b> arrive named <code>….flextext.txt</code> (messaging apps only accept
  certain file types) — FLEx's import dialog opens them as-is, or simply delete the
  <code>.txt</code> from the filename. This app also opens them directly.</li>
  <li><b>Wrong writing-system codes?</b> Use the <b>Writing system checker</b> (Settings tab) to see which codes each interlinear line uses and remap them without touching anything else.</li>
  <li><b>Uploads to your Drive:</b> set a <b>Google Drive upload folder</b> (shared as "Anyone
  with the link can edit") in the settings — your links then give coworkers an <b>Upload</b>
  button that sends finished work straight to that folder, zipped together with any recording they
  made and any recorded permission, never overwriting anything (filenames carry a timestamp).
  Uploads pass through the relay but count against your Drive <i>storage</i>, not its daily
  transfer quota. You can also choose exactly which save/send buttons coworkers see, via the
  checkboxes; the choices travel with your links.</li>
  <li><b>Audio converter:</b> recorders often produce huge WAV files (a 2-minute 32-bit stereo WAV
  is ~40&nbsp;MB) that are far too heavy to send. The <b>Audio converter</b> on the Settings tab
  turns any recording into a small mono 64&nbsp;kbps MP3 (~0.5&nbsp;MB per minute), on your device
  and offline; then upload that MP3 to Drive for your task link.</li>
  <li><b>Ask for the speaker's permission:</b> under <b>Speaker permission</b> on the Settings tab
  you can require a permission step before a coworker records. Write the message (in the local
  language and/or a language of wider communication), optionally give a spoken version (a Drive
  audio link, cached on the device for offline use), and choose how the coworker confirms:
  <b>tap Yes/No</b>, <b>record the speaker saying yes</b>, or <b>type the speaker's name as a
  signature</b>. Every consent writes a <code>consent-receipt.json</code> (+ a readable
  <code>consent-receipt.txt</code>) into the upload, logging that consent was given, the exact
  prompt shown, the date/time, the signature or recording, and — best effort — the device's IP
  (when online) plus an approximate location if the speaker allows it (the app asks once, on the
  first tap; both read "unavailable" otherwise). When the prompt itself is a recording, a copy of
  the exact audio the speaker heard is bundled too — so the question and the answer stay paired
  even after you refine the prompt later.</li>
  <li><b>What the coworker sees:</b> the send-option checkboxes are a template for the links you
  hand out — they decide which "Save and send…" buttons the coworker gets, and never restrict
  your own device. Likewise, restrictions only ever reach a device through a link it opens.</li>
  <li><b>Hiding the Settings tab:</b> two ways. For a <i>remote</i> coworker, tick the box under
  the copy-link buttons before copying — their device hides the tab when they open the link. To
  hide it on a phone you are setting up <i>in person</i>, use <b>Hide the Settings tab on THIS
  device now</b>. Either way, to bring it back: <b>tap the ? (Help) button 7 times</b> (works on a
  touchscreen) or press <b>Ctrl+Alt+R</b> on a keyboard — or open a link ending in
  <code>?research=on</code>.</li>
  <li><b>Updates:</b> when online, the app checks for new versions and shows an <b>Update</b> button when one is ready.</li>
  <li><b>Audio task links:</b> the <b>Task link</b> section creates a link that configures the
  coworker's device, creates a titled text, and auto-downloads a recording into a player on the
  typing tab. Use mono 64&nbsp;kbps MP3 (≈0.5&nbsp;MB per minute). Before the link is made the app
  checks the recording and warns you if it is an uncompressed WAV, too large, or not shared. The
  audio can live on any CORS-friendly host, or simply in <b>your own Google Drive</b>: upload the
  MP3, share it as
  "Anyone with the link", and paste the share link into the form — a built-in relay does the
  rest. (The relay only fetches link-shared files and has no access to anyone's private Drive
  contents. Teams that fork the app can run their own relay by deploying
  <code>docs/drive-relay.gs</code> and setting <code>DEFAULT_RELAY</code> in
  <code>js/app.js</code>.)</li>
</ul>
</div>`,
},

id: {
  'tabs.texts': 'Teks',
  'tabs.research': 'Pengaturan',
  'tabs.baseline': 'Ketik',
  'tabs.gloss': 'Terjemahan Balik',
  'btn.saveSend': 'Simpan & kirim…',
  'btn.back': 'Kembali ke daftar teks',
  'btn.help': 'Bantuan',
  'help.close': '← Kembali',

  'texts.new': '+ Teks baru',
  'texts.newAudio': '+ Teks baru dari audio…',
  'record.btn': 'Rekam teks baru…',
  'record.title': 'Rekam teks baru',
  'record.start': '● Rekam',
  'record.stop': '■ Berhenti',
  'record.save': 'Simpan',
  'record.redo': 'Rekam ulang',
  'record.idle': 'Tekan Rekam lalu berbicara. Anda bisa mendengarkan dan merekam ulang sebelum menyimpan.',
  'record.recording': 'Merekam… {time}',
  'record.review': 'Dengarkan dulu rekamannya, lalu Simpan — atau Rekam ulang kalau belum pas.',
  'record.converting': 'Menyimpan rekaman… {pct}%',
  'record.micError': 'Mikrofon tidak bisa dipakai: {msg}',
  'record.noAudio': 'Tidak ada suara yang terekam — silakan coba lagi.',
  'record.clipWarn': '⚠ Terlalu keras — mundur sedikit.',
  'record.distanceHint': 'Pegang HP sekitar selebar telapak tangan dari mulut.',
  'record.gainLabel': 'Level rekaman',
  'record.fellBack': '⚠ Browser ini tidak bisa merekam audio lossless, jadi rekaman ini disimpan sebagai MP3 terkompresi. Untuk arsip WAV/FLAC, gunakan Chrome, Edge, atau Firefox versi terbaru.',
  'record.titleLabel': 'Judul untuk teks ini',
  'record.titlePh': 'Beri nama rekaman ini',
  'record.appName': 'Perekam Flextext',
  'record.welcomeDefault': 'Rekam teks {lang} di sini.',
  'record.savedH': 'Rekaman Anda',
  'record.empty': 'Belum ada rekaman. Ketuk Rekam untuk membuatnya.',
  'record.send': 'Kirim',
  'record.saved': 'Rekaman disimpan.',
  'record.sentRemoved': 'Terkirim ke Google Drive — dihapus dari perangkat ini: {name}',
  'recordlink.h': 'Tautan Perekaman HP',
  'recordlink.note': 'Buat tautan yang membuka aplikasi <em>khusus merekam</em> yang disederhanakan di HP rekan kerja — tanpa editor, tanpa glos, cukup rekam lalu kirim. Mereka bisa memasangnya sebagai aplikasi tersendiri ("Perekam Flextext") dan menyimpan banyak rekaman tanpa internet. Langkah izin penutur dan folder unggahan Drive yang Anda atur di atas juga berlaku di sini.',
  'recordlink.welcome': 'Pesan sambutan / judul (ditampilkan di HP — sertakan nama bahasanya)',
  'recordlink.welcomePh': 'mis. Rekam cerita Fayu di sini',
  'recordlink.needWelcome': 'Ketik pesan sambutan dulu — pesan ini muncul di HP rekan kerja dan sebaiknya menyebut nama bahasanya.',
  'recordlink.whatsapp': '⚠ Audio yang dikirim lewat WhatsApp dikompresi ulang dan kualitasnya turun, bahkan di dalam zip. Sebaiknya pakai Kirim Langsung ke Google Drive.',
  'buttons.legend': 'Tombol di layar Teks rekan kerja',
  'buttons.note': 'Ini ikut dalam tautan pengaturan/tugas Anda dan menentukan tombol "teks baru" mana yang dilihat rekan kerja di layar Teks. (Teks tetap bisa masuk lewat tautan tugas walaupun semua tombol dimatikan.)',
  'recordlink.copy': 'Salin tautan Perekaman HP',
  'recformat.h': 'Format rekaman',
  'recformat.note': 'Cara rekaman baru direkam — di sini dan di HP mana pun yang Anda kirimi tautan perekaman. Rekaman adalah data utama Anda, jadi rekam lossless (<b>WAV</b>) dan pertahankan; rekaman ditangkap <b>mentah</b>, tanpa penguatan otomatis atau pemrosesan noise. Lossless memerlukan Chrome, Edge, atau Firefox versi terbaru; di tempat lain beralih ke MP3 dengan peringatan.',
  'recformat.label': 'Format untuk rekaman baru',
  'recformat.wav24': 'WAV · 24-bit (disarankan)',
  'recformat.wav16': 'WAV · 16-bit (lebih kecil)',
  'recformat.wav32': 'WAV · 32-bit float (lanjutan — perangkat profesional)',
  'recformat.flac24': 'FLAC · 24-bit (lossless, lebih kecil — untuk bandwidth terbatas)',
  'recformat.mp3': 'MP3 (terkompresi — bukan untuk pengarsipan)',
  'recformat.gainToggle': 'Tampilkan penggeser level rekaman (gain) saat merekam',
  'recformat.gainNote': 'Mati secara default — rekaman menangkap level mikrofon mentah. Aktifkan ini untuk menyesuaikan perangkat yang terlalu pelan atau terlalu keras.',
  'recfmt.helpLink': 'Format mana yang harus saya pilih?',
  'recfmt.helpTitle': 'Memilih format rekaman',
  'recfmt.helpKeep': '<b>Rekam dalam WAV, dan simpan tetap WAV.</b> Rekaman Anda adalah data riset utama — yang diawetkan arsip, dan yang menjadi dasar analisis akustik atau fonetik di masa depan. Rekam dengan kualitas arsip sejak awal; jangan berencana merekam dalam satu format lalu mengubahnya nanti.',
  'recfmt.helpRaw': '<b>Perekaman setia, tanpa pemrosesan.</b> Peramban biasanya menerapkan penguatan otomatis, pengurangan noise, dan penghapus gema pada audio mikrofon — aplikasi ini mematikan ketiganya, jadi format lossless menangkap sinyal mentah tanpa ada yang ditambahkan atau dihilangkan. Satu-satunya yang bisa mengubah level adalah penggeser level rekaman opsional, jika peneliti mengaktifkannya.',
  'recfmt.helpBits': '<b>Kedalaman bit — 24-bit adalah default.</b> WAV 24-bit menangkap semua yang benar-benar bisa dihasilkan mikrofon HP, dan merupakan kedalaman yang diharapkan arsip. <b>16-bit</b> lebih kecil dan sangat memadai untuk suara di perangkat sederhana. <b>32-bit float</b> tersedia tetapi <b>tidak disarankan di HP</b>: satu-satunya keunggulan nyatanya — mustahil clipping — memerlukan perangkat perekam lapangan profesional yang tidak dimiliki HP (dan peramban tidak bisa meneruskan headroom itu), serta 32-bit float bukan PCM arsip standar, sehingga <b>banyak arsip menolaknya</b>. Gunakan hanya bila Anda tahu ada antarmuka audio profesional yang memberi masukan rekaman.',
  'recfmt.helpWavFlac': '<b>WAV vs FLAC.</b> Keduanya lossless dan kualitasnya identik. <b>WAV</b> adalah format arsip universal, diterima di mana saja. <b>FLAC</b> juga lossless dan sekitar separuh ukurannya, yang bisa membantu saat bandwidth unggah sangat terbatas — tetapi sebagian besar arsip tidak menerima FLAC untuk penyetoran, jadi Anda harus mengubahnya kembali ke WAV, bertentangan dengan aturan "rekam satu format dan pertahankan". Utamakan WAV; gunakan FLAC hanya bila data terbatas benar-benar memaksa.',
  'recfmt.helpMono': '<b>Selalu mono.</b> Satu suara melalui satu mikrofon tidak mendapat manfaat dari stereo, yang hanya akan menggandakan ukuran berkas. Aplikasi ini selalu merekam dan mengirim mono.',
  'recfmt.helpRate': '<b>Laju sampel.</b> Rekaman memakai laju asli perangkat (biasanya 48 kHz) — jauh melebihi kebutuhan suara atau nada. Tidak ada yang perlu diatur.',
  'recfmt.helpMp3': '<b>MP3 — bukan untuk pengarsipan.</b> MP3 bersifat lossy: secara permanen membuang data audio, dan tidak ada arsip yang menerimanya untuk preservasi. Hanya dapat dibenarkan untuk curah gagasan cepat, untuk mengumpulkan materi yang Anda rencanakan untuk direkam ulang dengan benar nanti, atau saat penyimpanan dan bandwidth sangat terbatas.',
  'recfmt.helpArchives': '<b>Periksa arsip Anda.</b> Persyaratan sedikit berbeda antararsip, tetapi <b>rekam WAV 24-bit pada 48 kHz, mono, dan Anda memenuhi setiap arsip utama di bawah ini.</b> (16-bit juga diterima oleh beberapa arsip; 96 kHz hanya untuk tingkat preservasi paling ketat — dan HP tidak bisa mencapainya.)',
  'recfmt.helpTable': '<div class="help-scroll"><table class="archive-table"><thead><tr><th>Arsip</th><th>Format</th><th>Kedalaman bit / laju</th><th>FLAC</th><th>Sumber</th></tr></thead><tbody><tr><td>Library of Congress</td><td>Broadcast WAVE tanpa kompresi</td><td>24-bit / 96 kHz diutamakan; 16-bit / 44.1 kHz minimum</td><td>tidak disebut</td><td><a href="https://www.loc.gov/preservation/resources/rfs/audio.html" target="_blank" rel="noopener noreferrer">loc.gov</a></td></tr><tr><td>PARADISEC</td><td>WAV tanpa kompresi</td><td>24-bit / 96 kHz target; 48 kHz diterima</td><td>tidak tercantum</td><td><a href="https://www.paradisec.org.au/deposit/file-formats/" target="_blank" rel="noopener noreferrer">paradisec.org.au</a></td></tr><tr><td>ELAR</td><td>WAV tanpa kompresi</td><td>tidak dipublikasikan (16-bit min; 48 kHz / 24-bit dalam praktik)</td><td>tidak dinyatakan</td><td><a href="https://www.elararchive.org/deposit-with-elar/" target="_blank" rel="noopener noreferrer">elararchive.org</a></td></tr><tr><td>FADGI (federal AS)</td><td>WAVE / BWF, LPCM</td><td>24-bit / 96 kHz; 48 kHz ditoleransi</td><td>tidak</td><td><a href="https://www.digitizationguidelines.gov/guidelines/digitize-audio.html" target="_blank" rel="noopener noreferrer">digitizationguidelines.gov</a></td></tr><tr><td>AILLA (UT Austin)</td><td>WAV (MP3 juga diperbolehkan)</td><td>24-bit; 16-bit min; 44.1 kHz</td><td>tidak</td><td><a href="https://guides.lib.utexas.edu/ailla/deposit" target="_blank" rel="noopener noreferrer">guides.lib.utexas.edu</a></td></tr><tr><td>The Language Archive (MPI Nijmegen)</td><td>WAV PCM tanpa kompresi</td><td>16 atau 24-bit / 44.1 atau 48 kHz</td><td>tidak</td><td><a href="https://archive.mpi.nl/accepted-file-formats" target="_blank" rel="noopener noreferrer">archive.mpi.nl</a></td></tr><tr><td>SIL — REAP / RAMP</td><td>WAV / PCM tanpa kompresi</td><td>tidak diwajibkan (16 atau 24-bit)</td><td>tidak dinyatakan</td><td><a href="https://reap.sil.org/" target="_blank" rel="noopener noreferrer">reap.sil.org</a></td></tr></tbody></table></div>',
  'recfmt.helpCourse': 'Baru dalam mengarsipkan rekaman lapangan? Kursus gratis AILLA <a href="https://archivingforthefuture.teachable.com/" target="_blank" rel="noopener noreferrer">Archiving for the Future</a> membahas format dan alur kerja untuk dokumentasi bahasa.',
  'recfmt.helpClose': 'Tutup',
  'consent.legend': 'Izin penutur sebelum merekam',
  'consent.mode': 'Saat rekan kerja merekam teks baru, tanyakan dulu…',
  'consent.modeOff': 'Jangan tanya apa pun',
  'consent.modeText': 'Tampilkan pengingat tertulis',
  'consent.modeAudio': 'Putar pengingat lisan (audio)',
  'consent.msg': 'Pengingat tertulis yang ditampilkan ke rekan kerja',
  'consent.audioUrl': 'Audio pengingat lisan (tautan berbagi Drive atau URL MP3 langsung)',
  'consent.resp': 'Bagaimana rekan kerja menyetujui',
  'consent.respYesNo': 'Ketuk Ya / Tidak',
  'consent.respRecord': 'Rekam penutur mengatakan ya (disimpan dalam bundel)',
  'consent.respSignature': 'Ketik nama penutur sebagai tanda tangan',
  'consent.signLabel': 'Ketik nama Anda untuk memberi izin',
  'consent.signBtn': 'Tanda tangan & lanjutkan',
  'consent.needName': 'Silakan ketik nama Anda dulu.',
  'consent.note': 'Pengingat ini muncul di perangkat rekan kerja sebelum tiap rekaman baru. Setiap persetujuan dicatat dalam berkas consent-receipt (berisi tanggal, pesan persis yang ditampilkan, alamat IP perangkat saat online, dan lokasi perkiraan bila penutur mengizinkannya — ditanyakan sekali saja saat pertama dipakai) yang dibungkus bersama teks. Rekaman "ya" atau tanda tangan yang diketik disimpan bersamanya, dan untuk pengingat lisan, salinan persis rekaman yang didengar penutur ikut dibungkus juga — sehingga pertanyaan dan jawaban bisa diverifikasi berdampingan walau nanti Anda memperbaiki pengingatnya.',
  'consent.title': 'Izin penutur',
  'consent.yes': 'Ya — saya punya izin',
  'consent.no': 'Tidak',
  'consent.recYes': 'Rekam jawaban "ya"',
  'consent.recStop': 'Berhenti',
  'consent.continue': 'Lanjutkan',
  'consent.assentReview': 'Dengarkan dulu, lalu Lanjutkan — atau Rekam ulang.',
  'consent.declined': 'Merekam memerlukan izin penutur. Tanyakan dulu, lalu coba lagi.',
  'consent.loadingAudio': 'Memuat pengingat lisan…',
  'consent.audioFailed': 'Tidak bisa memuat pengingat lisan. Anda tetap bisa melanjutkan.',
  'texts.open': 'Buka file .flextext…',
  'texts.empty': 'Belum ada teks. Tekan <b>Teks baru</b> untuk mulai mengetik, atau buka file <code>.flextext</code> yang sudah ada.',
  'texts.deleteTitle': 'Hapus',
  'texts.confirmDelete': 'Hapus "{title}" dari perangkat ini?\n(Pastikan sudah disimpan/dikirim kalau masih diperlukan.)',
  'texts.meta': '{n} kalimat · {g} glos terisi · {date}',
  'untitled': 'Teks tanpa judul',

  'banner.set': 'Sistem tulisan: {vern} → {anal}',
  'banner.unset': 'Sistem tulisan belum diatur — teks baru akan memakai kode sementara. Minta tautan pengaturan dari peneliti, atau buka tab <b>Pengaturan</b>.',

  'baseline.hint': 'Ketik atau tempel teks di sini. Tekan <b>Enter</b> untuk paragraf baru. Kalimat dipisah otomatis pada <code>. ! ?</code>',
  'baseline.placeholder': 'Ketik teks bahasa daerah di sini…',

  'gloss.empty': 'Belum ada yang bisa dikerjakan — ketik teksnya di tab <b>Ketik</b> dulu.',
  'gloss.wordLabel': 'Asli',
  'gloss.glossLabel': 'Harfiah',
  'gloss.freeLabel': 'Bebas',
  'gloss.freePlaceholder': 'Terjemahan bebas…',
  'gloss.chainTitle': 'Gabungkan dua kata ini menjadi satu frasa',
  'gloss.confirmMerge': 'Gabungkan "{a}" dan "{b}" menjadi satu kesatuan (frasa)?\nKeduanya akan punya satu arti bersama. Bisa dipisahkan lagi dengan "✂ pisah".',
  'gloss.breakLabel': '✂ pisah',
  'gloss.breakTitle': 'Pisahkan frasa ini menjadi kata-kata lagi',

  'share.title': 'Simpan dan kirim',
  'share.share': 'Bagikan…',
  'share.upload': 'Kirim Langsung',
  'share.saveas': 'Simpan ke file…',
  'share.download': 'Unduh',
  'share.cancel': 'Batal',

  'upload.starting': 'Menyiapkan pengiriman…',
  'upload.progress': 'Mengirim {name}… {pct}% ({got} dari {size} MB)',
  'upload.working': 'Mengirim {name}… mohon tunggu.',
  'upload.paused': 'Pengiriman dijeda — {pct}% sudah terkirim. Nanti dilanjutkan dari sini.',
  'upload.error': 'Masalah pengiriman: {msg}',
  'upload.done': 'Terkirim ke Google Drive: {name}',
  'upload.retry': 'Coba lagi',
  'upload.cancel': 'Batalkan pengiriman',
  'upload.more': '{n} lagi menunggu',
  'upload.waiting': '{n} berkas menunggu untuk dikirim — akan terkirim otomatis saat Anda online.',
  'upload.retrying': '{n} berkas menunggu untuk dikirim — akan dicoba lagi sebentar lagi.',
  'upload.pausedSummary': 'Dijeda: {name}',
  'upload.sendNow': 'Kirim sekarang',
  'upload.pause': 'Jeda',
  'upload.resume': 'Lanjutkan',
  'upload.queuedToast': 'Ditambahkan ke antrean pengiriman — akan terkirim saat Anda online.',
  'upload.uploadingShort': 'Mengirim…',
  'upload.queuedShort': 'Menunggu',
  'upload.errorShort': 'Gagal — akan dicoba lagi',
  'upload.pausedItem': 'Dijeda',

  'research.sendLegend': 'Penyimpanan & pengiriman di perangkat rekan kerja',
  'research.uploadUrl': 'Folder unggahan Google Drive (bagikan sebagai "Siapa saja yang memiliki link dapat mengedit")',
  'research.sendNote': 'Pilihan ini ikut dalam tautan pengaturan/tugas Anda dan menentukan tombol mana yang dilihat rekan kerja di "Simpan dan kirim…".',
  'research.autoDel': 'Hapus tiap teks dari perangkat setelah berhasil diunggah ke Drive',
  'research.autoDelNote': 'Cocok untuk mengumpulkan rekaman di HP — menghemat penyimpanan dan menjaga daftar hanya berisi yang belum terkirim. Biarkan MATI jika rekan kerja menyunting teks selama beberapa sesi. (Aplikasi Perekam Flextext menghapus otomatis setelah unggah.)',
  'relay.summary': 'Lanjutan: berkas audio lebih besar dari ~500 MB',
  'relay.note': 'Tautan Google Drive sudah berfungsi tanpa pengaturan apa pun, dan tidak lagi terkena batas unduhan harian lama dari Google — tidak ada yang perlu diatur. Satu-satunya pengecualian adalah satu berkas yang lebih besar dari sekitar 500 MB. Untuk itu, simpan di bucket Cloudflare R2 gratis milik Anda sendiri dan tempel tautan publiknya di kolom audio, persis seperti tautan Drive:<ol><li>Buat akun Cloudflare gratis, lalu sebuah bucket R2.</li><li>Unggah berkas audio Anda ke bucket.</li><li>Aktifkan akses publik (aktifkan URL r2.dev, atau hubungkan domain khusus).</li><li>Salin tautan publik berkas dan tempel di mana pun Anda biasa menempel tautan Drive.</li></ol>Paket gratis Cloudflare mencakup penyimpanan 10 GB dan unduhan tanpa batas. <a href="https://developers.cloudflare.com/r2/buckets/public-buckets/" target="_blank" rel="noopener">Panduan penyiapan Cloudflare R2 →</a>',
  'research.badFolder': 'Itu sepertinya bukan tautan folder Google Drive — tempel tautan berbagi foldernya (…drive.google.com/drive/folders/…).',

  'research.h1': 'Pengaturan bahasa & sistem tulisan',
  'research.note': 'Atur sistem tulisan yang dipakai perangkat ini untuk teks <em>baru</em>. File yang dibuka tetap memakai sistem tulisan yang tercantum di dalam file itu.',
  'research.vernLegend': 'Bahasa daerah (bahasa teks)',
  'research.analLegend': 'Bahasa analisis (glos / terjemahan)',
  'research.code': 'Kode',
  'research.name': 'Nama',
  'research.font': 'Fon (huruf)',
  'research.save': 'Simpan pengaturan',
  'research.copyLink': 'Salin tautan pengaturan untuk rekan kerja',
  'research.checkerH': 'Pemeriksa sistem tulisan',
  'research.checkerNote': 'Buka file <code>.flextext</code> untuk melihat kode sistem tulisan yang dipakai pada setiap baris interlinear, perbaiki kode yang salah, lalu unduh file yang sudah diperbaiki. (Proses ini mengubah file asli secara langsung dan mempertahankan semua isi lainnya.)',
  'research.checkBtn': 'Periksa file .flextext…',
  'research.declared': '{name} — sistem tulisan yang terdaftar: {list}',
  'research.noneDeclared': '(tidak ada yang terdaftar)',
  'research.lang': 'Bahasa / Language',
  'research.disableBox': 'Sembunyikan tab Pengaturan di perangkat rekan kerja (disertakan dalam tautan di atas)',
  'research.hideHere': 'Sembunyikan tab Pengaturan di perangkat INI sekarang',
  'research.hideHereNote': 'Gunakan ini saat Anda menyiapkan HP milik rekan kerja secara langsung. Untuk memunculkan tab Pengaturan lagi: ketuk tombol ? (Bantuan) 7 kali (atau tekan Ctrl+Alt+R di papan ketik).',
  'research.hideHereConfirm': 'Sembunyikan tab Pengaturan di perangkat INI? Untuk memunculkannya lagi, ketuk tombol ? (Bantuan) 7 kali (atau tekan Ctrl+Alt+R di papan ketik).',
  'research.analBlankConfirm': 'Kode sistem tulisan analisis kosong — rekan kerja tidak akan punya bahasa untuk arti kata dan terjemahan bebas. Tetap buat tautannya?',
  'research.enabled': 'Tab Pengaturan diaktifkan.',
  'research.disabled': 'Tab Pengaturan disembunyikan. Untuk memunculkannya lagi, ketuk tombol ? (Bantuan) 7 kali (atau tekan Ctrl+Alt+R).',
  'ws.line': 'Baris interlinear',
  'ws.code': 'Kode di file',
  'ws.count': 'Jumlah',
  'ws.changeTo': 'Ubah menjadi',
  'ws.keepPh': '(biarkan)',
  'research.downloadCorrected': 'Unduh file yang sudah diperbaiki',

  'wsline.baseline': 'Asli (teks kalimat)',
  'wsline.word': 'Asli (kata)',
  'wsline.punct': 'Tanda baca',
  'wsline.wordgloss': 'Harfiah (glos kata)',
  'wsline.pos': 'Kategori kata',
  'wsline.morph': 'Morfem',
  'wsline.morphgloss': 'Glos morfem',
  'wsline.cf': 'Entri leksikal (bentuk sitasi)',
  'wsline.msa': 'Info gramatikal leksikal',
  'wsline.free': 'Bebas (terjemahan bebas)',
  'wsline.lit': 'Terjemahan harfiah',
  'wsline.note': 'Catatan',
  'wsline.segnum': 'Nomor kalimat',
  'wsline.meta': 'Metadata teks (judul dll.)',

  'toast.settingsSaved': 'Pengaturan disimpan.',
  'toast.linkCopied': 'Tautan pengaturan disalin — kirim ke rekan kerja Anda.',
  'toast.linkCopyManual': 'Salin tautan ini dan kirim ke rekan kerja Anda.',
  'toast.needVern': 'Isi dulu kode bahasa daerah.',
  'toast.opened': 'Berhasil membuka {name}',
  'toast.importedMany': '{n} teks diimpor dari {name} — masing-masing menjadi teks tersendiri di daftar.',
  'toast.importFailed': 'Impor gagal: {msg}',
  'toast.cantOpen': 'Teks itu tidak bisa dibuka.',
  'toast.autosaveFailed': 'Simpan otomatis gagal: {msg}',
  'toast.setupReceived': 'Pengaturan bahasa diterima dan disimpan. Anda siap membuat teks baru.',
  'toast.saved': 'Tersimpan.',
  'toast.shareFailed': 'Gagal membagikan: {msg}',
  'toast.saveFailed': 'Gagal menyimpan: {msg}',
  'toast.storageFull': 'Ruang penyimpanan perangkat ini hampir habis, jadi rekaman atau teks tidak bisa disimpan. Hapus beberapa foto/video atau aplikasi yang tidak dipakai — aplikasi ini akan mencoba lagi.',
  'toast.corrected': 'File yang sudah diperbaiki telah diunduh.',
  'toast.noChanges': 'Tidak ada perubahan — file diunduh apa adanya.',

  'player.play': 'Putar / jeda',
  'player.back3': 'Mundur 3 detik',
  'player.speed': 'Kecepatan putar',
  'player.zoom': 'Perbesar',
  'player.remove': 'Hapus audio dari teks ini',
  'player.attach': 'Lampirkan audio…',
  'player.preparing': 'Menyiapkan gambar gelombang…',
  'player.error': 'File audio ini tidak bisa diputar.',
  'player.pending': 'Audio belum terunduh — akan diunduh otomatis saat ada koneksi.',
  'player.downloading': 'Mengunduh audio… {pct}% ({got} dari {size} MB)',
  'player.downloadingBytes': 'Mengunduh audio… sudah {got} MB',
  'player.pauseDl': 'Jeda',
  'player.resumeDl': 'Lanjutkan',
  'player.resetDl': 'Ulangi dari awal',
  'player.pausedAt': 'Unduhan dijeda — {got} dari {size} MB sudah tersimpan. Nanti dilanjutkan dari sini.',
  'player.storagePaused': 'Unduhan dijeda — ruang penyimpanan perangkat ini penuh. Hapus beberapa foto, video, atau aplikasi yang tidak dipakai, lalu tekan Lanjutkan. Bagian yang sudah terunduh tetap tersimpan.',
  'player.downloaded': 'Audio sudah terunduh — siap diketik.',
  'player.downloadFailed': 'Audio belum bisa diunduh sekarang — aplikasi akan terus mencoba saat online.',
  'player.tooLarge': 'Audio ini terlalu besar untuk diunduh di sini. Mohon minta versi yang lebih kecil dari peneliti.',
  'player.confirmRemove': 'Hapus rekaman audio dari teks ini?',

  'task.h': 'Tautan tugas (teks + audio)',
  'task.note': 'Buat tautan yang mengatur perangkat rekan kerja Anda <em>dan</em> langsung membuka teks baru — dengan rekaman audio yang terunduh otomatis dan bisa diputar tepat di atas tempat mengetik. Untuk audio di Google Drive: bagikan filenya sebagai "Siapa saja yang memiliki link" lalu tempel tautannya di sini — tidak ada penyiapan lain.',
  'task.title': 'Judul teks',
  'task.audio': 'Audio (tautan berbagi Drive, ID file, atau URL langsung)',
  'task.copy': 'Salin tautan tugas',
  'task.needRelay': 'Versi aplikasi ini belum punya relay Drive — lihat README untuk mengatur DEFAULT_RELAY.',
  'task.badAudio': 'Tautan audio tidak dikenali. Tempel tautan berbagi Google Drive atau URL audio https:// langsung.',
  'task.checking': 'Memeriksa file audio…',
  'task.checkOk': 'Audio OK: {name} ({size})',
  'task.checkFailed': 'Audio ini tidak bisa dipakai: {msg}',
  'task.cantPlay': 'Ini berkas AIFF, yang tidak bisa dibuka oleh pemutar aplikasi di Chrome, Edge, atau Firefox. Ubah ke WAV, FLAC, atau MP3 lalu tautkan itu.',
  'task.tooBig': 'File ini {mb} MB — melebihi batas ~500 MB. Ubah ke MP3 mono lebih kecil dengan pengubah di bawah, atau simpan aslinya di bucket R2 milik Anda sendiri (lihat "berkas audio lebih besar dari ~500 MB" di bawah formulir penyiapan) lalu tempel tautan langsungnya.',
  'task.notAudio': 'Tautan ini bukan berkas audio (mengembalikan halaman {mime}) — mungkin tautan FOLDER Drive, bukan berkas. Buka berkas audionya di Drive lalu gunakan tautan bagikannya, atau tempel URL audio langsung.',
  'task.received': 'Tugas baru diterima — dengarkan dan ketik. Audio sedang diunduh…',
  'task.alreadyHere': 'Tugas ini sudah ada di perangkat ini — sedang dibuka.',
  'task.flextext': 'Transkripsi yang sudah ada (opsional — tautan berbagi Drive, ID file, atau URL langsung sebuah file .flextext)',
  'task.flextextNote': 'Opsional: kirim teks FLEx yang sudah ditranskripsi (atau sudah diglos lengkap) untuk diperiksa/disunting. Aplikasi membaca kode sistem penulisannya dan tidak akan membuat tautan kecuali cocok dengan pengaturan vern/anal Anda di atas.',
  'task.badFlextext': 'Tautan flextext tidak dikenali. Tempel tautan berbagi Google Drive atau URL https:// langsung.',
  'task.ftChecking': 'Memeriksa file transkripsi…',
  'task.ftFetchFailed': 'Tidak dapat mengunduh transkripsi: {msg}',
  'task.ftParseFailed': 'Bukan file flextext yang terbaca: {msg}',
  'task.ftNone': '(tidak ada)',
  'task.ftDetected': 'Transkripsi OK — vernakular: {vern}; analisis: {anal}',
  'task.ftMismatch': 'Kode sistem penulisan tidak cocok dengan pengaturan Anda — vernakular: {vern} (pengaturan Anda memakai {vernWant}); analisis: {anal} (pengaturan Anda memakai {analWant}). Perbaiki kode file itu (mis. dengan Pemeriksa Sistem Penulisan di bawah) agar cocok, lalu coba lagi.',
  'task.ftMultiText': 'File ini berisi {n} teks. Lampirkan file dengan satu teks saja (ekspor satu teks interlinear dari FLEx).',
  'task.ftReceiving': 'Teks tugas akan muncul setelah selesai diunduh…',
  'task.ftArrived': 'Teks tugas sudah tiba.',
  'task.ftFailed': 'Teks tugas tidak dapat dimuat: {msg}. Minta peneliti membagikannya ulang.',
  'task.replacing': 'Memperbarui teks ini dengan versi terbaru dari peneliti Anda…',
  'task.cleanupConfirm': 'Tautan ini akan menghapus {n} teks yang sudah ada di perangkat ini. Lanjutkan?',
  'task.cleanupDone': 'Menghapus {n} teks sesuai permintaan.',
  'task.ftSkipped': 'Teks tugas tidak dapat menggantikan apa yang sudah mulai Anda ketik, jadi dilewati.',

  'convert.h': 'Pengubah audio',
  'convert.note': 'Alat perekam sering menghasilkan file WAV yang sangat besar (WAV stereo 32-bit 2 menit ≈ 40 MB) — terlalu berat untuk dikirim. Ubah rekaman apa pun di sini menjadi MP3 kecil yang siap untuk tugas (≈0,5 MB per menit dengan pengaturan bawaan), lalu unggah MP3-nya ke Google Drive untuk tautan tugas. Bisa dipakai tanpa internet.',
  'convert.kbps': 'Kualitas (bitrate)',
  'convert.rate': 'Laju sampel',
  'convert.mono': 'Selalu diubah ke mono — satu suara melalui satu mikrofon tidak mendapat manfaat dari stereo, yang hanya akan menggandakan ukuran berkas.',
  'convert.pick': 'Pilih file audio & ubah…',
  'convert.working': 'Mengubah… {pct}%',
  'convert.done': 'Selesai: {name} — {out} (sebelumnya {in}). File sudah diunduh; unggah ke Google Drive.',
  'convert.failed': 'Pengubahan gagal: {msg}',

  'update.available': 'Versi baru aplikasi ini tersedia.',
  'update.now': 'Perbarui',

  'install.text': 'Aplikasi ini bisa dipasang di perangkat Anda — setelah itu bisa dipakai tanpa internet, seperti aplikasi biasa.',
  'install.btn': 'Pasang aplikasi',
  'install.done': 'Aplikasi terpasang — cari di layar utama atau desktop.',
  'webkit.warning': 'Aplikasi ini tidak berfungsi penuh di Safari, atau di browser apa pun pada iPhone atau iPad. Di ponsel dan tablet Apple, bahkan Chrome dan Firefox memakai Safari di belakang layar, jadi berganti browser di sana tidak akan membantu. Di Mac, pakai Chrome atau Firefox, bukan Safari. Di iPhone atau iPad, gunakan komputer (Windows, Mac, atau Linux) atau perangkat Android.',

  'help.title': 'Bantuan',
  'help.html': `
<h3>Untuk pengetik teks</h3>
<ol>
  <li><b>Simpan aplikasi ini:</b> kalau muncul bilah biru dengan tombol <b>Pasang aplikasi</b>,
  tekan tombol itu — sekali tekan, aplikasi terpasang di layar utama atau desktop dan bisa
  dipakai tanpa internet. (Di Chrome atau Edge bisa juga lewat menu browser → <i>Instal
  aplikasi</i> / <i>Tambahkan ke Layar Utama</i>. Di Firefox Android: menu → <i>Tambahkan ke
  Layar Utama</i>. Firefox di komputer tidak bisa memasang aplikasi — halamannya tetap bisa
  dipakai, atau gunakan Chrome/Edge. Tidak didukung di Safari atau iPhone/iPad.)</li>
  <li><b>Mulai:</b> tekan <b>Teks baru</b> dan beri nama di bagian atas.</li>
  <li><b>Ketik cerita</b> di tab <b>Ketik</b>, dalam bahasa daerah Anda. Tekan Enter untuk paragraf baru.</li>
  <li><b>Isi arti kata:</b> buka tab <b>Terjemahan Balik</b>. Di baris <b>Harfiah</b>, di bawah setiap kata <b>Asli</b> yang biru, ketik artinya. Tekan Enter untuk pindah ke kata berikutnya.</li>
  <li><b>Gabungkan kata:</b> kalau dua kata merupakan satu kesatuan, tekan tanda 🔗 kecil di antaranya. Tekan <b>✂ pisah</b> untuk memisahkannya lagi.</li>
  <li><b>Terjemahkan kalimat:</b> di baris <b>Bebas</b>, tulis arti seluruh kalimat.</li>
  <li><b>Kirim hasil kerja:</b> tekan <b>Simpan & kirim…</b> lalu pilih WhatsApp, email, aplikasi
  lain — atau <b>Kirim Langsung</b>, yang mengirimnya langsung ke folder Google Drive peneliti.
  Bilah di bawah menampilkan <i>Mengirim… mohon tunggu</i>; Anda bisa terus bekerja atau
  membatalkannya. Kalau tidak terkirim — misalnya koneksi putus — cukup tekan <b>Kirim
  Langsung</b> lagi; tidak ada yang pernah ditimpa. Kalau teks Anda punya rekaman buatan sendiri,
  rekaman itu ikut terkirim otomatis.</li>
</ol>
<p><b>Cara lain memulai teks:</b> <b>Teks baru dari audio…</b> mengubah file suara yang sudah ada
di perangkat Anda menjadi teks baru dengan rekamannya di pemutar; <b>Buka file .flextext…</b>
melanjutkan file yang dikirim seseorang; dan <b>tautan dari peneliti</b> mengatur semuanya untuk
Anda — kadang sudah disertai rekaman yang menunggu untuk ditranskripsi.</p>
<p><b>Izin merekam</b> (kalau diaktifkan peneliti): saat pertama kali Anda merekam, aplikasi
meminta izin penutur. Baca pesannya — atau tekan ▶ untuk memutarnya — lalu tekan <b>Ya</b> /
<b>Tidak</b>, atau <b>rekam penutur memberi izin</b> dengan suara, sesuai pilihan peneliti Anda.
Jawaban Anda ikut terkirim bersama hasil kerja.</p>
<p><b>Merekam:</b> <b>Rekam teks baru…</b> memungkinkan Anda merekam langsung di aplikasi — beri
nama teksnya dulu, lalu rekam, dengarkan, dan rekam ulang sampai puas, lalu Simpan. Rekamannya
muncul di pemutar di atas tempat mengetik.</p>
<p><b>Audio:</b> kalau peneliti mengirim tautan dengan rekaman, pemutar audio muncul di atas
tempat mengetik: ▶ untuk putar dan jeda, <b>↺3s</b> untuk mundur tiga detik, dan menu kecepatan
untuk memperlambat suara. Gambar gelombang suara menunjukkan posisi Anda — ketuk untuk melompat,
dan pakai <b>Perbesar</b> untuk melihat lebih rinci. Rekaman tersimpan di perangkat Anda, jadi
tetap bisa dipakai tanpa internet setelah pertama kali.</p>
<p>Hasil kerja Anda tersimpan otomatis di perangkat ini — aplikasi boleh ditutup dan dilanjutkan nanti dari daftar <b>Teks</b>. Kalau teks cerita diubah setelah diglos, arti kata pada kalimat yang berubah mungkin perlu diketik ulang.</p>

<div id="help-research-hidden" hidden>
<p><i>Panduan untuk peneliti disembunyikan di perangkat ini. Kalau Anda peneliti, ketuk tombol ? (Bantuan) 7 kali — atau tekan <b>Ctrl+Alt+R</b> di papan ketik — untuk menampilkan tab Pengaturan dan panduan ini.</i></p>
</div>
<div id="help-researchers">
<h3>Untuk peneliti</h3>
<ul>
  <li><b>Menyiapkan proyek:</b> di tab <b>Pengaturan</b>, isi sistem tulisan bahasa daerah dan bahasa analisis (kode, mis. <code>fau</code> / <code>en</code>, beserta nama dan fon). Klik <b>Salin tautan pengaturan untuk rekan kerja</b> lalu kirim tautannya. Saat dibuka, tautan itu mengatur perangkat mereka — termasuk bahasa tampilan yang sedang Anda pakai.</li>
  <li><b>File:</b> aplikasi ini membaca dan menulis file <code>.flextext</code> FLEx. Analisis yang tidak diubah (morfem, kategori kata, catatan) tetap dipertahankan saat ekspor, kecuali pada kalimat yang teks dasarnya diubah — sama seperti perilaku FLEx. File yang berisi beberapa teks akan diimpor sebagai teks-teks terpisah.</li>
  <li><b>Kembali ke FLEx:</b> di FieldWorks gunakan <i>Texts &amp; Words → Import → FLExText interlinear document</i>.
  File yang dikirim lewat <b>Bagikan</b> bernama <code>….flextext.txt</code> (aplikasi pesan hanya
  menerima jenis file tertentu) — dialog impor FLEx bisa membukanya langsung, atau hapus saja
  <code>.txt</code> dari nama filenya. Aplikasi ini juga bisa membukanya langsung.</li>
  <li><b>Kode sistem tulisan salah?</b> Gunakan <b>Pemeriksa sistem tulisan</b> (tab Pengaturan) untuk melihat kode pada setiap baris interlinear dan menggantinya tanpa mengubah isi lain.</li>
  <li><b>Unggahan ke Drive Anda:</b> atur <b>folder unggahan Google Drive</b> (dibagikan sebagai
  "Siapa saja yang memiliki link dapat mengedit") di pengaturan — tautan Anda lalu memberi rekan
  kerja tombol <b>Kirim Langsung</b> yang mengirim hasil kerja langsung ke folder itu, di-zip
  bersama rekaman buatan mereka sendiri dan izin yang terekam, tanpa pernah menimpa apa pun (nama
  file diberi cap waktu). Unggahan melewati relay tetapi terhitung pada <i>penyimpanan</i> Drive
  Anda, bukan kuota transfer hariannya. Anda juga bisa memilih tombol simpan/kirim mana saja yang
  dilihat rekan kerja lewat kotak centang; pilihan itu ikut dalam tautan Anda.</li>
  <li><b>Pengubah audio:</b> alat perekam sering menghasilkan file WAV yang sangat besar (WAV
  stereo 32-bit 2 menit ≈ 40&nbsp;MB) — terlalu berat untuk dikirim. <b>Pengubah audio</b> di tab
  Pengaturan mengubah rekaman apa pun menjadi MP3 mono 64&nbsp;kbps yang kecil (≈0,5&nbsp;MB per
  menit), di perangkat Anda dan tanpa internet; lalu unggah MP3-nya ke Drive untuk tautan tugas.</li>
  <li><b>Minta izin penutur:</b> di bagian <b>Izin penutur</b> pada tab Pengaturan, Anda bisa
  mewajibkan langkah izin sebelum rekan kerja merekam. Tulis pesannya (dalam bahasa daerah dan/atau
  bahasa pengantar yang lebih luas), boleh juga sertakan versi suaranya (tautan audio Drive, yang
  disimpan di perangkat untuk dipakai tanpa internet), dan pilih cara rekan kerja mengonfirmasi:
  <b>ketuk Ya/Tidak</b>, <b>rekam penutur mengatakan ya</b>, atau <b>ketik nama penutur sebagai
  tanda tangan</b>. Setiap persetujuan menulis berkas <code>consent-receipt.json</code> (+ berkas
  <code>consent-receipt.txt</code> yang mudah dibaca) ke dalam unggahan: mencatat bahwa izin
  diberikan, pesan persis yang ditampilkan, tanggal/waktu, tanda tangan atau rekaman, dan —
  sebisanya — alamat IP perangkat (saat online) serta lokasi perkiraan bila penutur mengizinkan
  (aplikasi menanyakannya sekali, saat ketukan pertama; keduanya tertulis "unavailable" jika
  tidak tersedia). Bila pengingatnya berupa rekaman, salinan persis audio yang didengar penutur
  ikut dibungkus juga — sehingga pertanyaan dan jawaban tetap berpasangan walau nanti Anda
  memperbaiki pengingatnya.</li>
  <li><b>Apa yang dilihat rekan kerja:</b> kotak centang opsi kirim adalah templat untuk tautan
  yang Anda bagikan — menentukan tombol "Simpan & kirim…" mana yang didapat rekan kerja, dan tidak
  pernah membatasi perangkat Anda sendiri. Pembatasan hanya sampai ke sebuah perangkat lewat
  tautan yang dibukanya.</li>
  <li><b>Menyembunyikan tab Pengaturan:</b> dua cara. Untuk rekan kerja <i>jarak jauh</i>, centang
  kotak di bawah tombol salin tautan sebelum menyalin — tab disembunyikan saat mereka membuka
  tautannya. Untuk menyembunyikannya di HP yang Anda siapkan <i>secara langsung</i>, pakai
  <b>Sembunyikan tab Pengaturan di perangkat INI sekarang</b>. Untuk memunculkannya lagi:
  <b>ketuk tombol ? (Bantuan) 7 kali</b> (bisa di layar sentuh) atau tekan <b>Ctrl+Alt+R</b> di papan
  ketik — atau buka tautan yang diakhiri <code>?research=on</code>.</li>
  <li><b>Pembaruan:</b> saat online, aplikasi memeriksa versi baru dan menampilkan tombol <b>Perbarui</b> bila tersedia.</li>
  <li><b>Tautan tugas dengan audio:</b> bagian <b>Tautan tugas</b> membuat tautan yang mengatur
  perangkat rekan kerja, membuat teks berjudul, dan otomatis mengunduh rekaman ke pemutar di tab
  Ketik. Gunakan MP3 mono 64&nbsp;kbps (≈0,5&nbsp;MB per menit). Sebelum tautan dibuat, aplikasi
  memeriksa rekaman dan memperingatkan kalau berupa WAV tak terkompresi, terlalu besar, atau belum
  dibagikan. Audio bisa di host mana pun yang mendukung CORS, atau cukup di <b>Google Drive Anda
  sendiri</b>: unggah MP3, bagikan sebagai
  "Siapa saja yang memiliki link", lalu tempel tautan berbaginya di formulir — relay bawaan
  aplikasi yang mengurus sisanya. (Relay hanya bisa mengambil file yang dibagikan dengan
  tautan; relay tidak punya akses ke isi Drive pribadi siapa pun. Tim yang mem-fork aplikasi
  bisa memakai relay sendiri dengan memasang <code>docs/drive-relay.gs</code> dan mengatur
  <code>DEFAULT_RELAY</code> di <code>js/app.js</code>.)</li>
</ul>
</div>`,
},
};

let cur = detect();

function detect() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && LANGS.includes(saved)) return saved;
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const base = String(l).toLowerCase().split('-')[0];
    if (LANGS.includes(base)) return base;
  }
  return 'en';
}

export function getLang() { return cur; }

export function setLang(lang, { save = true } = {}) {
  if (!LANGS.includes(lang)) return;
  cur = lang;
  if (save) localStorage.setItem(LANG_KEY, lang);
  document.documentElement.lang = lang;
}

export function t(key, vars) {
  let s = S[cur][key] ?? S.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', v);
  return s;
}

// Apply translations to static markup:
//   data-i18n       → textContent
//   data-i18n-html  → innerHTML (trusted static strings only)
//   data-i18n-ph    → placeholder
//   data-i18n-title → title attribute
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  document.documentElement.lang = cur;
}
