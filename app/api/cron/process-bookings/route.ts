import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendSms } from '@/lib/twilio';
import { postSlack } from '@/lib/slack';
import { render, baseVars } from '@/lib/render';

function authorized(req: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (!secret) return true;
    return req.headers.get('authorization') === `Bearer ${secret}`;
}

// Vercel Cron target, every 15 minutes. Drives the Pre-Call Confirmation Flow
// (24h-before / 2h-before reminders) and No-Show detection + recovery.
export async function GET(req: NextRequest) {
    if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = supabaseAdmin();
    const now = new Date();
    const results: any[] = [];

  const { data: bookings } = await db
      .from('call_bookings')
      .select('*, inbound_leads(*)')
      .in('status', ['booked', 'confirmed'])
      .gte('scheduled_at', new Date(now.getTime() - 3600 * 1000).toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(100);

  for (const booking of bookings || []) {
        const lead = booking.inbound_leads;
        const scheduledAt = new Date(booking.scheduled_at);
        const hoursUntil = (scheduledAt.getTime() - now.getTime()) / 3600000;
        const vars = {
                ...baseVars(lead || {}),
                call_time: scheduledAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
                call_link: booking.call_link || '',
        };

      try {
              if (hoursUntil < -1 / 12 && !booking.no_show_handled) {
                        await db.from('call_bookings').update({ status: 'no_show', no_show_handled: true }).eq('id', booking.id);

                if (lead?.phone) {
                            const { data: tmpl } = await db.from('sms_templates').select('body').eq('template_key', 'no_show_immediate').single();
                            const text = render(tmpl?.body || '', vars);
                            try {
                                          const sent = await sendSms(lead.phone, text);
                                          await db.from('inbound_touch_log').insert({
                                                          lead_id: lead.id, day: 0, channel: 'sms', template_key: 'no_show_immediate', status: 'sent', external_id: sent.sid, content: text,
                                          });
                            } catch (e: any) {
                                          console.error('no_show sms failed', e);
                            }
                }

                await postSlack(`🚨 *No-show* — ${lead ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim() : 'Lead'} (${lead?.phone || 'no phone'}) missed their call at ${scheduledAt.toLocaleString('en-US')}. Call them right now.`);

                if (lead?.id) {
                            await db.from('inbound_leads').update({
                                          stage: 'no_show_recovery',
                                          day_in_sequence: 1,
                                          next_action_meta: { touchIndex: 0, recovery: true },
                                          next_action_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
                                          next_action_type: 'email',
                            }).eq('id', lead.id);
                }

                results.push({ booking_id: booking.id, action: 'no_show_handled' });
                        continue;
              }

          if (hoursUntil <= 2 && hoursUntil > 0 && !booking.reminder_2h_sent) {
                    await postSlack(`⏰ Call with ${lead ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim() : 'lead'} is in ~2 hours (${scheduledAt.toLocaleString('en-US')}). Try calling to confirm before the reminder text goes out.`);
                    if (lead?.phone) {
                                const { data: tmpl } = await db.from('sms_templates').select('body').eq('template_key', 'precall_2h').single();
                                const text = render(tmpl?.body || '', vars);
                                const sent = await sendSms(lead.phone, text);
                                await db.from('inbound_touch_log').insert({
                                              lead_id: lead.id, day: 0, channel: 'sms', template_key: 'precall_2h', status: 'sent', external_id: sent.sid, content: text,
                                });
                    }
                    await db.from('call_bookings').update({ reminder_2h_sent: true }).eq('id', booking.id);
                    results.push({ booking_id: booking.id, action: 'reminder_2h_sent' });
                    continue;
          }

          if (hoursUntil <= 24 && hoursUntil > 2 && !booking.reminder_24h_sent) {
                    if (lead?.phone) {
                                const { data: tmpl } = await db.from('sms_templates').select('body').eq('template_key', 'precall_24h').single();
                                const text = render(tmpl?.body || '', vars);
                                const sent = await sendSms(lead.phone, text);
                                await db.from('inbound_touch_log').insert({
                                              lead_id: lead.id, day: 0, channel: 'sms', template_key: 'precall_24h', status: 'sent', external_id: sent.sid, content: text,
                                });
                    }
                    await postSlack(`📅 24h reminder sent to ${lead ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim() : 'lead'} for tomorrow's call. If they don't respond in a few hours, give them a call to confirm.`);
                    await db.from('call_bookings').update({ reminder_24h_sent: true }).eq('id', booking.id);
                    results.push({ booking_id: booking.id, action: 'reminder_24h_sent' });
          }
      } catch (e: any) {
              results.push({ booking_id: booking.id, error: e.message });
      }
  }

  return NextResponse.json({ processed: results.length, results });
}
