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
//
// Also understands the format posted by the Facebook Lead Ads -> Slack bot:
//   Name: Jane Doe
//   Phone Number: +15551234567
//   Email:
//   Campaign Name: Some_Campaign
// Bot-posted messages are allowed through (the lead bot posts as a bot user),
// and common key variants are normalized to phone/email/name/campaign.

const KEY_ALIASES: Record<string, string> = {
        'phone number': 'phone',
        'phone #': 'phone',
        'mobile': 'phone',
        'mobile number': 'phone',
        'email address': 'email',
        'full name': 'name',
        'campaign name': 'campaign',
};

function normalizeKey(raw: string): string {
        const key = raw.trim().toLowerCase();
        return KEY_ALIASES[key] || key;
}

export async function POST(req: NextRequest) {
        const payload = await req.json().catch(() => ({}));

  // Slack's one-time URL verification handshake.
  if (payload.type === 'url_verification') {
              return NextResponse.json({ challenge: payload.challenge });
  }

  const event = payload.event;
        if (
                      event?.type === 'message' &&
                      event.channel === process.env.SLACK_LEAD_CHANNEL_ID &&
                      typeof event.text === 'string'
                    ) {
                      const fields: Record<string, string> = {};
                      for (const line of event.text.split('\n')) {
                                            const [rawKey, ...rest] = line.split(':');
                                            if (rawKey && rest.length) {
                                                                            const value = rest.join(':').trim();
                                                                            if (value) fields[normalizeKey(rawKey)] = value;
                                            }
                      }

          const name = (fields['name'] || '').trim();
                      const nameParts = name.split(' ').filter(Boolean);
                      const last_name = nameParts.length > 1 ? nameParts.pop()! : '';
                      const first_name = nameParts.join(' ');

          if (fields['phone'] || fields['email']) {
                            const origin = req.nextUrl.origin;
                            await fetch(`${origin}/api/webhooks/lead-intake`, {
                                                        method: 'POST',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({
                                                                                                first_name,
                                                                                                last_name,
                                                                                                phone: fields['phone'] || null,
                                                                                                email: fields['email'] || null,
                                                                                                source: fields['campaign'] ? 'facebook_lead' : 'slack_manual_entry',
                                                                                                utm: fields['campaign'] ? { campaign: fields['campaign'] } : null,
                                                        }),
                            });
          }
        }

  return NextResponse.json({ ok: true });
}
