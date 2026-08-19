import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendSms } from '@/lib/twilio';
import { postSlack, callReminderText } from '@/lib/slack';
import { render, baseVars } from '@/lib/render';
import { PHASE1_PLAN, NEXT_DAY_GAP_HOURS } from '@/lib/playbook';
export const dynamic = 'force-dynamic';

// Generic inbound lead intake. Point your ad platform / landing page form /
// booking tool's "new lead" webhook here. Body shape:
// { first_name, last_name, phone, email, source?, utm? }
export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}));
    const { first_name, last_name, phone, email, source, utm } = body;

  if (!phone && !email) {
        return NextResponse.json({ error: 'phone or email is required' }, { status: 400 });
  }

  const db = supabaseAdmin();

  const day1 = PHASE1_PLAN[0];
    const { data: lead, error } = await db
      .from('inbound_leads')
      .insert({
              first_name,
              last_name,
              phone,
              email,
              source: source || 'saaslaunch_ads',
              utm: utm || null,
              stage: 'phase1',
              day_in_sequence: 1,
              next_action_type: day1.order[0] === 'call' ? 'slack_call' : day1.order[0],
              next_action_meta: { touchIndex: 0 },
              next_action_at: new Date(Date.now() + NEXT_DAY_GAP_HOURS * 3600 * 1000).toISOString(),
      })
      .select()
      .single();

  if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Day 0 immediate actions, fired synchronously so the 5-minute speed-to-lead
  // window is actually met (rather than waiting on the next cron tick).
  const vars = baseVars(lead);
    let smsResult = null;
    if (phone) {
          const { data: tmpl } = await db
            .from('sms_templates')
            .select('body')
            .eq('template_key', 'day0_immediate')
            .single();
          const text = render(tmpl?.body || 'Hey {{first_name}}, {{sdr_name}} here from {{company_name}}, got a quick minute to chat?', vars);
          try {
                  const sent = await sendSms(phone, text);
                  smsResult = sent.sid;
                  await db.from('inbound_touch_log').insert({
                            lead_id: lead.id, day: 0, channel: 'sms', template_key: 'day0_immediate',
                            status: 'sent', external_id: sent.sid, content: text,
                  });
          } catch (e: any) {
                  await db.from('inbound_touch_log').insert({
                            lead_id: lead.id, day: 0, channel: 'sms', template_key: 'day0_immediate',
                            status: 'failed', content: e.message,
                  });
          }
    }

  try {
        await postSlack(
                callReminderText({
                          name: `${first_name || ''} ${last_name || ''}`.trim() || 'New lead',
                          phone,
                          reason: 'New SaaSLaunch opt-in — double dial now (2 back-to-back calls). Speed to lead matters most in the first 5 minutes.',
                })
              );
  } catch (e) {
        console.error('Slack notify failed', e);
  }

  return NextResponse.json({ lead_id: lead.id, sms_sid: smsResult });
}
