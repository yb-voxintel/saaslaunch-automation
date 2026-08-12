import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendSms } from '@/lib/twilio';
import { sendEmail } from '@/lib/sendgrid';
import { postSlack, callReminderText } from '@/lib/slack';
import { render, baseVars } from '@/lib/render';
import {
    PHASE1_PLAN, PHASE1_DAYS, PHASE2_END_DAY, PHASE2_TOUCHES_PER_DAY,
    INTRA_DAY_GAP_HOURS, NEXT_DAY_GAP_HOURS, phase1DayPlan, isPhase2, isSequenceComplete,
} from '@/lib/playbook';

function authorized(req: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (!secret) return true;
    return req.headers.get('authorization') === `Bearer ${secret}`;
}

// Vercel Cron target, every 15 minutes. Walks every lead whose next_action_at
// is due, executes that touch (sms/email automated, call -> Slack reminder),
// and schedules the next one per the Phase 1 / Phase 2 plan in lib/playbook.ts.
export async function GET(req: NextRequest) {
    if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = supabaseAdmin();
    const now = new Date();

  const { data: leads, error } = await db
      .from('inbound_leads')
      .select('*')
      .lte('next_action_at', now.toISOString())
      .eq('replied', false)
      .in('stage', ['phase1', 'phase2'])
      .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: any[] = [];

  for (const lead of leads || []) {
        try {
                results.push(await processLead(db, lead));
        } catch (e: any) {
                results.push({ lead_id: lead.id, error: e.message });
        }
  }

  return NextResponse.json({ processed: results.length, results });
}

async function processLead(db: ReturnType<typeof supabaseAdmin>, lead: any) {
    const day = lead.day_in_sequence as number;
    const touchIndex = (lead.next_action_meta?.touchIndex ?? 0) as number;
    const vars = baseVars(lead);

  if (isSequenceComplete(day)) {
        await db.from('inbound_leads').update({ stage: 'lost', next_action_at: null, next_action_type: null }).eq('id', lead.id);
        return { lead_id: lead.id, action: 'sequence_complete' };
  }

  if (isPhase2(day)) {
        const finalDay = day === PHASE2_END_DAY && touchIndex === PHASE2_TOUCHES_PER_DAY - 1;
        await postSlack(callReminderText({
                name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Lead',
                phone: lead.phone,
                reason: `Phase 2, Day ${day}, call ${touchIndex + 1} of ${PHASE2_TOUCHES_PER_DAY}.`,
                finalDay,
        }));
        await db.from('inbound_touch_log').insert({
                lead_id: lead.id, day, channel: 'slack', template_key: 'phase2_call', status: 'sent',
        });
        return scheduleNext(db, lead, day, touchIndex, PHASE2_TOUCHES_PER_DAY);
  }

  const plan = phase1DayPlan(day);
    if (!plan) {
          await db.from('inbound_leads').update({ stage: 'lost', next_action_at: null, next_action_type: null }).eq('id', lead.id);
          return { lead_id: lead.id, action: 'no_plan_for_day', day };
    }

  const channel = plan.order[touchIndex];

  if (channel === 'call') {
        await postSlack(callReminderText({
                name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Lead',
                phone: lead.phone,
                reason: `Phase 1, Day ${day} call.`,
                angle: plan.angle,
        }));
        await db.from('inbound_touch_log').insert({
                lead_id: lead.id, day, channel: 'slack', template_key: 'phase1_call', status: 'sent',
        });
  } else if (channel === 'sms') {
        if (lead.phone) {
                const { data: tmpl } = await db.from('sms_templates').select('body').eq('template_key', plan.smsKey).single();
                const text = render(tmpl?.body || '', vars);
                try {
                          const sent = await sendSms(lead.phone, text);
                          await db.from('inbound_touch_log').insert({
                                      lead_id: lead.id, day, channel: 'sms', template_key: plan.smsKey,
                                      status: 'sent', external_id: sent.sid, content: text,
                          });
                } catch (e: any) {
                          await db.from('inbound_touch_log').insert({
                                      lead_id: lead.id, day, channel: 'sms', template_key: plan.smsKey, status: 'failed', content: e.message,
                          });
                }
        } else {
                await db.from('inbound_touch_log').insert({ lead_id: lead.id, day, channel: 'sms', status: 'skipped', content: 'no phone on file' });
        }
  } else if (channel === 'email') {
        if (lead.email) {
                const { data: tmpl } = await db.from('email_templates')
                  .select('subject_line, body_text')
                  .eq('sequence_type', 'saaslaunch_nobook')
                  .eq('step_number', plan.emailStep)
                  .eq('is_active', true)
                  .single();
                const subject = render(tmpl?.subject_line || '', vars);
                const text = render(tmpl?.body_text || '', vars);
                try {
                          await sendEmail(lead.email, subject, text);
                          await db.from('inbound_touch_log').insert({
                                      lead_id: lead.id, day, channel: 'email', template_key: `saaslaunch_nobook_step${plan.emailStep}`,
                                      status: 'sent', content: text,
                          });
                } catch (e: any) {
                          await db.from('inbound_touch_log').insert({
                                      lead_id: lead.id, day, channel: 'email', template_key: `saaslaunch_nobook_step${plan.emailStep}`, status: 'failed', content: e.message,
                          });
                }
        } else {
                await db.from('inbound_touch_log').insert({ lead_id: lead.id, day, channel: 'email', status: 'skipped', content: 'no email on file' });
        }
  }

  return scheduleNext(db, lead, day, touchIndex, plan.order.length);
}

async function scheduleNext(
    db: ReturnType<typeof supabaseAdmin>,
    lead: any,
    day: number,
    touchIndex: number,
    touchesToday: number
  ) {
    const nextTouchIndex = touchIndex + 1;

  if (nextTouchIndex < touchesToday) {
        await db.from('inbound_leads').update({
                next_action_meta: { touchIndex: nextTouchIndex },
                next_action_at: new Date(Date.now() + INTRA_DAY_GAP_HOURS * 3600 * 1000).toISOString(),
                next_action_type: channelForIndex(day, nextTouchIndex),
        }).eq('id', lead.id);
        return { lead_id: lead.id, action: 'advanced_touch', day, touchIndex: nextTouchIndex };
  }

  const nextDay = day + 1;
    if (isSequenceComplete(nextDay)) {
          await db.from('inbound_leads').update({
                  stage: 'lost', day_in_sequence: nextDay, next_action_at: null, next_action_type: null,
          }).eq('id', lead.id);
          return { lead_id: lead.id, action: 'sequence_ended', day: nextDay };
    }

  await db.from('inbound_leads').update({
        stage: isPhase2(nextDay) ? 'phase2' : 'phase1',
        day_in_sequence: nextDay,
        next_action_meta: { touchIndex: 0 },
        next_action_at: new Date(Date.now() + NEXT_DAY_GAP_HOURS * 3600 * 1000).toISOString(),
        next_action_type: channelForIndex(nextDay, 0),
  }).eq('id', lead.id);
    return { lead_id: lead.id, action: 'advanced_day', day: nextDay };
}

function channelForIndex(day: number, touchIndex: number): 'sms' | 'email' | 'slack_call' {
    if (isPhase2(day)) return 'slack_call';
    const plan = phase1DayPlan(day);
    const ch = plan?.order[touchIndex];
    return ch === 'call' ? 'slack_call' : (ch as 'sms' | 'email') || 'sms';
}
