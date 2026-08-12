# SaaSLaunch Lead Automation

Automates the "Sales Process reiterations" playbook for the SaaSLaunch paid-ad campaign
(VoxIntel): speed-to-lead texting, the Phase 1 / Phase 2 follow-up cadence, pre-call
confirmation, and no-show recovery — via Twilio SMS, SendGrid email, and Slack.

**Calls are never auto-dialed.** Anywhere the playbook calls for a phone call, this app
posts a Slack reminder to you instead, with the lead's name/number and the day's talking
angle. Texts and emails are fully automated.

## What it does

- **New opt-in** → immediate SMS + Slack "double dial" reminder (Day 0).
- **Days 1-6 (Phase 1)** → 3 touches/day rotating text / call / email, content angle changes daily. Calls become Slack reminders.
- **Days 7-21 (Phase 2)** → 3 Slack call reminders/day, no automated messages. Final day flags "call from a different number."
- **Booking a call** → cancels the no-book sequence, sends an immediate confirmation text, then 24h-before and 2h-before reminder texts (with a Slack heads-up to call and confirm if the lead's gone quiet).
- **No-show** → immediate Slack alert + "did something come up?" text, then re-enrolls the lead into the 6-day email sequence as a recovery track.
- **Any reply** (SMS or email) → pauses all automation for that lead and posts to Slack. From there it's a human conversation, same as the playbook intends.

## Database

Everything lives in the existing Supabase project (`jfhjpeuobqyotcivovmb`). New tables:
`inbound_leads`, `inbound_touch_log`, `inbound_replies`, `call_bookings`, `sms_templates`.
The 6-day email sequence was added to the existing `email_templates` table under
`sequence_type = 'saaslaunch_nobook'` (plus a `saaslaunch_cold` variant for the ad-click
reactivation email). All new tables have RLS enabled with no anon/authenticated policies —
only the service role key (used server-side by this app) can read/write them. This part is
already live — no setup needed on the database side.

## Deploying yourself

The code is complete and ready to deploy. I hit a permissions error trying to create a
Vercel project programmatically from here, so this part is manual on your end.

**Option A — GitHub + Vercel dashboard (recommended):**

1. Extract this archive, `cd` into the `saaslaunch-automation` folder.
2. `git init && git add . && git commit -m "initial"`, then push to a new GitHub repo.
3. In the Vercel dashboard: **Add New → Project**, import that repo. Vercel auto-detects Next.js — no build config changes needed.
4. Before (or right after) the first deploy, go to **Settings → Environment Variables** and add every variable from `.env.example` with real values. Set them for Production (and Preview too if you want to test there).
5. Deploy. Vercel picks up `vercel.json`'s two cron jobs automatically — check **Settings → Cron Jobs** to confirm both show up.

**Option B — Vercel CLI, no GitHub:**

1. `npm i -g vercel`
2. Extract this archive, `cd saaslaunch-automation`
3. `vercel login`
4. `vercel link` (creates/links the project)
5. Add env vars: `vercel env add <NAME>` for each one in `.env.example`, or paste them in via the dashboard after linking.
6. `vercel --prod`

**Either way, after it's live:**

- Grab the production URL (e.g. `https://saaslaunch-automation.vercel.app`).
- Wire up Twilio, SendGrid, Slack, and your booking tool to the webhook URLs below, substituting your real domain.
- Send a test lead to `/api/webhooks/lead-intake` and confirm you get the Day 0 text and a Slack "double dial" reminder.

## Setup

1. **Env vars** — copy `.env.example`, fill in real values, add them all as Environment Variables on the Vercel project. Never commit the filled-in `.env`.

- `SUPABASE_SERVICE_ROLE_KEY`: Supabase dashboard → Project Settings → API.
- Twilio: buy/use a number with SMS capability, grab the Account SID + Auth Token.
- SendGrid: create an API key with Mail Send permission, verify your sender.
- Slack: create an app, add bot scopes `chat:write` and (if using Slack-based lead intake) `channels:history`, install it to your workspace, invite the bot to your "new leads" channel, grab the channel ID.
- `CRON_SECRET`: any random string.

2. **Twilio** — set the phone number's "A message comes in" webhook (POST) to: `https://<your-deployment>/api/webhooks/twilio-inbound`

3. **SendGrid (optional, for email reply detection)** — set up Inbound Parse pointed at: `https://<your-deployment>/api/webhooks/sendgrid-inbound`. Skip this if you're fine handling email replies manually — SMS reply detection already covers the primary channel.
4. **Slack** — under Event Subscriptions, set the Request URL to: `https://<your-deployment>/api/webhooks/slack-events`. Subscribe to `message.channels` (or `message.groups` for a private channel).
5. **Booking tool** (Calendly or similar) — point its webhook (invitee created / booking created event) to: `https://<your-deployment>/api/webhooks/booking`
6. **Ad platform / landing page / form** — point wherever new opt-ins originate to: `https://<your-deployment>/api/webhooks/lead-intake`
Body: `{ "first_name", "last_name", "phone", "email", "source", "utm" }`
Alternative: post a message into your configured Slack "new leads" channel like:
```
Name: Jane Doe
Phone: +15551234567
Email: jane@example.com
```
and the Slack-events webhook will create the lead automatically.

## Known limitations (MVP — tune before relying on this heavily)

- Scheduling uses simple hour offsets, not real per-lead timezones or business hours. Touches land roughly 4 hours apart within a day, and roughly "next morning" between days. Good enough to start; swap in a real scheduler if precision matters.
- Phase 1 day→content mapping is defined explicitly in `lib/playbook.ts` — edit that file to change the cadence, or edit the `sms_templates` / `email_templates` rows in Supabase to change the message text.
- No-show recovery re-enrolls into the 6-day email sequence by default; the source playbook doesn't specify a distinct "Sequence 4," so this is a reasonable default, not a literal implementation of an undocumented sequence.
- Reply detection matches by exact phone/email string. Normalize phone number formats (E.164) at intake time to keep this reliable.

## Security note

Before this build, `system_config` (and 14 other tables) had Row Level Security
disabled, exposing a live SendGrid API key, HubSpot access token, Smartlead API key, and
Slack webhook URL to anyone holding the project's anon key. RLS has been enabled and
locked to service-role-only access. **You should still rotate those four credentials** —
there's no way to know for certain whether the anon key was ever exposed client-side
before now.
