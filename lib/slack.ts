// Posts to Slack. Prefers a bot token (chat.postMessage) so messages can be
// threaded/reacted to later; falls back to a plain incoming webhook URL.
export async function postSlack(text: string) {
    const botToken = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_CHANNEL_ID;
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (botToken && channel) {
        const res = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: {
                          Authorization: `Bearer ${botToken}`,
                          'Content-Type': 'application/json; charset=utf-8',
                },
                body: JSON.stringify({ channel, text }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(`Slack postMessage failed: ${data.error}`);
        return data;
  }

  if (webhookUrl) {
        const res = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`Slack webhook failed: ${await res.text()}`);
        return { ok: true };
  }

  throw new Error('Set SLACK_BOT_TOKEN + SLACK_CHANNEL_ID, or SLACK_WEBHOOK_URL');
}

export function callReminderText(opts: {
    name: string;
    phone?: string | null;
    reason: string;
    angle?: string;
    finalDay?: boolean;
}) {
    const lines = [
          `Call reminder - ${opts.name}${opts.phone ? ` (${opts.phone})` : ''}`,
          opts.reason,
        ];
    if (opts.angle) lines.push(`Angle: ${opts.angle}`);
    if (opts.finalDay) lines.push('Final attempt - call from a different/personal number.');
    return lines.join('\n');
}
