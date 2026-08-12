import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { postSlack } from '@/lib/slack';

// Twilio inbound SMS webhook. Set this as the "A message comes in" webhook
// on your Twilio phone number (POST, application/x-www-form-urlencoded).
export async function POST(req: NextRequest) {
    const form = await req.formData();
    const from = String(form.get('From') || '');
    const bodyText = String(form.get('Body') || '');

  const db = supabaseAdmin();
    const { data: lead } = await db
      .from('inbound_leads')
      .select('id, first_name, last_name, assigned_rep')
      .eq('phone', from)
      .maybeSingle();

  await db.from('inbound_replies').insert({
        lead_id: lead?.id || null,
        channel: 'sms',
        body: bodyText,
        from_address: from,
  });

  if (lead) {
        await db.from('inbound_leads').update({
                replied: true,
                stage: 'engaged',
                next_action_at: null,
                next_action_type: null,
        }).eq('id', lead.id);
  }

  try {
        const name = lead ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim() : from;
        await postSlack(`💬 *SMS reply* from ${name} (${from}): "${bodyText}"\nAutomation paused — reply personally.`);
  } catch (e) {
        console.error('Slack notify failed', e);
  }

  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
        headers: { 'Content-Type': 'text/xml' },
  });
}
