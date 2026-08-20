// Plain REST call to the Retell Create Phone Call API - no SDK dependency needed.
// Triggers an outbound call from the user's existing Retell voice agent the
// moment a phone lead comes in (mirrors the sendSms/sendEmail pattern).
export async function placeOutboundCall(to: string, dynamicVars: Record<string, string>) {
  const apiKey = process.env.RETELL_API_KEY;
  const fromNumber = process.env.RETELL_FROM_NUMBER;
  const agentId = process.env.RETELL_AGENT_ID;
  if (!apiKey || !fromNumber || !agentId) {
    throw new Error('RETELL_API_KEY, RETELL_FROM_NUMBER, and RETELL_AGENT_ID must be set');
  }
  const res = await fetch('https://api.retellai.com/v2/create-phone-call', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from_number: fromNumber,
      to_number: to,
      override_agent_id: agentId,
      retell_llm_dynamic_variables: dynamicVars,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Retell call failed: ${JSON.stringify(data)}`);
  }
  return data as { call_id: string };
}
