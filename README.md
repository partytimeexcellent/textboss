# TextBoss

A shared SMS/MMS inbox for BulkVS phone numbers. Multiple users and multiple numbers, and each user sees only the numbers an admin assigns to them.

- **Messages:** conversation list with a number switcher, search (text, names, patient ID), unread counts, and All / Unread / Flagged / Archived filters. 1:1 and group threads, MMS attachments with a download button, an emoji picker, delivery status, and who on the team sent each message. Pin and flag from the list (hover a row) or the conversation header; the ⋮ menu also has mark unread, archive, opt out/in, block sender, delete history. Pins and flags are shared by the team.
- **Contacts:** first/last name, nickname (shown as "(Bobby) Robert Smith"), mobile phone, date of birth, email, patient ID, notes and opt-out. Several contacts can share one phone (a parent and children).
- **Opt-out:** applies to the phone number. Texting an opted-out number brings up a warning you must confirm by typing SEND, and the server enforces it. Replies of STOP, UNSUBSCRIBE, etc. opt out automatically, and START opts back in.
- **Blocked senders:** their texts are dropped. Manage them in Admin settings.
- **Lists and bulk messages:** tick contacts (or "select all" on a search or list), save them as a named list, and send everyone an individual text with merge fields (`{first_name}`, `{last_name}`, `{full_name}`, `{nickname}`). Sends run in the background at one per second, skipping opted-out and blocked numbers, with a live progress page.
- **Canned responses:** insert from the composer. Optional keyword auto-reply (an exact one-word match) and an away message (auto-reply at most once per conversation every 12 hours).
- **Contact import:** upload .xls/.xlsx/.csv in Admin settings with a preview, push contacts from other software with an API key, or drop exports into a watched folder. WebPT's "Patient Listing" report is recognized as-is.
- **Appearance:** each user picks Light / Dark / Auto and a color theme (presets or custom accent and highlight colors), saved to their account.
- **Active numbers:** untick numbers you don't use in Admin → Numbers and they disappear from the app; with one active number the number selector is hidden.
- **Admin settings** in tabs: BulkVS connection (enter and test credentials in the app; these override `.env`), webhook setup and log, numbers, users, contact import and API keys, blocked numbers.
- **Push notifications:** alerts and an unread badge on the app icon, even when TextBoss is closed. Each device opts in from ⋮ → Notifications, with an option to hide message text on the lock screen. On iPhone and iPad this needs iOS 16.4+ and the app added to the Home Screen from Safari. Android works in Chrome, Firefox, Edge and Samsung Internet, installed or not; most Android launchers show a dot rather than a number on the icon.
- Live updates across all signed-in users (server-sent events), and installable on a phone (PWA).

Stack: Node 22.13+ with the built-in `node:sqlite`, Express 5, and plain JavaScript in the browser, with no build step.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open http://localhost:3000. The first visit asks you to create the admin account. With `BULKVS_USERNAME` empty the app runs in **mock mode**: nothing is sent, and each outgoing text gets a fake reply so you can try the whole flow.

For local runs, add `INSECURE_COOKIES=1` to `.env`, because sign-in cookies are HTTPS-only by default.

## Deploy with Docker Compose

```bash
git clone https://github.com/partytimeexcellent/textboss.git && cd textboss
cp .env.example .env    # set PUBLIC_URL, BULKVS_*, WEBHOOK_SECRET
mkdir -p import && sudo chown 1000:1000 import   # watched folder for contact imports
docker compose up -d --build
```

This runs the app on the `PORT` from `.env` (default 3000). Put your reverse proxy in front of it and set `PUBLIC_URL` to the public `https://` address.

With no reverse proxy, run `docker compose --profile caddy up -d --build` instead. That also starts Caddy, which gets a Let's Encrypt certificate for `DOMAIN`. It needs a DNS record pointing at the server and ports 80/443 open.

Data (database and uploaded media) lives in the `textboss-data` volume. To update, pull the new code and run the same `up` command again.

### Backup, restore and moving servers

**Admin settings → Backup → Download backup** gives you one `.tar.gz` file with everything: messages, contacts, users, settings and attachments. It's taken while the app keeps running. **Restore from a backup** on another TextBoss server replaces its data with the file. The app restarts to finish (Docker does this automatically), and the data it replaced is kept in `pre-restore-<date>/` inside the data volume.

To move servers:
1. Download a backup.
2. Install TextBoss on the new server with the same `.env`. Keep `WEBHOOK_SECRET` so the BulkVS webhook address still works.
3. Create a temporary admin on the new server.
4. Restore the backup.
5. Update the BulkVS Message URL if the domain changed.

Backups contain patient data and saved credentials, so store them privately.

From the command line, `docker compose cp app:/app/data ./backup-$(date +%F)` copies the raw data folder. Stop the app first so the database copy is consistent.

Whatever proxy you use, it must not buffer `/api/events` (server-sent events), or live updates will stall.

### Behind Pangolin

Pangolin's resource authentication (SSO, password or PIN) blocks every request until someone logs in. BulkVS and phone carriers can't log in. Add these **Bypass Auth** rules on the resource's Rules tab:

| Path | Why it must be public |
| --- | --- |
| `/webhook/bulkvs/*` | BulkVS posts incoming texts and delivery receipts here |
| `/media/*` | Carriers download the MMS attachments you send from here |

Both are still protected. The webhook path only accepts the secret in `WEBHOOK_SECRET`, and media file names are 128-bit random IDs.

Other options:
- **Turn off Pangolin auth for this resource** and rely on the app's own login. This is simplest, and it avoids users logging in twice.
- **Keep Pangolin auth for people.** It's an extra layer in front of the app and the API. The bypass rules above are then required, and the PWA's home-screen install can fail if the `manifest.webmanifest` request gets redirected to login. Add `/manifest.webmanifest` and `/icon.svg` as bypass rules if that happens.

## Going live with BulkVS

1. **Host it on public HTTPS.** BulkVS has to reach your webhook, and carriers have to download MMS attachments you send. Any VPS behind Pangolin, Caddy or nginx works. Behind Pangolin, add the bypass rules described above. For testing from your Mac, use `cloudflared tunnel --url http://localhost:3000` or ngrok. Set `PUBLIC_URL` to that address and remove `INSECURE_COOKIES`.
2. **Credentials.** In the [BulkVS portal](https://portal.bulkvs.com/login.php), open **API → API Credentials**. Under "API Information – REST API", copy the **Username** and **Password**. These are separate from your portal login. Enter them in TextBoss under **Admin settings → BulkVS** and click **Test connection**. Alternatively, set `BULKVS_USERNAME` and `BULKVS_PASSWORD` in `.env`; values saved in the app take priority. The saved password is stored in the database, like `.env` stores it on disk, and is never sent back to the browser.
3. **Webhook.** Set `WEBHOOK_SECRET` to a long random string and restart. Open Admin settings in the app and copy the webhook URL. In BulkVS, open **Messaging → Messaging Webhooks**. Under "Message Webhooks", enter a name (e.g. `TextBoss`) in the "Trunk Group" field and paste the URL as the "Message URL", then click **Add**. Click the new webhook in the table to set "Delivery Receipt". Turning it on gives you Delivered/Failed status, but the receipt format is unconfirmed (see below). Set it to false if receipts show up as "not applied" in the webhook log.
4. **Assign the webhook to each number.** In BulkVS, open **Inbound → DIDs – Manage** and click the number. Make sure SMS and MMS are enabled (BulkVS shows a "Disable" button when they already are), and set "Messaging Webhook" to the one you created.
5. **Numbers in the app.** Add each BulkVS number in Admin settings, then assign numbers to users.

Outbound A2P messaging to US carriers also needs a 10DLC brand and campaign registered in BulkVS for each number. Without it, carriers will filter or reject messages.

## Importing contacts

Built for importing the full WebPT patient list over and over. Each run updates what changed, such as a new phone number, and counts everything else as unchanged. Because WebPT is the source of truth, a phone number corrected only in TextBoss is overwritten on the next import, so fix data in WebPT.

All three import paths use the same rules:
- **Header row:** found automatically, even below report title rows. It must have a name column and a phone column.
- **Phone:** the cell phone is used, then a generic phone, then home, then work.
- **Matching:** existing contacts are matched by patient ID, or by phone plus name when there's no ID, and updated rather than duplicated.
- **Never destructive:** imports never delete contacts or clear fields the file doesn't include, such as notes.
- **Bad values:** an invalid phone, email or date of birth doesn't skip the patient. That one value is left out (an existing good value is kept) and listed under "Problems to fix" with the spreadsheet row, name and patient ID. You can download that list as a CSV.

Recognized headers (any case and punctuation): `First Name`, `Name (First)`, `Last Name`, `Name (Last)`, `Name` / `Patient Name` ("Last, First" or "First Last"), `Cell Phone`, `Mobile`, `Phone`, `Home Phone`, `Work Phone`, `Date of Birth` / `DOB`, `Email`, `WebPT Patient ID` / `Patient ID` / `MRN`, `Notes`, `Opt Out`.

- **Upload:** Admin settings → Import contacts. It shows a preview, with new, updated and skipped counts, before saving.
- **Watched folder:** files saved into `import/` (Docker) or `data/import/` (local) are imported within a minute, then moved to `processed/` or `failed/`. Results appear under Admin settings → Recent imports. The export software can save straight into this folder, or into a network share mounted there.
- **API:** create a key under Admin settings → Contact import API, then:

  ```bash
  curl -X POST https://YOUR-DOMAIN/api/v1/contacts \
    -H "Authorization: Bearer tbk_..." -H "Content-Type: application/json" \
    -d '{"contacts":[{"firstName":"Jane","lastName":"Doe","phone":"5415550100","dob":"1980-01-31","patientId":"12345"}]}'
  ```

  You can also send a spreadsheet export as the body, with `Content-Type: application/vnd.ms-excel` (or `text/csv`, or the .xlsx type). Add `?dryRun=1` to preview.

  If Pangolin auth is on, add `/api/v1/*` as a bypass rule for software outside your network. The API key still protects it.

## Things to verify on first real use

Sending and receiving texts are confirmed working with BulkVS. Delivery receipts aren't confirmed yet: the parser looks for `RefId` and `DeliveryReceipt` fields. Every raw webhook body is stored and shown under Admin settings → Recent webhook calls. If receipts show as "not applied" there, `parseWebhook()` in [src/bulkvs.js](src/bulkvs.js) is the only place to adjust.

## Layout

```
src/server.js            HTTP routes: auth, conversations, uploads, admin, webhook
src/routes/contacts.js   Contacts, lists, canned responses, bulk messages, opt-out/block
src/routes/importApi.js  API-key contact import (/api/v1/contacts)
src/messaging.js         Inbound (STOP/START, blocking, auto-replies), outbound, receipts, bulk queue
src/contacts.js          Contact helpers and spreadsheet import (SheetJS)
src/watcher.js           Watched import folder
src/backup.js            Backup download, restore staging and swap-in at startup
src/push.js              Web Push (VAPID keys, subscriptions, sending, badge counts)
public/sw.js             Service worker: shows push notifications, sets the app badge
src/bulkvs.js            All BulkVS-specific code (send, connection test, webhook parsing)
src/provider.js          BulkVS credentials (admin settings, then .env)
src/db.js                SQLite schema, migrations and access helpers
src/auth.js              Password hashing (scrypt) and cookie sessions
src/events.js            Server-sent events hub
public/app.js            Web app shell, inbox and threads
public/js/               Contacts, canned responses, admin, theme picker, shared helpers
data/                    SQLite database and uploaded media (created at runtime)
```

Back up `data/` to keep your message history.
