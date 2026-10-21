import { PageHeading } from '@/components/ui';

export default function CaptureRecoveryLoading() {
  return (
    <>
      <PageHeading
        eyebrow="LOCAL CAPTURE RECOVERY"
        title="Inspect first. Sync a deliberate selection."
        description="Loading local manual recovery instructions."
      />
      <p className="muted-caption" role="status">
        Checking the CLI entry without opening a capture outbox…
      </p>
    </>
  );
}
