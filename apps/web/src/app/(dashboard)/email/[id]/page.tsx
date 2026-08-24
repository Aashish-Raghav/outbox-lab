import { EmailDetail } from '@/features/emails/EmailDetail';

/** Next 15 hands route params to a page as a promise. */
export default async function EmailDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EmailDetail id={id} />;
}
