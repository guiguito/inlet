import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2Icon, ExternalLinkIcon, SendIcon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';
import { NOTIFICATION_LIMITS, type SlackContentLevel } from '@inlet/shared';
import {
  api,
  ApiError,
  type SlackNotifications,
  type SlackNotificationsPatch,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { formatDateTime } from '@/lib/format';

/**
 * The Notify tab (FR-170).
 *
 * One required input, and the panel says so: a Slack webhook URL. Everything else has a
 * working default. The test-message button exists because the alternative way to learn
 * whether a webhook works is to wait for a real response and then wonder.
 *
 * Two things are stated here rather than buried in documentation, because an operator
 * deciding this needs to know both: which personalization fields Slack silently ignores
 * depending on how the webhook was created, and that Slack keeps its own copy of anything
 * sent, so deleting a response in Inlet does not unsend a message.
 */

const CONTENT_CHOICES: { value: SlackContentLevel; label: string; note: string }[] = [
  {
    value: 'link_only',
    label: 'Just a heads-up and a link',
    note: 'No answer content leaves your server. Open Inlet to read the response.',
  },
  {
    value: 'answers',
    label: 'Include the answers',
    note: 'The questions and answers appear in Slack. A collected email address does not.',
  },
  {
    value: 'answers_with_email',
    label: 'Include the answers and the email address',
    note: 'Also sends an address a respondent gave you, which identifies them to everyone in the channel.',
  },
];

export function NotifyPanel({
  databaseId,
  hideContentLevel = false,
}: {
  databaseId: string;
  /** CR-050: a crash database announces groups only; there is no content to choose. */
  hideContentLevel?: boolean;
}) {
  const queryClient = useQueryClient();
  const notifications = useQuery({
    queryKey: ['slack-notifications', databaseId],
    queryFn: () => api.getSlackNotifications(databaseId),
  });

  const [draft, setDraft] = useState<SlackNotifications | null>(null);
  /**
   * Kept out of the draft and out of the query cache on purpose. The URL is a credential,
   * the API never returns it, and putting it in the cache would be the one place a copy
   * lingered after it was saved.
   */
  const [webhookInput, setWebhookInput] = useState('');

  useEffect(() => {
    setDraft((current) => current ?? notifications.data ?? null);
  }, [notifications.data]);

  const settle = (row: SlackNotifications) => {
    const previous = queryClient.getQueryData<SlackNotifications>([
      'slack-notifications',
      databaseId,
    ]);
    queryClient.setQueryData(['slack-notifications', databaseId], row);
    setDraft((current) => {
      if (!current || !previous) return row;
      const merged: SlackNotifications = { ...row };
      for (const field of DIRTY_FIELDS) {
        if (current[field] !== previous[field]) {
          (merged[field] as SlackNotifications[typeof field]) = current[field];
        }
      }
      return merged;
    });
  };

  const failed = (error: unknown, fallback: string) =>
    toast.error(error instanceof ApiError ? error.message : fallback);

  const save = useMutation({
    mutationFn: (patch: SlackNotificationsPatch) => api.updateSlackNotifications(databaseId, patch),
    onSuccess: (row) => {
      settle(row);
      toast.success('Notification settings updated.');
    },
    onError: (error) => failed(error, 'Those settings could not be saved.'),
  });

  const saveWebhook = useMutation({
    mutationFn: (webhookUrl: string | null) =>
      api.updateSlackNotifications(databaseId, { webhookUrl }),
    onSuccess: (row) => {
      settle(row);
      setWebhookInput('');
      toast.success(row.webhookConfigured ? 'Webhook saved.' : 'Webhook removed.');
    },
    onError: (error) => failed(error, 'That webhook URL could not be saved.'),
  });

  const test = useMutation({
    mutationFn: () => api.sendSlackTestMessage(databaseId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['slack-notifications', databaseId] });
      toast.success('Slack accepted the test message. Check your channel.');
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: ['slack-notifications', databaseId] });
      failed(error, 'Slack did not accept the test message.');
    },
  });

  if (notifications.isLoading || !draft) return <Skeleton className="h-96" />;
  if (notifications.error) {
    return (
      <p className="text-sm text-muted-foreground">
        {notifications.error instanceof ApiError
          ? notifications.error.message
          : 'The notification settings could not be loaded.'}
      </p>
    );
  }

  const saved = notifications.data as SlackNotifications;
  const set = <K extends keyof SlackNotifications>(key: K, value: SlackNotifications[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const dirty = DIRTY_FIELDS.filter((field) => draft[field] !== saved[field]);
  const patch = Object.fromEntries(
    dirty.map((field) => [field, draft[field]]),
  ) as SlackNotificationsPatch;

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Connect Slack</CardTitle>
          <CardDescription>
            One thing is required: an incoming webhook URL from your Slack workspace.
            Everything below it is optional.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ol className="space-y-1 text-sm text-muted-foreground">
            <li>
              1. In Slack, create an incoming webhook and choose the channel it posts to.{' '}
              <a
                href="https://api.slack.com/messaging/webhooks"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                Slack&rsquo;s instructions
                <ExternalLinkIcon className="size-3" />
              </a>
            </li>
            <li>2. Copy the webhook URL and paste it here.</li>
            <li>3. Send a test message, then switch notifications on.</li>
          </ol>

          <div className="space-y-1.5">
            <Label htmlFor="slack-webhook">
              Webhook URL <span className="text-muted-foreground">(required)</span>
            </Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="slack-webhook"
                type="url"
                autoComplete="off"
                spellCheck={false}
                className="min-w-64 flex-1 font-mono text-xs"
                placeholder={
                  saved.webhookUrlMasked ?? 'https://hooks.slack.com/services/T0.../B0.../...'
                }
                value={webhookInput}
                onChange={(event) => setWebhookInput(event.target.value)}
              />
              <Button
                variant="outline"
                disabled={webhookInput.trim() === '' || saveWebhook.isPending}
                onClick={() => saveWebhook.mutate(webhookInput.trim())}
              >
                Save webhook
              </Button>
              {saved.webhookConfigured ? (
                <Button
                  variant="ghost"
                  disabled={saveWebhook.isPending}
                  onClick={() => saveWebhook.mutate(null)}
                >
                  Remove
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {saved.webhookConfigured
                ? 'A webhook is saved. It is never shown again, so paste a new one to replace it.'
                : 'Must be a Slack webhook address. Nothing else is accepted.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={!saved.webhookConfigured || test.isPending}
              onClick={() => test.mutate()}
            >
              <SendIcon />
              {test.isPending ? 'Sending' : 'Send a test message'}
            </Button>
            <DeliveryStatus settings={saved} />
          </div>

          <label className="flex items-start gap-3 border-t pt-4">
            <Switch
              checked={draft.enabled}
              disabled={!saved.webhookConfigured || save.isPending}
              onCheckedChange={(next) => save.mutate({ enabled: next })}
              aria-label="Notify Slack when a response arrives"
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">
                {draft.enabled ? 'Notifying Slack' : 'Not notifying Slack'}
              </span>
              <span className="block text-xs text-muted-foreground">
                {saved.webhookConfigured
                  ? 'Every new response posts a message, however it was collected.'
                  : 'Save a webhook URL first.'}
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      {hideContentLevel ? null : (
      <Card>
        <CardHeader>
          <CardTitle>What Slack sees</CardTitle>
          <CardDescription>
            A Slack channel is usually readable by more people, for longer, than a feedback
            database is.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={draft.contentLevel}
            onValueChange={(next) => set('contentLevel', next as SlackContentLevel)}
          >
            {CONTENT_CHOICES.map((choice) => (
              <label key={choice.value} className="flex items-start gap-3">
                <RadioGroupItem value={choice.value} id={`content-${choice.value}`} />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">{choice.label}</span>
                  <span className="block text-xs text-muted-foreground">{choice.note}</span>
                </span>
              </label>
            ))}
          </RadioGroup>

          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-muted-foreground">
            Slack keeps its own copy. Deleting a response in Inlet does not remove a message
            already delivered to your channel.
          </p>
        </CardContent>
      </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Optional. Every field here has a sensible default.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="slack-title">Message heading</Label>
            <Input
              id="slack-title"
              maxLength={NOTIFICATION_LIMITS.messageTitleMaxLength}
              placeholder="New response in this feedback database"
              value={draft.messageTitle ?? ''}
              onChange={(event) =>
                set('messageTitle', event.target.value === '' ? null : event.target.value)
              }
            />
            <p className="text-xs text-muted-foreground">
              Slack mention syntax works here, so <code>&lt;!here&gt;</code> notifies the
              channel. Answers a respondent typed are always escaped and can never mention
              anyone.
            </p>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm font-medium">Overrides</p>
            <p className="text-xs text-muted-foreground">
              These work on a webhook created as a legacy custom integration. A webhook created
              from a Slack app ignores them and always posts as that app, to the channel chosen
              when the webhook was made. If an override has no effect, that tells you which kind
              you have.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="slack-channel">Channel</Label>
                <Input
                  id="slack-channel"
                  placeholder="#feedback"
                  value={draft.channel ?? ''}
                  onChange={(event) =>
                    set('channel', event.target.value === '' ? null : event.target.value)
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="slack-username">Posts as</Label>
                <Input
                  id="slack-username"
                  placeholder="Inlet"
                  value={draft.username ?? ''}
                  onChange={(event) =>
                    set('username', event.target.value === '' ? null : event.target.value)
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="slack-icon">Icon</Label>
                <Input
                  id="slack-icon"
                  placeholder=":inbox_tray:"
                  value={draft.iconEmoji ?? ''}
                  onChange={(event) =>
                    set('iconEmoji', event.target.value === '' ? null : event.target.value)
                  }
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button disabled={dirty.length === 0 || save.isPending} onClick={() => save.mutate(patch)}>
          {save.isPending ? 'Saving' : 'Save changes'}
        </Button>
        {dirty.length > 0 ? (
          <>
            <span className="text-xs text-muted-foreground">
              {dirty.length === 1 ? '1 unsaved change' : `${dirty.length} unsaved changes`}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setDraft(saved)}>
              Discard
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The fields the Save button sends. The enable switch and the webhook save on their own. */
const DIRTY_FIELDS = [
  'contentLevel',
  'messageTitle',
  'channel',
  'username',
  'iconEmoji',
] as const satisfies readonly (keyof SlackNotificationsPatch)[];

/**
 * FR-169: whether it is working, in one line.
 *
 * Without this, "Slack notifications aren't arriving" is undiagnosable from the interface,
 * which on a self-hosted product means reading the database to find out.
 */
function DeliveryStatus({ settings }: { settings: SlackNotifications }) {
  if (settings.lastError) {
    return (
      <span className="flex items-start gap-1.5 text-xs text-destructive" data-testid="slack-status">
        <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Slack refused the last message: <code>{settings.lastError}</code>
          {settings.lastErrorAt ? ` (${formatDateTime(settings.lastErrorAt)})` : ''}
          {settings.failedCount > 0
            ? `. ${settings.failedCount} notification${settings.failedCount === 1 ? '' : 's'} gave up.`
            : ''}
        </span>
      </span>
    );
  }
  if (settings.lastDeliveryAt) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="slack-status">
        <CheckCircle2Icon className="size-3.5 shrink-0 text-primary" />
        Last delivered {formatDateTime(settings.lastDeliveryAt)}
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground" data-testid="slack-status">
      Nothing delivered yet.
    </span>
  );
}
