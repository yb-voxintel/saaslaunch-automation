// Plain REST call to the Twilio Messages API - no SDK dependency needed.
export async function sendSms(to: string, body: string) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) {
          throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER must be set');
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await fetch(url, {
          method: 'POST',
          headers: {
                  Authorization: `Basic ${auth}`,
                  'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
    const data = await res.json();
    if (!res.ok) {
          throw new Error(`Twilio send failed: ${JSON.stringify(data)}`);
    }
    return data as { sid: string };
}
