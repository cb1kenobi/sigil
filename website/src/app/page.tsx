import { InstallCommand } from '@/components/install-command';
import { jsonLd, pageMetadata, softwareSourceCode } from '@/lib/seo';
import { TAGLINE } from '@/lib/site';
import Link from 'next/link';

export const metadata = pageMetadata({ path: '/', description: TAGLINE });

/** A placeholder: the home page is SIG-261. */
export default function Home() {
  return (
    <div className="layout-page flex flex-1 flex-col items-start justify-center gap-6 py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(softwareSourceCode()) }}
      />
      <h1 className="text-display">sigil</h1>
      <p className="lede-hero max-w-prose">A framework for building CLI apps in Node.js.</p>
      <Link className="text-link underline underline-offset-4" href="/reference">
        Command reference
      </Link>
      {/* A preview of both install boxes until the home page (SIG-261) places them. */}
      <InstallCommand package="framework" location="review" />
      <InstallCommand package="cli" location="review" />
      <div className="w-full max-w-2xl">
        <InstallCommand package="cli" variant="title-bar" location="review" />
      </div>
    </div>
  );
}
