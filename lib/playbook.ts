// Encodes the SDR Playbook schedule from the Sales Process doc:
//   Day 0: immediate text + double dial
//   Phase 1 (Days 1-6): 3 touchpoints/day, rotating text/call/email
//   Phase 2 (Days 7-21): 3 calls/day, call-only
// "call" touches never dial automatically - they become a Slack reminder to
// the rep. Text and email touches are fully automated (Twilio / SendGrid).
//
// Timing note: this scheduler uses simple hour offsets rather than real
// per-lead timezones/business-hours calendars.

export type Channel = 'sms' | 'email' | 'call';

export interface DayPlan {
    day: number;
    order: Channel[];
    smsKey: string;
    emailStep: number;
    angle: string;
}

export const PHASE1_PLAN: DayPlan[] = [
  { day: 1, order: ['sms', 'call', 'email'], smsKey: 'day1_no_answer', emailStep: 1, angle: 'Intro + quick value prop' },
  { day: 2, order: ['email', 'call', 'sms'], smsKey: 'day2_check_in', emailStep: 2, angle: 'Case study or result' },
  { day: 3, order: ['call', 'sms', 'email'], smsKey: 'day2_check_in', emailStep: 3, angle: 'Pain point angle' },
  { day: 4, order: ['sms', 'email', 'call'], smsKey: 'day4_pattern_interrupt', emailStep: 4, angle: 'Handle a common objection' },
  { day: 5, order: ['email', 'sms', 'call'], smsKey: 'day2_check_in', emailStep: 5, angle: 'Social proof' },
  { day: 6, order: ['call', 'email', 'sms'], smsKey: 'day5_closing', emailStep: 6, angle: 'Closing the loop - last attempt' },
  ];

export const PHASE1_DAYS = 6;
export const PHASE2_END_DAY = 21;
export const PHASE2_TOUCHES_PER_DAY = 3;
export const INTRA_DAY_GAP_HOURS = 4;
export const NEXT_DAY_GAP_HOURS = 17;

export function phase1DayPlan(day: number): DayPlan | undefined {
    return PHASE1_PLAN.find((d) => d.day === day);
}

export function isPhase2(day: number) {
    return day > PHASE1_DAYS && day <= PHASE2_END_DAY;
}

export function isSequenceComplete(day: number) {
    return day > PHASE2_END_DAY;
}
