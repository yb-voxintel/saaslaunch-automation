import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendSms } from '@/lib/twilio';
import { sendEmail } from '@/lib/sendgrid';
import { placeOutboundCall } from '@/lib/retell';
import { isWithinCallingHours, nextCallingWindowStart } from '@/lib/calling-hours';
import { render, baseVars } from '@/lib/render';
import {
        PHASE1_PLAN, PHASE1_DAYS, PHASE2_END_DAY, PHASE2_TOUCHES_PER_DAY,
        INTRA_DAY_GAP_HOURS, NEXT_DAY_GAP_HOURS, phase1DayPlan, isPhase2, isSequenceComplete,
} from '@/lib/playbook';
export const dynamic = 'force-dynamic';

function authorized(req: NextRequest) {
        const secret = process.env.CRON_SECRET;
        if (!secret) return true;
        return req.headers.get('authorization') === `Bearer ${secret}`;
}

// Vercel Cron target, every 15 minutes. Walks every lead whose next_action_at
// is due, executes that touch (sms/email/call all automated via Twilio/Retell),
// and schedules the next one per the Phase 1 / Phase 2 plan in lib/playbook.ts.
// Calls are additionally gated to 9am-7pm ET (lib/calling-hours.ts); a call due
// outside that window is deferred (not skipped) to the next valid window.
//
// IMPORTANT: every write that advances a lead's next_action_at/type/day must
// check the Supabase error return and throw on failure. A silently-swallowed
// write failure here (e.g. a DB constraint rejecting a value the code tries to
// persist) leaves next_action_at stuck in the past, so the lead gets
// reprocessed - and re-touched - on every subsequent cron tick indefinitely.
// This exact bug (next_action_type='call' vs a stale CHECK constraint) caused
// a live resend loop on 2026-09-22/23; see migration allow_call_next_action_type.
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
                                console.error(`processLead failed for lead ${lead.id}:`, e.message);
                                results.push({ lead_id: lead.id, error: e.message });
                }
    }

    return NextResponse.json({ processed: results.length, results });
}

async function placeFollowUpCall(
        db: ReturnType<typeof supabaseAdmin>,
        lead: any,
        day: number,
        templateKey: string,
        extraVars: Record<string, string> = {}
    ): Promise<{ deferred: boolean }> {
        if (!lead.phone) {
                    await db.from('inbound_touch_log').insert({
                                    lead_id: lead.id, day, channel: 'call', template_key: templateKey, status: 'skipped', content: 'no phone on file',
                    });
                    return { deferred: false };
        }

    if (!isWithinCallingHours()) {
                const { error } = await db.from('inbound_leads').update({
                                next_action_at: nextCallingWindowStart().toISOString(),
                }).eq('id', lead.id);
                if (error) {
                                console.error(`placeFollowUpCall(defer) failed for lead ${lead.id}:`, error.message);
                                throw new Error(`Failed to defer call for lead ${lead.id}: ${error.message}`);
                }
                await db.from('inbound_touch_log').insert({
                                lead_id: lead.id, day, channel: 'call', template_key: templateKey, status: 'skipped', content: 'deferred - outside 9am-7pm ET calling window',
                });
                return { deferred: true };
    }

    try {
                const call = await placeOutboundCall(lead.phone, {
                                first_name: lead.first_name || '',
                                email: lead.email || '',
                                phone: lead.phone || '',
                                signup_source: lead.source || '',
                                campaign: lead.utm?.campaign || '',
                                ...extraVars,
                });
                await db.from('inbound_touch_log').insert({
                                lead_id: lead.id, day, channel: 'call', template_key: templateKey,
                                status: 'sent', external_id: call.call_id, content: 'Retell outbound call triggered',
                });
    } catch (e: any) {
                await db.from('inbound_touch_log').insert({
                                lead_id: lead.id, day, channel: 'call', template_key: templateKey, status: 'failed', content: e.message,
                });
    }
        return { deferred: false };
}

async function processLead(db: ReturnType<typeof supabaseAdmin>, lead: any) {
        const day = lead.day_in_sequence as number;
        const touchIndex = (lead.next_action_meta?.touchIndex ?? 0) as number;
        const vars = baseVars(lead);

    if (isSequenceComplete(day)) {
                const { error } = await db.from('inbound_leads').update({ stage: 'lost', next_action_at: null, next_action_type: null }).eq('id', lead.id);
                if (error) {
                                console.error(`processLead(sequence_complete) failed for lead ${lead.id}:`, error.message);
                                throw new Error(`Failed to close out completed sequence for lead ${lead.id}: ${error.message}`);
                }
                return { lead_id: lead.id, action: 'sequence_complete' };
    }

    if (isPhase2(day)) {
                const finalDay = day === PHASE2_END_DAY && touchIndex === PHASE2_TOUCHES_PER_DAY - 1;
                const result = await placeFollowUpCall(db, lead, day, 'phase2_call', {
                                day: String(day),
                                final_attempt: finalDay ? 'true' : 'false',
                });
                if (result.deferred) return { lead_id: lead.id, action: 'deferred_outside_calling_hours', day };
                return scheduleNext(db, lead, day, touchIndex, PHASE2_TOUCHES_PER_DAY);
    }

    const plan = phase1DayPlan(day);
        if (!plan) {
                    const { error } = await db.from('inbound_leads').update({ stage: 'lost', next_action_at: null, next_action_type: null }).eq('id', lead.id);
                    if (error) {
                                    console.error(`processLead(no_plan_for_day) failed for lead ${lead.id}:`, error.message);
                                    throw new Error(`Failed to close out lead ${lead.id} with no plan for day ${day}: ${error.message}`);
                    }
                    return { lead_id: lead.id, action: 'no_plan_for_day', day };
        }

    const channel = plan.order[touchIndex];

    if (channel === 'call') {
                const result = await placeFollowUpCall(db, lead, day, 'phase1_call', {
                                day: String(day),
                                angle: plan.angle || '',
                });
                if (result.deferred) return { lead_id: lead.id, action: 'deferred_outside_calling_hours', day };
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
                const { error } = await db.from('inbound_leads').update({
                                next_action_meta: { touchIndex: nextTouchIndex },
                                next_action_at: new Date(Date.now() + INTRA_DAY_GAP_HOURS * 3600 * 1000).toISOString(),
                                next_action_type: channelForIndex(day, nextTouchIndex),
                }).eq('id', lead.id);
                if (error) {
                                console.error(`scheduleNext(advanced_touch) failed for lead ${lead.id}:`, error.message);
                                throw new Error(`Failed to advance touch for lead ${lead.id}: ${error.message}`);
                }
                return { lead_id: lead.id, action: 'advanced_touch', day, touchIndex: nextTouchIndex };
    }

    const nextDay = day + 1;
        if (isSequenceComplete(nextDay)) {
                    const { error } = await db.from('inbound_leads').update({
                                    stage: 'lost', day_in_sequence: nextDay, next_action_at: null, next_action_type: null,
                    }).eq('id', lead.id);
                    if (error) {
                                    console.error(`scheduleNext(sequence_ended) failed for lead ${lead.id}:`, error.message);
                                    throw new Error(`Failed to end sequence for lead ${lead.id}: ${error.message}`);
                    }
                    return { lead_id: lead.id, action: 'sequence_ended', day: nextDay };
        }

    const { error } = await db.from('inbound_leads').update({
                stage: isPhase2(nextDay) ? 'phase2' : 'phase1',
                day_in_sequence: nextDay,
                next_action_meta: { touchIndex: 0 },
                next_action_at: new Date(Date.now() + NEXT_DAY_GAP_HOURS * 3600 * 1000).toISOString(),
                next_action_type: channelForIndex(nextDay, 0),
    }).eq('id', lead.id);
        if (error) {
                    console.error(`scheduleNext(advanced_day) failed for lead ${lead.id}:`, error.message);
                    throw new Error(`Failed to advance day for lead ${lead.id}: ${error.message}`);
        }
        return { lead_id: lead.id, action: 'advanced_day', day: nextDay };
}

function channelForIndex(day: number, touchIndex: number): 'sms' | 'email' | 'call' {
        if (isPhase2(day)) return 'call';
        const plan = phase1DayPlan(day);
        const ch = plan?.order[touchIndex];
        return (ch as 'sms' | 'email' | 'call') || 'sms';
}
