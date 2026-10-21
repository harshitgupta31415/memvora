import { PageHeading } from '@/components/ui';

export default function SetupLoading() {
  return (
    <>
      <PageHeading
        eyebrow="LOCAL SETUP"
        title="Connect your work to Memvora."
        description="Checking local tools and the authenticated API connection."
      />
      <section className="panel section-padding" role="status">
        <p className="muted-caption">Loading this machine’s setup instructions…</p>
      </section>
    </>
  );
}
