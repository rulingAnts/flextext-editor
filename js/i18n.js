/* i18n.js — UI localization (English / Indonesian).
 * Language is auto-detected from the browser, can be overridden by the user
 * (persisted), and can arrive via the setup link (?lang=id).
 */

const LANG_KEY = 'flextext-lang';
export const LANGS = ['en', 'id'];

const S = {
en: {
  'tabs.texts': 'Texts',
  'tabs.research': 'Research',
  'tabs.baseline': 'Baseline',
  'tabs.gloss': 'Gloss',
  'btn.saveSend': 'Save and send…',
  'btn.back': 'Back to texts',
  'btn.help': 'Help',
  'help.close': '← Back',

  'texts.new': '+ New text',
  'texts.newAudio': '+ New text from audio…',
  'texts.open': 'Open .flextext file…',
  'texts.empty': 'No texts yet. Tap <b>New text</b> to start transcribing, or open an existing <code>.flextext</code> file.',
  'texts.deleteTitle': 'Delete',
  'texts.confirmDelete': 'Delete "{title}" from this device?\n(Make sure it has been saved/sent if you need it.)',
  'texts.meta': '{n} sentences · {g} glossed · {date}',
  'untitled': 'Untitled text',

  'banner.set': 'Writing systems: {vern} → {anal}',
  'banner.unset': 'No writing systems set yet — new texts will use placeholder codes. Ask your researcher for a setup link, or use the <b>Research</b> tab.',

  'baseline.hint': 'Type or paste the text. Press <b>Enter</b> for a new paragraph. Sentences are split automatically at <code>. ! ?</code>',
  'baseline.placeholder': 'Type the text here in the vernacular language…',

  'gloss.empty': 'Nothing to gloss yet — enter the text on the <b>Baseline</b> tab first.',
  'gloss.wordLabel': 'Word',
  'gloss.glossLabel': 'Gloss',
  'gloss.freeLabel': 'Free',
  'gloss.freePlaceholder': 'Free translation…',
  'gloss.chainTitle': 'Merge these two words into one phrase',
  'gloss.breakLabel': '✂ break',
  'gloss.breakTitle': 'Break this phrase back into separate words',

  'share.title': 'Save and send',
  'share.share': 'Share…',
  'share.saveas': 'Save to file…',
  'share.download': 'Download',
  'share.cancel': 'Cancel',

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

  'toast.settingsSaved': 'Writing system settings saved.',
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
  'player.downloaded': 'Audio downloaded — ready to transcribe.',
  'player.downloadFailed': 'Audio could not be downloaded now — the app will keep trying when online.',
  'player.confirmRemove': 'Remove the audio recording from this text?',

  'task.h': 'Task link (text + audio)',
  'task.note': 'Create a link that sets up your coworker\'s device <em>and</em> opens a new text for them — with an audio recording that downloads automatically and plays right above the typing area. For audio in Google Drive, share the file ("Anyone with the link"), paste the share link here, and set the relay URL once (see Help for the one-time relay setup).',
  'task.title': 'Text title',
  'task.audio': 'Audio (Drive share link, file ID, or direct URL)',
  'task.relay': 'Drive relay URL (saved; needed for Drive links)',
  'task.copy': 'Copy task link',
  'task.needRelay': 'A Drive link needs the relay URL — set it once below (see Help → For researchers).',
  'task.badAudio': 'Could not understand the audio link. Paste a Google Drive share link or a direct https:// audio URL.',
  'task.received': 'New task received — listen and type. The audio is downloading…',
  'task.alreadyHere': 'This task is already on this device — opening it.',

  'update.available': 'A new version of the app is available.',
  'update.now': 'Update',

  'install.text': 'You can install this app on your device — it then works without internet, like a normal app.',
  'install.btn': 'Install app',
  'install.done': 'App installed — find it on your home screen or desktop.',
  'webkit.warning': 'This app does not fully work in Safari or on iPhone/iPad. Please use Firefox or Chrome on Android, Windows, Mac, or Linux.',

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
  <li><b>Send your work:</b> tap <b>Save and send…</b> and choose WhatsApp, email, or another app.</li>
</ol>
<p><b>Audio:</b> if your researcher sent you a link with a recording, a player appears above the
typing area: ▶ plays and pauses, <b>↺3s</b> jumps back three seconds, and the speed menu slows
the voice down. The picture of the sound (waveform) shows where you are — tap it to jump, and
use <b>Zoom</b> to see more detail. The recording is saved on your device, so it works without
internet after the first time.</p>
<p>Your work is saved automatically on this device — you can close the app and continue later from the <b>Texts</b> list. If you change the story text afterwards, the word meanings of changed sentences may need to be typed again.</p>

<h3>For researchers</h3>
<ul>
  <li><b>Set up a project:</b> on the <b>Research</b> tab, enter the vernacular and analysis writing systems (code, e.g. <code>fau</code> / <code>en</code>, plus name and font). Click <b>Copy setup link for coworker</b> and send the link. Opening it configures their device — including the interface language you are currently using.</li>
  <li><b>Files:</b> the app reads and writes FLEx <code>.flextext</code> files. Existing analyses it does not edit (morphemes, word categories, notes) are preserved on export, except in sentences whose baseline was changed — same behavior as FLEx. Files containing several texts are imported as separate texts in the list.</li>
  <li><b>Back into FLEx:</b> in FieldWorks use <i>Texts &amp; Words → Import → FLExText interlinear document</i>.</li>
  <li><b>Wrong writing-system codes?</b> Use the <b>Writing system checker</b> (Research tab) to see which codes each interlinear line uses and remap them without touching anything else.</li>
  <li><b>Updates:</b> when online, the app checks for new versions and shows an <b>Update</b> button when one is ready.</li>
  <li><b>Audio task links:</b> the <b>Task link</b> section creates a link that configures the
  coworker's device, creates a titled text, and auto-downloads a recording into a player on the
  typing tab. Use mono 64&nbsp;kbps MP3 (≈0.5&nbsp;MB per minute). The audio can live on any
  CORS-friendly host, or in <b>your own Google Drive</b> via a small relay:
  <ol>
    <li>One person (once, for the whole team) deploys the relay script from
    <code>docs/drive-relay.gs</code> in the app repository: open
    <a href="https://script.google.com" target="_blank" rel="noopener">script.google.com</a>,
    paste the script, <i>Deploy → New deployment → Web app</i>, "Execute as: me",
    "Who has access: Anyone", and copy the <code>…/exec</code> URL.</li>
    <li>Every researcher then just pastes that relay URL into the Task link form (saved on
    their device) — no Apps Script needed for them.</li>
    <li>Per recording: upload the MP3 to Drive, share it as "Anyone with the link", and paste
    the share link into the form. The relay only fetches link-shared files; it has no access
    to anyone's private Drive contents.</li>
  </ol></li>
</ul>`,
},

id: {
  'tabs.texts': 'Teks',
  'tabs.research': 'Penelitian',
  'tabs.baseline': 'Ketik',
  'tabs.gloss': 'Terjemahan Balik',
  'btn.saveSend': 'Simpan & kirim…',
  'btn.back': 'Kembali ke daftar teks',
  'btn.help': 'Bantuan',
  'help.close': '← Kembali',

  'texts.new': '+ Teks baru',
  'texts.open': 'Buka file .flextext…',
  'texts.empty': 'Belum ada teks. Tekan <b>Teks baru</b> untuk mulai mengetik, atau buka file <code>.flextext</code> yang sudah ada.',
  'texts.deleteTitle': 'Hapus',
  'texts.confirmDelete': 'Hapus "{title}" dari perangkat ini?\n(Pastikan sudah disimpan/dikirim kalau masih diperlukan.)',
  'texts.meta': '{n} kalimat · {g} glos terisi · {date}',
  'untitled': 'Teks tanpa judul',

  'banner.set': 'Sistem tulisan: {vern} → {anal}',
  'banner.unset': 'Sistem tulisan belum diatur — teks baru akan memakai kode sementara. Minta tautan pengaturan dari peneliti, atau buka tab <b>Penelitian</b>.',

  'baseline.hint': 'Ketik atau tempel teks di sini. Tekan <b>Enter</b> untuk paragraf baru. Kalimat dipisah otomatis pada <code>. ! ?</code>',
  'baseline.placeholder': 'Ketik teks bahasa daerah di sini…',

  'gloss.empty': 'Belum ada yang bisa dikerjakan — ketik teksnya di tab <b>Ketik</b> dulu.',
  'gloss.wordLabel': 'Asli',
  'gloss.glossLabel': 'Harfiah',
  'gloss.freeLabel': 'Bebas',
  'gloss.freePlaceholder': 'Terjemahan bebas…',
  'gloss.chainTitle': 'Gabungkan dua kata ini menjadi satu frasa',
  'gloss.breakLabel': '✂ pisah',
  'gloss.breakTitle': 'Pisahkan frasa ini menjadi kata-kata lagi',

  'share.title': 'Simpan dan kirim',
  'share.share': 'Bagikan…',
  'share.saveas': 'Simpan ke file…',
  'share.download': 'Unduh',
  'share.cancel': 'Batal',

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

  'toast.settingsSaved': 'Pengaturan sistem tulisan disimpan.',
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
  'player.downloaded': 'Audio sudah terunduh — siap diketik.',
  'player.downloadFailed': 'Audio belum bisa diunduh sekarang — aplikasi akan terus mencoba saat online.',
  'player.confirmRemove': 'Hapus rekaman audio dari teks ini?',

  'task.h': 'Tautan tugas (teks + audio)',
  'task.note': 'Buat tautan yang mengatur perangkat rekan kerja Anda <em>dan</em> langsung membuka teks baru — dengan rekaman audio yang terunduh otomatis dan bisa diputar tepat di atas tempat mengetik. Untuk audio di Google Drive: bagikan filenya ("Siapa saja yang memiliki link"), tempel tautannya di sini, dan isi URL relay sekali saja (lihat Bantuan untuk penyiapan relay).',
  'task.title': 'Judul teks',
  'task.audio': 'Audio (tautan berbagi Drive, ID file, atau URL langsung)',
  'task.relay': 'URL relay Drive (tersimpan; diperlukan untuk tautan Drive)',
  'task.copy': 'Salin tautan tugas',
  'task.needRelay': 'Tautan Drive memerlukan URL relay — isi sekali di bawah (lihat Bantuan → Untuk peneliti).',
  'task.badAudio': 'Tautan audio tidak dikenali. Tempel tautan berbagi Google Drive atau URL audio https:// langsung.',
  'task.received': 'Tugas baru diterima — dengarkan dan ketik. Audio sedang diunduh…',
  'task.alreadyHere': 'Tugas ini sudah ada di perangkat ini — sedang dibuka.',

  'update.available': 'Versi baru aplikasi ini tersedia.',
  'update.now': 'Perbarui',

  'install.text': 'Aplikasi ini bisa dipasang di perangkat Anda — setelah itu bisa dipakai tanpa internet, seperti aplikasi biasa.',
  'install.btn': 'Pasang aplikasi',
  'install.done': 'Aplikasi terpasang — cari di layar utama atau desktop.',
  'webkit.warning': 'Aplikasi ini tidak berfungsi penuh di Safari atau di iPhone/iPad. Silakan pakai Firefox atau Chrome di Android, Windows, Mac, atau Linux.',

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
  <li><b>Kirim hasil kerja:</b> tekan <b>Simpan & kirim…</b> lalu pilih WhatsApp, email, atau aplikasi lain.</li>
</ol>
<p><b>Audio:</b> kalau peneliti mengirim tautan dengan rekaman, pemutar audio muncul di atas
tempat mengetik: ▶ untuk putar dan jeda, <b>↺3s</b> untuk mundur tiga detik, dan menu kecepatan
untuk memperlambat suara. Gambar gelombang suara menunjukkan posisi Anda — ketuk untuk melompat,
dan pakai <b>Perbesar</b> untuk melihat lebih rinci. Rekaman tersimpan di perangkat Anda, jadi
tetap bisa dipakai tanpa internet setelah pertama kali.</p>
<p>Hasil kerja Anda tersimpan otomatis di perangkat ini — aplikasi boleh ditutup dan dilanjutkan nanti dari daftar <b>Teks</b>. Kalau teks cerita diubah setelah diglos, arti kata pada kalimat yang berubah mungkin perlu diketik ulang.</p>

<h3>Untuk peneliti</h3>
<ul>
  <li><b>Menyiapkan proyek:</b> di tab <b>Penelitian</b>, isi sistem tulisan bahasa daerah dan bahasa analisis (kode, mis. <code>fau</code> / <code>en</code>, beserta nama dan fon). Klik <b>Salin tautan pengaturan untuk rekan kerja</b> lalu kirim tautannya. Saat dibuka, tautan itu mengatur perangkat mereka — termasuk bahasa tampilan yang sedang Anda pakai.</li>
  <li><b>File:</b> aplikasi ini membaca dan menulis file <code>.flextext</code> FLEx. Analisis yang tidak diubah (morfem, kategori kata, catatan) tetap dipertahankan saat ekspor, kecuali pada kalimat yang teks dasarnya diubah — sama seperti perilaku FLEx. File yang berisi beberapa teks akan diimpor sebagai teks-teks terpisah.</li>
  <li><b>Kembali ke FLEx:</b> di FieldWorks gunakan <i>Texts &amp; Words → Import → FLExText interlinear document</i>.</li>
  <li><b>Kode sistem tulisan salah?</b> Gunakan <b>Pemeriksa sistem tulisan</b> (tab Penelitian) untuk melihat kode pada setiap baris interlinear dan menggantinya tanpa mengubah isi lain.</li>
  <li><b>Pembaruan:</b> saat online, aplikasi memeriksa versi baru dan menampilkan tombol <b>Perbarui</b> bila tersedia.</li>
  <li><b>Tautan tugas dengan audio:</b> bagian <b>Tautan tugas</b> membuat tautan yang mengatur
  perangkat rekan kerja, membuat teks berjudul, dan otomatis mengunduh rekaman ke pemutar di tab
  Ketik. Gunakan MP3 mono 64&nbsp;kbps (≈0,5&nbsp;MB per menit). Audio bisa di host mana pun yang
  mendukung CORS, atau di <b>Google Drive Anda sendiri</b> lewat relay kecil:
  <ol>
    <li>Satu orang (sekali saja, untuk seluruh tim) memasang skrip relay dari
    <code>docs/drive-relay.gs</code> di repositori aplikasi: buka
    <a href="https://script.google.com" target="_blank" rel="noopener">script.google.com</a>,
    tempel skripnya, <i>Deploy → New deployment → Web app</i>, "Execute as: me",
    "Who has access: Anyone", lalu salin URL <code>…/exec</code>-nya.</li>
    <li>Setiap peneliti cukup menempel URL relay itu di formulir Tautan tugas (tersimpan di
    perangkatnya) — tidak perlu Apps Script sama sekali.</li>
    <li>Untuk tiap rekaman: unggah MP3 ke Drive, bagikan sebagai "Siapa saja yang memiliki
    link", lalu tempel tautan berbaginya di formulir. Relay hanya bisa mengambil file yang
    dibagikan dengan tautan; relay tidak punya akses ke isi Drive pribadi siapa pun.</li>
  </ol></li>
</ul>`,
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
