import { createClient } from '@supabase/supabase-js';

// Server-only client using the service_role key. Never expose this key or this
// file's client to the browser - it bypasses Row Level Security entirely.
export function supabaseAdmin() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
          throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    return createClient(url, key, { auth: { persistSession: false } });
}
