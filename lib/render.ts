// Minimal {{variable}} template renderer used for SMS and email bodies.
export function render(template: string, vars: Record<string, string | undefined>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

export function baseVars(lead: { first_name?: string | null }) {
    return {
          first_name: lead.first_name || 'there',
          sdr_name: process.env.SDR_NAME || 'Alex',
          company_name: process.env.COMPANY_NAME || 'VoxIntel',
    };
}
