// Plain REST call to the SendGrid v3 mail send API.
export async function sendEmail(to: string, subject: string, text: string) {
    const key = process.env.SENDGRID_API_KEY;
    const from = process.env.SENDGRID_FROM_EMAIL;
    if (!key || !from) {
          throw new Error('SENDGRID_API_KEY and SENDGRID_FROM_EMAIL must be set');
    }
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
                  Authorization: `Bearer ${key}`,
                  'Content-Type': 'application/json',
          },
          body: JSON.stringify({
                  personalizations: [{ to: [{ email: to }] }],
                  from: { email: from, name: process.env.SDR_NAME || 'Alex' },
                  subject,
                  content: [{ type: 'text/plain', value: text }],
          }),
    });
    if (!res.ok) {
          const errText = await res.text();
          throw new Error(`SendGrid send failed: ${errText}`);
    }
    return { messageId: res.headers.get('x-message-id') };
}
