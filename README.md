# Textline

A shared SMS/MMS inbox for BulkVS phone numbers. Multiple users and multiple numbers, and each user sees only the numbers an admin assigns to them.

- Conversation list with a number switcher, search, unread counts and archive
- 1:1 and group threads, MMS attachments, delivery status, and who on the team sent each message
- Live updates across all signed-in users (server-sent events) and browser notifications
- Shared contact names
- Admin page for numbers, users and access, plus webhook setup and a log of recent webhook calls
- Installable on a phone as a web app (PWA)

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
git clone <your repo> textline && cd textline
cp .env.example .env    # set PUBLIC_URL, BULKVS_*, WEBHOOK_SECRET
docker compose up -d --build
```

This runs the app on port 3000. Put your reverse proxy in front of it and set `PUBLIC_URL` to the public `https://` address.

With no reverse proxy, run `docker compose --profile caddy up -d --build` instead. That also starts Caddy, which gets a Let's Encrypt certificate for `DOMAIN`. It needs a DNS record pointing at the server and ports 80/443 open.

Data (database and uploaded media) lives in the `textline-data` volume. To update, pull the new code and run the same `up` command again. To back up:

```bash
docker compose cp app:/app/data ./backup-$(date +%F)
```

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
2. **Credentials.** In the [BulkVS portal](https://portal.bulkvs.com/login.php), open **API → API Credentials**. Under "API Information – REST API", copy the **Username** into `BULKVS_USERNAME` and the **Password** into `BULKVS_PASSWORD`. These are separate from your portal login.
3. **Webhook.** Set `WEBHOOK_SECRET` to a long random string and restart. Open Admin settings in the app and copy the webhook URL. In BulkVS, open **Messaging → Messaging Webhooks**. Under "Message Webhooks", enter a name (e.g. `Textline`) in the "Trunk Group" field and paste the URL as the "Message URL", then click **Add**. Click the new webhook in the table to set "Delivery Receipt". Turning it on gives you Delivered/Failed status, but the receipt format is unconfirmed (see below). Set it to false if receipts show up as "not applied" in the webhook log.
4. **Assign the webhook to each number.** In BulkVS, open **Inbound → DIDs – Manage** and click the number. Make sure SMS and MMS are enabled (BulkVS shows a "Disable" button when they already are), and set "Messaging Webhook" to the one you created.
5. **Numbers in the app.** Add each BulkVS number in Admin settings, then assign numbers to users.

Outbound A2P messaging to US carriers also needs a 10DLC brand and campaign registered in BulkVS for each number. Without it, carriers will filter or reject messages.

## Things to verify on first real use

The BulkVS docs you provided confirm the send request (`POST /messageSend` with `From`, `To[]`, `Message`, `MediaURLs[]`) and the response (`RefId`, `Results[]`). Authentication uses HTTP Basic with the REST API username and password, consistent with Textable's BulkVS setup guide. The docs do **not** describe the webhook payload, so the code makes a reasonable guess that you can check:

- **Inbound and delivery-receipt payloads.** The parser accepts the same field names as `messageSend` (`From`, `To`, `Message`, `MediaURLs`, `RefId`, `DeliveryReceipt`) in any letter case, and URL-decodes text that looks encoded. Every raw webhook body is stored and shown under Admin settings → Recent webhook calls. If a real message shows "not applied", the exact payload is there, and `parseWebhook()` in [src/bulkvs.js](src/bulkvs.js) is the only place to adjust.

## Layout

```
src/server.js     HTTP routes: auth, conversations, uploads, contacts, admin, webhook
src/messaging.js  Recording inbound messages, sending outbound, applying delivery receipts
src/bulkvs.js     All BulkVS-specific code (send + webhook parsing)
src/db.js         SQLite schema and access helpers
src/auth.js       Password hashing (scrypt) and cookie sessions
src/events.js     Server-sent events hub
public/           The web app (index.html, app.js, styles.css)
data/             SQLite database and uploaded media (created at runtime)
```

Back up `data/` to keep your message history.
