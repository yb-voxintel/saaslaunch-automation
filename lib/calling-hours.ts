// Calling-hours guard for automated outbound calls (Retell).
// Restricts calls to 9:00am-7:00pm America/New_York, every day of the week -
// weekends are NOT restricted separately, only the local clock hour matters,
// so a lead signing up on a Saturday at 11am ET still gets called immediately.
// SMS and email touches are not gated by this - only phone calls.

const CALL_TZ = 'America/New_York';
const CALL_START_HOUR = 9;  // 9:00am ET
const CALL_END_HOUR = 19;   // 7:00pm ET (calls stop being placed at 7:00pm)

function getEtWallClock(date: Date) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: CALL_TZ,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    return {
        year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
        hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    };
}

function etOffsetMs(date: Date): number {
    const wc = getEtWallClock(date);
    const asIfUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
    return asIfUtc - date.getTime();
}

export function isWithinCallingHours(date: Date = new Date()): boolean {
    const wc = getEtWallClock(date);
    return wc.hour >= CALL_START_HOUR && wc.hour < CALL_END_HOUR;
}

// Returns the next real UTC instant at which the 9am-7pm ET calling window
// opens, given `date` is currently outside it (either before 9am or at/after
// 7pm ET on its local calendar day).
export function nextCallingWindowStart(date: Date = new Date()): Date {
    const wc = getEtWallClock(date);
    const offset = etOffsetMs(date);

    let targetYear = wc.year;
    let targetMonth = wc.month;
    let targetDay = wc.day;

    if (wc.hour >= CALL_END_HOUR) {
        const nextDay = new Date(Date.UTC(wc.year, wc.month - 1, wc.day + 1));
        targetYear = nextDay.getUTCFullYear();
        targetMonth = nextDay.getUTCMonth() + 1;
        targetDay = nextDay.getUTCDate();
    }

    const asIfUtc = Date.UTC(targetYear, targetMonth - 1, targetDay, CALL_START_HOUR, 0, 0);
    return new Date(asIfUtc - offset);
}
