// Plain REST calls to the HubSpot CRM API (Contacts + Deals) - no SDK.
const HUBSPOT_BASE = 'https://api.hubapi.com';

function authHeaders() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN must be set');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export interface HubspotLead {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
}

// Creates or updates a HubSpot contact. Looks the contact up by email (or
// phone, if no email on file) first so repeat touches update the same
// record instead of creating duplicates. Returns the HubSpot contact id.
export async function upsertContact(lead: HubspotLead): Promise<string> {
  const properties: Record<string, string> = {};
  if (lead.first_name) properties.firstname = lead.first_name;
  if (lead.last_name) properties.lastname = lead.last_name;
  if (lead.email) properties.email = lead.email;
  if (lead.phone) properties.phone = lead.phone;

const searchProperty = lead.email ? 'email' : lead.phone ? 'phone' : null;
  const searchValue = lead.email || lead.phone;

    let contactId: string | null = null;
  if (searchProperty && searchValue) {
    const searchRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: searchProperty, operator: 'EQ', value: searchValue }] }],
        limit: 1,
      }),
    });
    if (searchRes.ok) {
      const searchData = await searchRes.json().catch(() => ({}));
      contactId = searchData?.results?.[0]?.id || null;
    }
  }

if (contactId) {
  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`HubSpot contact update failed: ${await res.text()}`);
  return contactId;
}

const createRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
  method: 'POST',
  headers: authHeaders(),
  body: JSON.stringify({ properties }),
});
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok) throw new Error(`HubSpot contact create failed: ${JSON.stringify(createData)}`);
  return createData.id;
}

// Creates a deal for a booked call and associates it with the contact.
// Pipeline/stage default to HubSpot's out-of-the-box Sales pipeline; override
// with HUBSPOT_PIPELINE / HUBSPOT_DEAL_STAGE_BOOKED if your portal uses a
// custom pipeline or stage internal name.
export async function createBookedDeal(contactId: string, dealName: string): Promise<string> {
  const pipeline = process.env.HUBSPOT_PIPELINE || 'default';
  const dealstage = process.env.HUBSPOT_DEAL_STAGE_BOOKED || 'appointmentscheduled';

const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals`, {
  method: 'POST',
  headers: authHeaders(),
  body: JSON.stringify({
    properties: { dealname: dealName, pipeline, dealstage },
    associations: [
      { to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] },
      ],
  }),
});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HubSpot deal create failed: ${JSON.stringify(data)}`);
  return data.id;
}
