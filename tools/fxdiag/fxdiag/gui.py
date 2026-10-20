"""The window: one page, pywebview. It scans, shows every profile that holds suite storage with its
origins and text counts, lets the person tick what to include (texts and recordings are OFF until
ticked — they are the language data), asks where to save, writes the zip, and shows the README.
Everything the page shows comes from the same functions the console uses."""

import json
import threading

import webview

from . import profiles, report

HTML = """<!doctype html><meta charset="utf-8"><title>fxdiag</title>
<style>
body{font:14px system-ui,sans-serif;margin:0;padding:16px;background:#fff;color:#1a1a1a}
h1{font-size:18px;margin:0 0 4px}p{margin:4px 0 12px;color:#444}
.store{border:1px solid #ccc;border-radius:6px;padding:10px;margin:8px 0}
.store h2{font-size:15px;margin:0 0 4px}.o{color:#333;font-size:13px;margin-left:12px}
label{display:block;margin:6px 0}button{font:inherit;padding:8px 14px;margin-top:10px}
pre{background:#f3f3f3;padding:10px;white-space:pre-wrap;font-size:12px}
.warn{color:#8a4b00}
</style>
<h1>fxdiag — FlexText storage on this computer</h1>
<p>Reads <b>only the FlexText suite apps' storage</b> (their origins, databases and settings) from a copy on disk; nothing else in the browser is opened, and nothing is changed. Texts and recordings are language data: they are left out unless you tick them.</p>
<div id="stores">scanning…</div>
<div id="opts" style="display:none">
<label><input type="checkbox" id="flextext"> the texts as <b>.flextext files</b> (what FLEx or another device can open)</label>
<label><input type="checkbox" id="audio"> …with their <b>recordings</b> (large)</label>
<label><input type="checkbox" id="texts"> the full text <b>records</b> as JSON (the app's own stored form)</label>
<label><input type="checkbox" id="raw"> the <b>raw browser storage</b> of the suite's origins (their IndexedDB folders, byte for byte)</label>
<label><input type="checkbox" id="redact"> replace titles in the manifest with a hash</label>
<label>Note for the reader: <input id="note" size="60"></label>
<button id="go">Make the report…</button>
</div>
<pre id="out"></pre>
<script>
async function scan(){
  const stores = await window.pywebview.api.scan();
  const el = document.getElementById('stores'); el.innerHTML='';
  if(!stores.length){ el.textContent='No browser profile with FlexText storage was found on this computer.'; return; }
  for(const s of stores){
    const d=document.createElement('div'); d.className='store';
    d.innerHTML=`<h2><label><input type="checkbox" class="pick" data-slug="${s.slug}" checked> ${s.app} — profile “${s.profileName}”</label></h2>`+
      s.origins.map(o=>`<div class="o">${o.origin} — ${o.appHint}</div>`).join('')+
      (s.installedWebApps&&s.installedWebApps.length?`<div class="o">installed web apps: ${JSON.stringify(s.installedWebApps).slice(0,160)}</div>`:'');
    el.appendChild(d);
  }
  document.getElementById('opts').style.display='';
}
document.getElementById('go').onclick=async()=>{
  const slugs=[...document.querySelectorAll('.pick:checked')].map(e=>e.dataset.slug);
  const out=document.getElementById('out'); out.textContent='working…';
  const r=await window.pywebview.api.make_report(slugs, document.getElementById('texts').checked, document.getElementById('audio').checked,
    document.getElementById('redact').checked, document.getElementById('note').value,
    document.getElementById('flextext').checked, document.getElementById('raw').checked);
  out.textContent=r.error?('Problem: '+r.error):(r.readme+'\\nwritten: '+r.path);
};
window.addEventListener('pywebviewready', scan);
</script>"""


class Api:
    def __init__(self, user_data_dirs, all_users):
        self.user_data_dirs = user_data_dirs
        self.all_users = all_users
        self.window = None
        self._stores = []

    def scan(self):
        self._stores = profiles.discover(self.user_data_dirs, all_users=self.all_users)
        return [s.to_dict() for s in self._stores]

    def make_report(self, slugs, texts, audio, redact, note, flextext=False, raw=False):
        try:
            stores = [s for s in self._stores if s.slug in set(slugs)]
            if not stores:
                return {"error": "nothing ticked"}
            path = self.window.create_file_dialog(webview.SAVE_DIALOG, save_filename="fxdiag-report.zip", file_types=("Zip (*.zip)",))
            if not path:
                return {"error": "cancelled"}
            path = path[0] if isinstance(path, (list, tuple)) else path
            summary = report.build(stores, path, texts="all" if texts else "none", with_audio=bool(audio), redact_titles=bool(redact), note=note or "",
                                   flextext=bool(flextext), raw=bool(raw))
            return {"path": str(path), "readme": report.readme(summary)}
        except Exception as e:   # noqa: BLE001 — the page shows it; the console has the trace
            import traceback
            traceback.print_exc()
            return {"error": "%s: %s" % (type(e).__name__, e)}


def run(user_data_dirs, all_users=False):
    api = Api(list(user_data_dirs or []), all_users)
    api.window = webview.create_window("fxdiag — FlexText storage report", html=HTML, js_api=api, width=820, height=640)
    webview.start()
    return 0
