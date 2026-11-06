'use client';

import { captureException } from '@/lib/analytics';
import { BG, BRAND, FG, FG_STRONG, MUTED } from '@/lib/brand';
import { SEAL_CELLS, SEAL_PATH } from '@/lib/seal';
import type { CSSProperties } from 'react';
import { useEffect } from 'react';

/**
 * The last resort (SIG-268): the root layout itself failed.
 *
 * **This replaces the layout rather than rendering inside it**, so it brings its
 * own `<html>` and `<body>` and gets nothing the layout provides: no fonts, no
 * Tailwind, no header. A stylesheet or a font that failed to load is as likely a
 * reason to be here as any, so it asks for none -- everything is an inline style,
 * the face is the system stack, and the colours are `lib/brand.ts`, the copies of
 * the stylesheet's tokens that exist for exactly the places CSS cannot reach.
 *
 * The seal is inline SVG drawn from `SEAL_PATH`, the one definition of its
 * geometry, rather than a second copy of the path.
 *
 * It cannot export `metadata` (a boundary is a client component), so the title is
 * React's own `<title>`. And it does not catch a layout that throws while the
 * server renders: Next answers that with a bare 500 and there is no tree left to
 * fall back into.
 *
 * The button reloads the document. `retry()` would re-render the same layout
 * from the state that just failed; a reload starts again from the server.
 */

const page: CSSProperties = {
  alignItems: 'center',
  background: BG,
  color: FG,
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  justifyContent: 'center',
  lineHeight: 1.6,
  margin: 0,
  minHeight: '100vh',
  padding: '32px 16px',
  textAlign: 'center',
};

const button: CSSProperties = {
  background: BRAND,
  border: 0,
  borderRadius: 8,
  color: '#ffffff',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
  marginTop: 24,
  padding: '10px 20px',
};

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    captureException(error, { digest: error.digest, boundary: 'global-error' });
  }, [error]);

  return (
    <html lang="en">
      <head>
        <title>Something went wrong · sigil</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style={page}>
        <svg
          aria-hidden="true"
          height={56}
          shapeRendering="crispEdges"
          viewBox={`0 0 ${SEAL_CELLS} ${SEAL_CELLS}`}
          width={56}
        >
          <path d={SEAL_PATH} fill={BRAND} fillRule="evenodd" />
        </svg>
        <h1 style={{ color: FG_STRONG, fontSize: 28, margin: '24px 0 8px' }}>
          Something went wrong
        </h1>
        <p style={{ color: MUTED, margin: 0, maxWidth: 440 }}>
          The site failed to load. It is not something you did, and reloading often fixes it.
        </p>
        <button onClick={() => window.location.reload()} style={button} type="button">
          Reload the page
        </button>
        {error.digest ? (
          <p style={{ color: MUTED, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 }}>
            digest {error.digest}
          </p>
        ) : null}
      </body>
    </html>
  );
}
