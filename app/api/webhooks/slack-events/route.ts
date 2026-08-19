import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

// Slack Events API endpoint. Configure this as your Request URL under
// Slack app > Event Subscriptions, subscribed to `message.channels` (or
// `message.groups` for a private channel), scoped to one "new leads" channel.
//
// Convention for manual lead entry via Slack: post a message in that channel
// shaped like:
//   Name: Jane Doe
//   Phone: +15551234567
//   Email: jane@example.com
// This handler parses it and forwards to /api/webhooks/lead-intake.
export async function POST(req: NextRequest) {
    const payload = await req.json().catch(() => ({}));

  // Slack's one-time URL verification handshake.
  if (payload.type === 'url_verification') {
        return NextResponse.json({ challenge: payload.challenge });
  }

  const event = payload.event;
    if (
          event?.type === 'message' &&
          !event.bot_id &&
          event.channel === process.env.SLACK_LEAD_CHANNEL_ID &&
          typeof event.text === 'string'
        ) {
          const fields: Record<string, string> = {};
          for (const line of event.text.split('\n')) {
                  const [key, ...rest] = line.split(':');
                  if (key && rest.length) fields[key.trim().toLowerCase()] = rest.join(':').trim();
          }

      const name = fields['name'] || '';
          const [first_name, ...lastParts] = name.split(' ');
          const last_name = lastParts.join(' ');

      if (fields['phone'] || fields['email']) {
              const origin = req.nextUrl.origin;
              await fetch(`${origin}/api/webhooks/lead-intake`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                                    first_name,
                                    last_name,
                                    phone: fields['phone'],
                                    email: fields['email'],
                                    source: 'slack_manual_entry',
                        }),
              });
      }
    }

  return NextResponse.json({ ok: true });
}
