# Flextext Recovery

One HTML file that gets Flextext texts out of a browser when the app itself cannot save or send
them. It reads the browser's stored files and writes each text exactly as the app's own Save would:
the `.flextext`, and, when the app would zip it, the recording and the other files that go with it.
It works with no internet, from a thumb drive.

## Build

```sh
node recovery/build.mjs        # → recovery/dist/flextext-recovery.html
```

Copy that one file to the thumb drive. Rebuild it after an engine release so it writes what the
current app writes. The page footer shows the engine version it was built with.

## Use

1. Find the browser profile folder on the computer that holds the texts. Chrome on Windows:
   `%LOCALAPPDATA%\Google\Chrome\User Data\Default`. The page lists the other systems, and
   `chrome://version` shows the exact "Profile Path".
2. Open `flextext-recovery.html` in Chrome or Edge, and choose that folder. Another option is to
   copy its `IndexedDB` and `Local Storage` folders into one folder and choose that.
3. Save texts one at a time, or tick several and save them as one zip.
4. **Optional: remove saved texts from the app.** Under each app, *Remove saved texts from the
   app* builds a link to the app's own cleanup command. Open it on the device that holds the texts.
   The app asks before it deletes anything and says how many texts it will delete. The page never
   changes the browser's files itself. It only offers removal for a text that it has saved, that is
   unchanged since, and whose title no other text shares, because the app's link matches texts by
   title.

## Tests

```sh
node test/recovery-tool.test.mjs                                   # pins the port to app.js
node recovery/build.mjs && node test/browser/recovery-e2e.playwright.mjs   # real app vs. tool, byte for byte
```
