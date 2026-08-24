'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { projectCampaign, type ParsedRecipients } from '@reachinbox/shared';
import { Button, IconButton, Input, Spinner, useToast } from '@/components/ui';
import { AlertIcon, ArrowLeftIcon, SendIcon } from '@/components/icons';
import { useCreateCampaign, useSenders } from '@/hooks/useSenders';
import { ApiRequestError } from '@/lib/api';
import { cn, formatFullDate } from '@/lib/format';
import { AttachmentBar, AttachmentChips } from './AttachmentBar';
import { BodyEditor } from './Editor';
import { RecipientChips } from './RecipientChips';
import { SendLaterPopover } from './SendLaterPopover';
import { UploadList } from './UploadList';

/** Mirrors the API's default `MAX_UPLOAD_BYTES`. */
const MAX_ATTACHMENT_BYTES = 5_242_880;

/** A labelled row in the underlined, left-labelled Compose layout. */
function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-4 border-b border-line py-2.5', className)}>
      <label
        htmlFor={htmlFor}
        className="w-[92px] shrink-0 pt-2 text-sm font-medium text-muted"
      >
        {label}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function ComposeForm() {
  const router = useRouter();
  const toast = useToast();
  const senders = useSenders();
  const createCampaign = useCreateCampaign();

  const [senderId, setSenderId] = useState('');
  const [typedRecipients, setTypedRecipients] = useState<string[]>([]);
  const [leadFile, setLeadFile] = useState<File | null>(null);
  const [leadParsed, setLeadParsed] = useState<ParsedRecipients | null>(null);
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [delaySeconds, setDelaySeconds] = useState('2');
  const [hourlyLimit, setHourlyLimit] = useState('');
  const [startAt, setStartAt] = useState<Date | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [showErrors, setShowErrors] = useState(false);

  // Defaults to the first active sender rather than forcing a pick, since the
  // Figma shows the From field already populated.
  const activeSenders = useMemo(
    () => (senders.data ?? []).filter((sender) => sender.isActive),
    [senders.data],
  );
  const selectedSender =
    activeSenders.find((sender) => sender.id === senderId) ?? activeSenders[0];
  const effectiveSenderId = senderId || selectedSender?.id || '';

  // The typed chips and the uploaded list overlap; showing the union is the
  // only honest count, and it is what the server will schedule.
  const totalRecipients = useMemo(() => {
    const all = new Set(typedRecipients);
    leadParsed?.emails.forEach((email) => all.add(email));
    return all.size;
  }, [typedRecipients, leadParsed]);

  /**
   * The same arithmetic the scheduler uses, run client-side so a 1000-recipient
   * batch tells the user it will span several hours *before* they commit to it.
   */
  const projection = useMemo(() => {
    if (totalRecipients === 0 || !selectedSender) return null;

    const requested = Number(hourlyLimit) || 0;
    // A campaign can tighten the sender's ceiling but never raise it — the same
    // rule the API applies, so the preview cannot promise more than it delivers.
    const effectiveLimit = Math.min(
      requested > 0 ? requested : selectedSender.limitThisHour,
      selectedSender.limitThisHour,
    );

    return projectCampaign({
      startAt: (startAt ?? new Date()).getTime(),
      recipientCount: totalRecipients,
      delayBetweenMs: (Number(delaySeconds) || 0) * 1000,
      hourlyLimit: effectiveLimit,
    });
  }, [totalRecipients, selectedSender, hourlyLimit, startAt, delaySeconds]);

  const missing: string[] = [];
  if (!effectiveSenderId) missing.push('a sender');
  if (totalRecipients === 0) missing.push('at least one recipient');
  if (subject.trim() === '') missing.push('a subject');
  if (bodyHtml.trim() === '') missing.push('a message body');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();

    if (missing.length > 0) {
      setShowErrors(true);
      toast.error('This email is not ready to send', `Add ${missing.join(', ')}.`);
      return;
    }

    const form = new FormData();
    form.set('senderId', effectiveSenderId);
    form.set('subject', subject.trim());
    form.set('bodyHtml', bodyHtml);
    // JSON, not repeated fields: an address containing a comma would otherwise
    // be split apart by the server's delimiter fallback.
    form.set('recipients', JSON.stringify(typedRecipients));
    form.set('delayBetweenSeconds', String(Number(delaySeconds) || 0));
    form.set('hourlyLimit', String(Number(hourlyLimit) || 0));
    if (startAt) form.set('startAt', startAt.toISOString());
    // The file is sent as well as the parsed emails: the server re-parses it as
    // the source of truth rather than trusting a list the browser assembled.
    if (leadFile) form.set('leads', leadFile);
    attachments.forEach((file) => form.append('attachments', file));

    try {
      const result = await createCampaign.mutateAsync(form);

      const parts = [`${result.recipientsAccepted} scheduled`];
      if (result.duplicatesRemoved > 0) parts.push(`${result.duplicatesRemoved} duplicate removed`);
      if (result.invalidSkipped.length > 0) {
        parts.push(`${result.invalidSkipped.length} unreadable line skipped`);
      }
      if (result.throttledByHourlyLimit) {
        parts.push(`draining over ${result.windowsRequired} hour windows`);
      }

      toast.success('Campaign scheduled', parts.join(' · '));
      router.push('/scheduled');
    } catch (error) {
      const message =
        error instanceof ApiRequestError ? error.message : 'Something went wrong.';
      // Field-level messages are more actionable than the summary alone.
      const detail =
        error instanceof ApiRequestError && error.details
          ? Object.entries(error.details)
              .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
              .join(' · ')
          : undefined;

      toast.error(message, detail);
    }
  };

  if (senders.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="text-3xl" />
      </div>
    );
  }

  if (activeSenders.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md rounded-card border border-line p-6 text-center shadow-card">
          <AlertIcon className="mx-auto text-2xl text-warning" />
          <h1 className="mt-3 text-base font-semibold text-ink">No senders configured</h1>
          <p className="mt-1.5 text-sm text-muted">
            Run <code className="font-mono text-xs">npm run provision:ethereal</code> to create
            Ethereal SMTP accounts and seed them.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-5 py-3">
        <IconButton
          label="Back"
          icon={<ArrowLeftIcon />}
          onClick={() => router.back()}
        />
        <h1 className="flex-1 text-base font-semibold text-ink">Compose New Email</h1>

        <AttachmentBar
          files={attachments}
          onChange={setAttachments}
          maxBytes={MAX_ATTACHMENT_BYTES}
          onReject={(message) => toast.error('Attachment not added', message)}
        />

        <SendLaterPopover value={startAt} onChange={setStartAt} />

        <Button
          type="submit"
          variant="outline"
          loading={createCampaign.isPending}
          leftIcon={createCampaign.isPending ? undefined : <SendIcon className="text-base" />}
        >
          {startAt ? 'Send Later' : 'Send'}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <Field label="From" htmlFor="compose-from">
          <select
            id="compose-from"
            value={effectiveSenderId}
            onChange={(event) => setSenderId(event.target.value)}
            className="h-9 cursor-pointer rounded-full bg-neutral-soft px-3.5 text-sm text-ink transition-colors hover:bg-neutral-softHover"
          >
            {activeSenders.map((sender) => (
              <option key={sender.id} value={sender.id}>
                {sender.name} &lt;{sender.fromEmail}&gt;
              </option>
            ))}
          </select>

          {selectedSender && (
            <p className="mt-1.5 text-xs text-muted">
              {selectedSender.usedThisHour} of {selectedSender.limitThisHour} used this hour ·
              global {selectedSender.globalUsedThisHour}/{selectedSender.globalLimitThisHour} ·
              resets {formatFullDate(selectedSender.windowResetsAt)}
            </p>
          )}
        </Field>

        <Field label="To">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <RecipientChips value={typedRecipients} onChange={setTypedRecipients} />
            </div>
            <div className="shrink-0 pt-1.5">
              <UploadList file={leadFile} onFile={setLeadFile} onParsed={setLeadParsed} />
            </div>
          </div>

          {totalRecipients > 0 && (
            <p className="mt-1.5 text-xs text-primary">
              {totalRecipients} email {totalRecipients === 1 ? 'address' : 'addresses'} detected
            </p>
          )}
          {showErrors && totalRecipients === 0 && (
            <p className="mt-1.5 text-xs text-danger">Add at least one recipient.</p>
          )}
        </Field>

        <Field label="Subject" htmlFor="compose-subject">
          <input
            id="compose-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="What is this email about?"
            maxLength={500}
            className="h-9 w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted"
          />
          {showErrors && subject.trim() === '' && (
            <p className="text-xs text-danger">A subject is required.</p>
          )}
        </Field>

        <div className="flex flex-wrap items-end gap-6 border-b border-line py-3">
          <div className="w-[220px]">
            <Input
              label="Delay between 2 emails"
              type="number"
              min={0}
              max={3600}
              value={delaySeconds}
              onChange={(event) => setDelaySeconds(event.target.value)}
              placeholder="00"
              hint="Seconds. Spaced into each row's send time."
            />
          </div>

          <div className="w-[220px]">
            <Input
              label="Hourly Limit"
              type="number"
              min={0}
              max={100000}
              value={hourlyLimit}
              onChange={(event) => setHourlyLimit(event.target.value)}
              placeholder={selectedSender ? String(selectedSender.limitThisHour) : '00'}
              hint="Blank uses the sender's configured limit."
            />
          </div>

          {projection && (
            <p
              className={cn(
                'mb-1.5 flex-1 text-xs',
                projection.throttledByHourlyLimit ? 'text-warning' : 'text-muted',
              )}
            >
              {totalRecipients} emails · last one lands{' '}
              <strong className="font-semibold">
                {formatFullDate(new Date(projection.completesAt).toISOString())}
              </strong>
              {projection.throttledByHourlyLimit && (
                <> — the hourly limit spreads this across {projection.windowsRequired} windows.</>
              )}
            </p>
          )}
        </div>

        <div className="pt-4">
          <BodyEditor value={bodyHtml} onChange={setBodyHtml} />
          {showErrors && bodyHtml.trim() === '' && (
            <p className="mt-1.5 text-xs text-danger">A message body is required.</p>
          )}
        </div>

        <div className="mt-3">
          <AttachmentChips files={attachments} onChange={setAttachments} />
        </div>
      </div>
    </form>
  );
}
