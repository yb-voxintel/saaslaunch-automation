import { NextRequest, NextResponse, unstable_after as after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendSms } from '@/lib/twilio';
import { sendEmail } from '@/lib/sendgrid';
import { placeOutboundCall } from '@/lib/retell';
import { upsertContact } from '@/lib/hubspot';
import { postSlack, callReminderText } from '@/lib/slack';
import { render, baseVars } from '@/lib/render';
import { PHASE1_PLAN, NEXT_DAY_GAP_HOURS } from '@/lib/playbook';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

const vars = baseVars(lead);
    let smsResult = null;
    if (phone) {
        const { data: tmpl } = await db
        .from('sms_templates')
        .select('body')
        .eq('template_key', 'day0_immediate')
        .single();
        const text = render(tmpl?.body || 'Hey {{first_name}}, {{sdr_name}} here from {{company_name}}, got a quick minute to chat? Or grab a time that works for you here: https://bit.ly/4x7rCqd', vars);
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

let callResult = null;
    if (phone) {
        // Fire-and-forget: runs after the response is sent so Slack's 3s
        // webhook ack isn't blocked, ~55s after the immediate Day-0 SMS.
        after(async () => {
            await new Promise((resolve) => setTimeout(resolve, 55000));
            try {
                const call = await placeOutboundCall(phone, {
                    first_name: first_name || '',
                    email: email || '',
                    phone,
                    signup_source: source || 'saaslaunch_ads',
                    campaign: utm?.campaign || '',
                });
                await db.from('inbound_touch_log').insert({
                    lead_id: lead.id, day: 0, channel: 'call', template_key: 'day0_auto_call',
                    status: 'sent', external_id: call.call_id, content: 'Retell outbound call triggered ~55s after Day-0 SMS',
                });
            } catch (e: any) {
                await db.from('inbound_touch_log').insert({
                    lead_id: lead.id, day: 0, channel: 'call', template_key: 'day0_auto_call',
                    status: 'failed', content: e.message,
                });
            }
        });
    }

let emailResult = null;
    if (email) {
        const subject = `Thanks for signing up, ${first_name || 'there'}`;
        const text = render(
            'Hey {{first_name}}, {{sdr_name}} here from {{company_name}}. Thanks for signing up - I will be reaching out shortly to help you get started. Feel free to reply to this email with any questions, or grab a time that works for you here: https://calendly.com/yb-voxintelai/voxintel-intetrest-meeting',
            vars
            );
        try {
            const sent = await sendEmail(email, subject, text);
            emailResult = sent.messageId;
            await db.from('inbound_touch_log').insert({
                lead_id: lead.id, day: 0, channel: 'email', template_key: 'day0_immediate',
                status: 'sent', external_id: sent.messageId, content: text,
            });
        } catch (e: any) {
            await db.from('inbound_touch_log').insert({
                lead_id: lead.id, day: 0, channel: 'email', template_key: 'day0_immediate',
                status: 'failed', content: e.message,
            });
        }
    }

let hubspotContactId = null;
    if (email || phone) {
        try {
            const contactId = await upsertContact({ first_name, last_name, email, phone });
            hubspotContactId = contactId;
            await db.from('inbound_touch_log').insert({
                lead_id: lead.id, day: 0, channel: 'hubspot', template_key: 'contact_sync',
                status: 'sent', external_id: contactId, content: 'HubSpot contact created/updated',
            });
        } catch (e: any) {
            await db.from('inbound_touch_log').insert({
                lead_id: lead.id, day: 0, channel: 'hubspot', template_key: 'contact_sync',
                status: 'failed', content: e.message,
            });
        }
    }

try {
    await postSlack(
        callReminderText({
            name: `${first_name || ''} ${last_name || ''}`.trim() || 'New lead',
            phone,
            reason: 'New SaaSLaunch opt-in - double dial now (2 back-to-back calls). Speed to lead matters most in the first 5 minutes.',
        })
        );
} catch (e) {
    console.error('Slack notify failed', e);
}

return NextResponse.json({ lead_id: lead.id, sms_sid: smsResult, retell_call_id: callResult, email_id: emailResult, hubspot_contact_id: hubspotContactId });
}
