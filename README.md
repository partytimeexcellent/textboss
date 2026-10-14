# TextBoss

A shared SMS/MMS inbox for BulkVS or VoIP.ms phone numbers. Multiple users and multiple numbers, and each user sees only the numbers an admin assigns to them.

- **User manual:** ⋮ → Help → User manual opens a full illustrated manual at `/manual/` (signed-in staff only), in two parts: everyday use and admin settings. Settings pages have a **?** that jumps to the matching section. The screenshots come from a fictional demo company ("The Business Factory"); see [Updating the manual](#updating-the-manual).
- **Tips tour:** ⋮ → Help → Tips and newer features walks through newer features (client panel, shared numbers, side-by-side, pausing notifications, appearance) with links into the manual. It shows once, automatically, to people who already did the welcome tour.
- **Welcome tour:** each person's first sign-in starts a click-through tour that highlights the real parts of the app (conversations, search, writing replies, contacts and bulk texts, notifications, installing it as an app on iPhone, Android, Mac or Windows) and ends with a checklist of setup still to do: notifications, email, two-factor and, for admins, Admin settings. Replay it from ⋮ → Take the tour.
- **Messages:** conversation list with a number switcher, search (text, names, client ID), unread counts, and All / Unread / Flagged / Archived filters. 1:1 and group threads, MMS attachments with a download button, an emoji picker, and delivery status. Every conversation on a number is one shared thread for the whole team. Every text from the team shows who sent it, and a teammate's are a different shade from yours (your own name can be hidden under ⋮ → Appearance). Pin and flag from the list (hover a row) or the conversation header; the ⋮ menu also has mark unread, archive, opt out/in, block sender, and (admins only) delete history. Only admins can delete conversations or contacts. Pins and flags are shared by the team. Live updates reconnect on their own when a phone wakes the app or the network changes, and anything missed is fetched; the small Refresh button at the bottom of the conversation list reloads the app by hand (handy in the home-screen app, which has no reload button). The ⋮ menu holds My account (password, two-factor sign-in, email, devices), Appearance, Notifications, Canned responses, Admin settings and Help (the manual and both tours).
- **Big screens:** a conversation's messages and message box stay in a readable centered column instead of stretching edge to edge (⋮ → Appearance → Conversation width: Narrow 520px, Comfortable 620px or Full width). Appearance → Conversation background sets how the column stands out from the empty space beside it: Plain, Shaded column or Card. Narrow and Card are the defaults, and your own name shows on messages you send. When a conversation has room, a client details panel sits beside it: phone, birthday and age, client ID, email, lists and notes, with an Edit button; shared numbers and group texts list everyone. The panel button in the conversation header hides or shows it, and the choice is saved per person.
- **Side-by-side conversations (desktop):** open up to three conversations at once with Cmd/Ctrl-click or the Open beside button on a list row. A normal click replaces the active pane, and each pane has its own message box, menu and close button. Narrower windows show as many as fit; phones show one.
- **Contacts:** first/last name, nickname (shown as `"Bobby" Robert Smith`), mobile phone, date of birth, email, client ID, notes and opt-out. Several contacts can share one phone (a parent and children); conversations show the oldest contact's name unless you pick another with **Show this name for the number** on a contact page or in the client panel. That contact is also used for merge fields like `{first_name}` and for notifications.
- **Inactive contacts:** when an uploaded import is a full client list (most rows have a client ID), the preview lists clients in TextBoss who aren't in the file, such as discharged clients, with checkboxes to mark them inactive. Imports from the watched folder or the API keep that list for **Review** in the import history, or the watched folder can mark them inactive automatically (Admin → Contacts & Import → Inactive contacts; skipped if more than half would go at once, which looks like a partial export). Contacts can also go inactive after a chosen time with no activity (6 months to 3 years, or a custom number of days), or be marked inactive by hand on the contact page. Inactive contacts are hidden from Contacts, searches, list counts and bulk messages, but keep their names on conversations. Any text to or from them, or appearing in a later import, makes them active again. Browse and reactivate them under Admin → Contacts & Import.
- **Opt-out:** applies to the phone number. Texting an opted-out number brings up a warning you must confirm by typing SEND, and the server enforces it. Replies of STOP, UNSUBSCRIBE, etc. opt out automatically, and START opts back in.
- **Blocked senders:** their texts are dropped. Only admins can block or unblock, from a conversation's ⋮ menu or Admin settings.
- **Lists and bulk messages:** tick contacts (or "select all" on a search or list), save them as a named list, and send everyone an individual text with merge fields (`{first_name}`, `{last_name}`, `{full_name}`, `{nickname}`). Sends run in the background at one per second, skipping opted-out and blocked numbers, with a live progress page.
- **Canned responses:** insert from the composer. Optional keyword auto-reply (an exact one-word match) and an away message (auto-reply at most once per conversation every 12 hours).
- **Office hours:** Admin settings → Office hours sets weekly hours (with an optional lunch break), a time zone, and holidays or closures by date (one click adds the common US holidays). While closed, incoming texts get the after-hours reply automatically, once per conversation per closed stretch; a closure can have its own message ("Closed for Thanksgiving, back Monday"). Merge fields work. Keyword replies still work any time, and a manually switched-on away message takes priority over the schedule for unplanned closures.
- **Contact import:** upload .xls/.xlsx/.csv in Admin settings with a preview, push contacts from other software with an API key, or drop exports into a watched folder. WebPT's "Patient Listing" report is recognized as-is.
- **Appearance:** each user picks Light / Dark / Auto, a color theme (presets or custom accent and highlight colors), and an app icon design (presets or custom background fade, bubble colors and logo size), saved to their account. The icon is used for the browser tab, sidebar, notifications and, once the app is re-added, the home-screen icon.
- **Active numbers:** untick numbers you don't use in Admin → Numbers and they disappear from the app; with one active number the number selector is hidden.
- **Admin settings** in tabs: texting provider, BulkVS or VoIP.ms (enter and test credentials in the app; these override `.env`), webhook setup and log, numbers, users, contact import and API keys, blocked numbers.
- **Push notifications:** alerts and an unread badge on the app icon, even when TextBoss is closed. Each device opts in from ⋮ → Notifications (or the bell next to ⋮); once on, the bell pauses and resumes alerts on that device with one click, with an option to hide message text on the lock screen. On iPhone and iPad this needs iOS 16.4+ and the app added to the Home Screen from Safari. Android works in Chrome, Firefox, Edge and Samsung Internet, installed or not; most Android launchers show a dot rather than a number on the icon.
- Live updates across all signed-in users (server-sent events), and installable on a phone (PWA).

Stack: Node 22.13+ with the built-in `node:sqlite`, Express 5, and plain JavaScript in the browser, with no build step.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open http://localhost:3000. The first visit asks you to create the admin account. With `BULKVS_USERNAME` empty the app runs in **mock mode**: nothing is sent, and each outgoing text gets a fake reply so you can try the whole flow.

Signing in works over plain `http://` on your local network (for example before the reverse proxy is set up). Sign-in cookies are marked Secure automatically once TextBoss is reached over HTTPS.

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

### Sign-in security

- **Two-factor sign-in:** each person adds an authenticator app (six-digit codes) and/or passkeys under ⋮ → My account. Passkeys cover Face ID, Touch ID, Windows Hello, Android screen lock and USB/NFC keys like YubiKey, and work with or without a password. Add a passkey on each device: ones saved in Apple Passwords or Google Password Manager only appear on devices signed in to the same Apple or Google account.
- **Email:** set up sending under Admin settings → Email (any SMTP account; Gmail, Microsoft 365 and iCloud need an app password). Each person adds their address under ⋮ → Security, or an admin adds it under Users. Then "Forgot password?" appears on the sign-in screen, and anyone without their passkey or authenticator app can choose "Email me a code" as the second step. Codes are 6 digits, expire in 10 minutes and work once. Anyone who can read a person's email can get into their account, so staff should protect their email accounts too.
- **Reminders:** people without two-factor sign-in see a banner in the app ("Remind me tomorrow" snoozes it for a day on all their devices) and get a daily email if they have an address and email is set up. It starts a day after their account is created and stops once they're set up. Admin settings → Users → Sign-in security has the switch.
- **Passwords:** at least 10 characters, not a common or easily guessed password, not a simple pattern, and not built from the person's username, name or email (following NIST guidance; no forced symbols or expiry). New accounts need an email address, used for password resets and sign-in codes.
- **Require it for everyone:** Admin settings → Users → Sign-in security. People without 2FA are walked through setup the next time they use TextBoss. Admins must set up their own first.
- **Lost phone or key:** use an emailed code, then add a new passkey. Without email: Admin settings → Users → Reset 2FA, or `docker compose exec app node src/cli.js reset-2fa <username>`.
- **Brute-force protection:** 8 wrong passwords or 6 wrong codes lock that username for 15 minutes. Each IP address is limited to 30 failures.
- **Passkeys need HTTPS** and are tied to `PUBLIC_URL`'s domain, so set `PUBLIC_URL` to the exact address people use. They aren't offered over `http://` on the local network. Authenticator codes work everywhere.
- **Security headers:** TextBoss sends CSP, frame-blocking and HSTS headers. Behind a proxy, `TRUST_PROXY` (default: private networks) decides whose `X-Forwarded-For` is trusted for the client IP.

### Locked out?

Run these on the server:

```bash
docker compose exec app node src/cli.js list-users
docker compose exec app node src/cli.js reset-password <username>
docker compose exec app node src/cli.js reset-2fa <username>
docker compose exec app node src/cli.js make-admin <username>
```

`reset-password` prints a temporary password and signs that user out everywhere. Pass a password as a third argument to set it directly. Without Docker, run the same commands with `node src/cli.js ...` from the project folder.

### Backup, restore and moving servers

**Admin settings → Backup → Download backup** gives you one `.tar.gz` file with everything: messages, contacts, users, settings and attachments. It's taken while the app keeps running. **Restore from a backup** on another TextBoss server replaces its data with the file. The app restarts to finish (Docker does this automatically), and the data it replaced is kept in `pre-restore-<date>/` inside the data volume.

To move servers:
1. Download a backup.
2. Install TextBoss on the new server with the same `.env`. Keep `WEBHOOK_SECRET` so the incoming-text address still works.
3. Create a temporary admin on the new server.
4. Restore the backup.
5. Update the incoming-text address in BulkVS or VoIP.ms if the domain changed.

Backups contain client data and saved credentials, so store them privately.

From the command line, `docker compose cp app:/app/data ./backup-$(date +%F)` copies the raw data folder. Stop the app first so the database copy is consistent.

Whatever proxy you use, it must not buffer `/api/events` (server-sent events), or live updates will stall.

### Behind Pangolin

Pangolin's resource authentication (SSO, password or PIN) blocks every request until someone logs in. Your texting provider and phone carriers can't log in. Add these **Bypass Auth** rules on the resource's Rules tab:

| Path | Why it must be public |
| --- | --- |
| `/webhook/bulkvs/*` | BulkVS posts incoming texts and delivery receipts here |
| `/webhook/voipms/*` | VoIP.ms sends incoming texts here |
| `/media/*` | Carriers download the MMS attachments you send from here |

Both are still protected. The webhook path only accepts the secret in `WEBHOOK_SECRET`, and media file names are 128-bit random IDs.

Other options:
- **Turn off Pangolin auth for this resource** and rely on the app's own login. This is simplest, and it avoids users logging in twice.
- **Keep Pangolin auth for people.** It's an extra layer in front of the app and the API. The bypass rules above are then required, and the PWA's home-screen install can fail if the `manifest.webmanifest` request gets redirected to login. Add `/manifest.webmanifest` and `/icon.svg` as bypass rules if that happens.

## Going live with BulkVS

1. **Host it on public HTTPS.** BulkVS has to reach your webhook, and carriers have to download MMS attachments you send. Any VPS behind Pangolin, Caddy or nginx works. Behind Pangolin, add the bypass rules described above. For testing from your Mac, use `cloudflared tunnel --url http://localhost:3000` or ngrok. Set `PUBLIC_URL` to that address.
2. **Credentials.** In the [BulkVS portal](https://portal.bulkvs.com/login.php), open **API → API Credentials**. Under "API Information – REST API", copy the **Username** and **Password**. These are separate from your portal login. Enter them in TextBoss under **Admin settings → BulkVS** and click **Test connection**. Alternatively, set `BULKVS_USERNAME` and `BULKVS_PASSWORD` in `.env`; values saved in the app take priority. The saved password is stored in the database, like `.env` stores it on disk, and is never sent back to the browser.
3. **Webhook.** Set `WEBHOOK_SECRET` to a long random string and restart. Open Admin settings in the app and copy the webhook URL. In BulkVS, open **Messaging → Messaging Webhooks**. Under "Message Webhooks", enter a name (e.g. `TextBoss`) in the "Trunk Group" field and paste the URL as the "Message URL", then click **Add**. Click the new webhook in the table to set "Delivery Receipt". Turning it on gives you Delivered/Failed status, but the receipt format is unconfirmed (see below). Set it to false if receipts show up as "not applied" in the webhook log.
4. **Assign the webhook to each number.** In BulkVS, open **Inbound → DIDs – Manage** and click the number. Make sure SMS and MMS are enabled (BulkVS shows a "Disable" button when they already are), and set "Messaging Webhook" to the one you created.
5. **Numbers in the app.** Add each BulkVS number in Admin settings, then assign numbers to users.

Outbound A2P messaging to US carriers also needs a 10DLC brand and campaign registered in BulkVS for each number. Without it, carriers will filter or reject messages.

## Going live with VoIP.ms

1. **Host it on public HTTPS,** as for BulkVS.
2. **API access.** In the [VoIP.ms portal](https://voip.ms/), open **Main Menu → SOAP and REST/JSON API**. Set an **API password** (separate from your account password), click **Enable/Disable API** to turn it on, and add your server's public IP address under **Enabled IP Addresses**. VoIP.ms refuses API calls from any other IP.
3. **Credentials.** In TextBoss, open Admin settings → Provider, choose **VoIP.ms**, enter your VoIP.ms login email and the API password, and click **Save and use VoIP.ms**. It tests the connection straight away. (Or set `VOIPMS_USERNAME` and `VOIPMS_PASSWORD` in `.env`.)
4. **Incoming texts.** Set `WEBHOOK_SECRET` and restart, then copy the address from Admin settings → Provider (VoIP.ms selected). In VoIP.ms open **DID Numbers → Manage DIDs**, edit each number, turn on SMS/MMS, tick **SMS URL Callback**, paste the address and apply. URL Callback Retry is safe to turn on; TextBoss ignores repeats.
5. **Numbers in the app.** Add each number in Admin settings → Numbers, then assign numbers to users.

Differences from BulkVS: VoIP.ms can't send group texts (TextBoss won't start one), it doesn't report delivery, so messages stay at Sent, and texts longer than 160 characters or with attachments go out as MMS (up to 2,048 characters and 3 attachments). VoIP.ms also needs 10DLC registration for business texting to US carriers.

## Importing contacts

Built for importing the full WebPT client list over and over. Each run updates what changed, such as a new phone number, and counts everything else as unchanged. Because WebPT is the source of truth, a phone number corrected only in TextBoss is overwritten on the next import, so fix data in WebPT.

All three import paths use the same rules:
- **Header row:** found automatically, even below report title rows. It must have a name column and a phone column.
- **Phone:** the cell phone is used, then a generic phone, then home, then work.
- **Matching:** existing contacts are matched by client ID, or by phone plus name when there's no ID, and updated rather than duplicated.
- **Never destructive:** imports never delete contacts or clear fields the file doesn't include, such as notes.
- **Bad values:** an invalid phone, email or date of birth doesn't skip the client. That one value is left out (an existing good value is kept) and listed under "Problems to fix" with the spreadsheet row, name and client ID. You can download that list as a CSV. The list is saved with every import (upload, watched folder or API): **Problems to fix** in Admin → Contacts & Import shows the latest one, and **View** in the import history opens any earlier one, each with a CSV download.

Recognized headers (any case and punctuation): `First Name`, `Name (First)`, `Last Name`, `Name (Last)`, `Name` / `Patient Name` / `Client Name` ("Last, First" or "First Last"), `Cell Phone`, `Mobile`, `Phone`, `Home Phone`, `Work Phone`, `Date of Birth` / `DOB`, `Email`, `WebPT Patient ID` / `Patient ID` / `Client ID` / `MRN`, `Notes`, `Opt Out`.

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

Sending, receiving and delivery receipts are confirmed working with BulkVS. Turn on delivery receipts (DLR) on the BulkVS messaging webhook; BulkVS sends each one as a carrier-format message (`id:… stat:DELIVRD err:000 text:…`), which TextBoss applies to the matching sent text (Sent → Delivered, or Failed with the reason) instead of showing it. Every raw webhook body is stored and shown under Admin settings → Recent webhook calls. If receipts show as "not applied" there, `parseWebhook()` in [src/bulkvs.js](src/bulkvs.js) is the only place to adjust.

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
src/cli.js               Account recovery: list users, reset a password or 2FA, make an admin
src/mfa.js               Two-factor: authenticator codes (TOTP), passkeys (WebAuthn)
src/email.js             SMTP sending, password-reset and sign-in codes by email
src/security.js          Login throttling and HTTP security headers
public/sw.js             Service worker: shows push notifications, sets the app badge
src/bulkvs.js            All BulkVS-specific code (send, connection test, webhook parsing)
src/voipms.js            All VoIP.ms-specific code (send, connection test, URL callback parsing)
src/provider.js          Which provider is in use, and its credentials (admin settings, then .env)
src/db.js                SQLite schema, migrations and access helpers
src/auth.js              Password hashing (scrypt) and cookie sessions
src/events.js            Server-sent events hub
public/app.js            Web app shell, inbox and threads
public/js/               Contacts, canned responses, admin, theme picker, logo generator, shared helpers
data/                    SQLite database and uploaded media (created at runtime)
```

Back up `data/` to keep your message history.

## Updating the manual

The manual lives in `public/manual/` (`index.html`, `manual.css`, `manual.js` and the screenshots in `img/`). The screenshots are taken automatically from a demo copy of TextBoss filled with fictional data, so they can be retaken whenever the interface changes:

```bash
npm install
npm run manual:screenshots
```

This seeds `demo-data/` (ignored by git) with "The Business Factory", starts a demo server on port 3100, drives Chrome with Puppeteer (a development-only dependency that isn't in the Docker image), and writes `public/manual/img/*.jpg`. Retake a few with `node tools/manual/screenshots.mjs overview client-panel`. To explore the demo yourself, run `npm run manual:demo`, then start the server with `DATA_DIR=demo-data PORT=3100 node src/server.js` and sign in with the password the seed script prints. `priya` has no two-factor sign-in; `jamie` uses an authenticator app with the demo secret `JBSWY3DPEHPK3PXP`; `morgan` (the admin) has demo passkeys that can't really be used, which is why the screenshot script uses ready-made sessions instead.
