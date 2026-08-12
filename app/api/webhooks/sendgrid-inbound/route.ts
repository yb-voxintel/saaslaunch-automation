import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { postSlack } from '@/lib/slack';

// Optional: SendGrid Inbound Parse webhook, for detecting email replies.
export async function POST(req: NextRequest) {
    const form = await req.formData();
    const from = String(form.get('from') || '');
    const text = String(form.get('text') || form.get('html') || '');
    const emailMatch = from.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    const fromEmail = emailMatch ? emailMatch[0] : from;

  const db = supabaseAdmin();
    const { data: lead } = await db
      .from('inbound_leads')
      .select('id, first_name, last_name')
      .eq('email', fromEmail)
      .maybeSingle();

  await db.from('inbound_replies').insert({
        lead_id: lead?.id || null,
        channel: 'email',
        body: text,
        from_address: fromEmail,
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
        const name = lead ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim() : fromEmail;
        await postSlack(`💬 *Email reply* from ${name} (${fromEmail}).\nAutomation paused — reply personally.`);
  } catch (e) {
        console.error('Slack notify failed', e);
  }

  return NextResponse.json({ ok: true });
}
