import React from 'react';

const routes = [
    'POST /api/webhooks/lead-intake',
    'POST /api/webhooks/booking',
    'POST /api/webhooks/twilio-inbound',
    'POST /api/webhooks/sendgrid-inbound',
    'POST /api/webhooks/slack-events',
    'GET /api/cron/process-leads (Vercel Cron, every 15 min)',
    'GET /api/cron/process-bookings (Vercel Cron, every 15 min)',
  ];

export default function Home() {
    return React.createElement(
          'main',
          null,
          React.createElement('h1', null, 'SaaSLaunch Lead Automation'),
          React.createElement(
                  'p',
                  null,
                  'This app has no UI — it runs webhooks and cron jobs. See the README in the repo for setup.'
                ),
          React.createElement(
                  'ul',
                  null,
                  routes.map((r) =>
                            React.createElement('li', { key: r }, React.createElement('code', null, r))
                                   )
                )
        );
}
