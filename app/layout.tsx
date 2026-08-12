import React from 'react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return React.createElement(
          'html',
      { lang: 'en' },
          React.createElement(
                  'body',
            { style: { fontFamily: 'system-ui, sans-serif', padding: 24 } },
                  children
                )
        );
}
