import { PageHeading } from '@/components/ui';

export default function BackupGuideLoading() {
  return (
    <>
      <PageHeading
        eyebrow="LOCAL BACKUP GUIDE"
        title="Keep a verified copy of your evidence."
        description="Loading manual backup instructions for this machine."
      />
      <section className="panel section-padding" role="status">
        <p className="muted-caption">Checking local prerequisites without opening the database…</p>
      </section>
    </>
  );
}
