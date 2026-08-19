import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendSms } from '@/lib/twilio';
import { postSlack } from '@/lib/slack';
import { render, baseVars } from '@/lib/render';
export const dynamic = 'force-dynamic';

// Booking-tool webhook (Calendly-shaped, or generic). Point your booking
// tool's webhook here to trigger the Pre-Call Confirmation Flow.
export async function POST(req: NextRequest) {
    const raw = await req.json().catch(() => ({}));
    const db = supabaseAdmin();

  let name = '', email = '', phone = '', scheduled_at = '', call_link = '', external_event_id = '';

  if (raw.event === 'invitee.created' && raw.payload) {
        const p = raw.payload;
        name = p.name || '';
        email = p.email || '';
        phone = p.text_reminder_number || '';
        scheduled_at = p.scheduled_event?.start_time || '';
        call_link = p.scheduled_event?.location?.join_url || '';
        external_event_id = p.uri || '';
  } else {
        name = raw.name || '';
        email = raw.email || '';
        phone = raw.phone || '';
        scheduled_at = raw.scheduled_at || '';
        call_link = raw.call_link || '';
        external_event_id = raw.event_id || '';
  }

  if (!scheduled_at) {
        return NextResponse.json({ error: 'scheduled_at missing from payload' }, { status: 400 });
  }

  const [first_name, ...rest] = name.split(' ');
    const last_name = rest.join(' ');

  let leadId: string | null = null;
    if (email || phone) {
          const orFilter = [email ? `email.eq.${email}` : null, phone ? `phone.eq.${phone}` : null]
            .filter(Boolean)
            .join(',');
          const { data: existing } = await db
            .from('inbound_leads')
            .select('id')
            .or(orFilter)
            .limit(1)
            .maybeSingle();
          leadId = existing?.id || null;
    }

  if (leadId) {
        await db.from('inbound_leads').update({
                stage: 'booked', next_action_at: null, next_action_type: null,
        }).eq('id', leadId);
  } else {
        const { data: created } = await db.from('inbound_leads').insert({
                first_name, last_name, phone, email, source: 'booking_direct', stage: 'booked',
        }).select().single();
        leadId = created?.id || null;
  }

  const { data: booking } = await db.from('call_bookings').insert({
        lead_id: leadId,
        external_event_id,
        scheduled_at,
        call_link,
        status: 'booked',
  }).select().single();

  if (phone && booking) {
        const { data: tmpl } = await db.from('sms_templates').select('body')
          .eq('template_key', 'precall_immediate').single();
        const when = new Date(scheduled_at);
        const vars = {
                ...baseVars({ first_name }),
                call_day: when.toLocaleDateString('en-US', { weekday: 'long' }),
                call_time: when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        };
        const text = render(tmpl?.body || '', vars);
        try {
                const sent = await sendSms(phone, text);
                await db.from('call_bookings').update({ immediate_confirm_sent: true }).eq('id', booking.id);
                await db.from('inbound_touch_log').insert({
                          lead_id: leadId, day: 0, channel: 'sms', template_key: 'precall_immediate',
                          status: 'sent', external_id: sent.sid, content: text,
                });
        } catch (e) {
                console.error('precall_immediate sms failed', e);
        }
  }

  try {
        await postSlack(`✅ *Call booked* — ${name || email} for ${new Date(scheduled_at).toLocaleString('en-US')}. Confirmed via automated text; treat as unconfirmed until you've personally spoken to them.`);
  } catch (e) {
        console.error('Slack notify failed', e);
  }

  return NextResponse.json({ lead_id: leadId, booking_id: booking?.id });
}
