import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { api, ApiError, type ConfigDatabase } from '@/lib/api';
import { CONFIG_CONSENT_NOTE, configSnippets } from '@/lib/config-snippets';
import { CopyField } from '@/components/copy-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { pluralize } from '@/lib/format';
import { reachKey, sharePercent } from './history-tab';

/**
 * The Integrate group of a config database (Remote Config PRD 8.1, 5.1): what an application
 * needs, a snippet per runtime with the base URL, key and ID filled in (`lib/config-snippets.ts`,
 * written against `packages/sdk/README.md`), the active version's defaults as TypeScript
 * (RC-063), how values reach an app, the last 24 hours' fetches (RC-072) and the statement that
 * targeting is not access control.
 */
export function IntegrateTab({ database }: { database: ConfigDatabase }) {
  const credentials = useQuery({ queryKey: ['credentials', database.projectId], queryFn: () => api.listCredentials(database.projectId) });
  const publishable = (credentials.data ?? []).filter((credential) => credential.type === 'publishable' && !credential.revokedAt && credential.key);
  const snippets = configSnippets({
    baseUrl: window.location.origin,
    publishableKey: publishable[0]?.key ?? 'ipk_your_publishable_client_key',
    databaseId: database.id,
  });
  const defaults = useQuery({
    queryKey: ['config-export', database.id, database.activeVersion, 'ts'],
    queryFn: () => api.exportConfig(database.id, 'active', 'ts'),
    enabled: database.activeVersion !== null,
  });
  const reach = useQuery({ queryKey: reachKey(database.id), queryFn: () => api.getConfigReach(database.id), retry: false, staleTime: 60_000 });
  const last24 = reach.data?.summary.last24Hours;

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>What your app needs</CardTitle>
          <CardDescription>This config database ID and a publishable client key of the project. Both are safe to ship in an application.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyField label="Config database ID" value={database.id} />
          {publishable.length > 0 ? (
            publishable.map((credential) => <CopyField key={credential.id} label={`Publishable client key (${credential.label})`} value={credential.key!} />)
          ) : credentials.data ? (
            <div className="space-y-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              <p>This project has no publishable client key yet.</p>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/projects/${database.projectId}`}>Create one in API keys</Link>
              </Button>
            </div>
          ) : credentials.error instanceof ApiError && (credentials.error.status === 403 || credentials.error.status === 404) ? (
            // Listing credentials is a project Admin's (Foundations FR-085); the snippets keep a placeholder key.
            <p className="text-sm text-muted-foreground" data-testid="integrate-keys-admin-only">
              Publishable keys are managed by a project Admin. Ask one for the key to put in your app.
            </p>
          ) : null}
          <p className="text-[13px] font-medium">Targeting is not access control. Anyone with your publishable key can ask for the values of any user.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How values reach your app</CardTitle>
          <CardDescription>
            A running app fetches at each launch and every {pluralize(database.refreshIntervalMinutes, 'minute')} (the refresh interval), and applies what it
            fetched at its next launch, so a screen never changes under a user’s finger. A parameter marked live applies as soon as it is fetched, for a kill
            switch.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm" data-testid="integrate-reach">
            {last24
              ? `${pluralize(last24.fetches, 'fetch', 'fetches')} in the last 24 hours${
                  last24.activeVersion === null
                    ? '; nothing is published.'
                    : last24.activeVersionShare === null
                      ? `; none on version ${last24.activeVersion}, the active version.`
                      : `, ${sharePercent(last24.activeVersionShare)} of them on version ${last24.activeVersion}, the active version.`
                }`
              : reach.error
                ? 'The fetches could not be read.'
                : 'Reading the fetches of the last 24 hours.'}
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">{reach.data?.notice ?? 'These are fetches, not devices.'}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Defaults for your code</CardTitle>
          <CardDescription>
            The active version’s defaults as a TypeScript object: save it as <code className="font-mono">inlet-config-defaults.ts</code> and pass it as{' '}
            <code className="font-mono">defaults</code>, so your app reads sensible values before its first fetch and offline.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {database.activeVersion === null ? (
            <p className="text-sm text-muted-foreground">Nothing is published. Publish a version to get its defaults here.</p>
          ) : defaults.isLoading ? (
            <Skeleton className="h-32" />
          ) : defaults.error || defaults.data === undefined ? (
            <p className="text-sm text-destructive">{defaults.error instanceof ApiError ? defaults.error.message : 'The defaults could not be read.'}</p>
          ) : (
            <CodeBlock code={defaults.data} label="the defaults" testId="config-defaults-ts" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Read values with inlet-sdk</CardTitle>
          <CardDescription>
            {CONFIG_CONSENT_NOTE} The <code className="font-mono">inlet-sdk</code> README’s “Remote config” section has every option.
          </CardDescription>
        </CardHeader>
      </Card>
      {snippets.map((snippet) => (
        <Card key={snippet.runtime}>
          <CardHeader>
            <CardTitle>{snippet.runtime}</CardTitle>
            {snippet.note ? <CardDescription>{snippet.note}</CardDescription> : null}
          </CardHeader>
          <CardContent>
            <CodeBlock code={snippet.code} label={`the ${snippet.runtime} snippet`} testId={`config-snippet-${snippet.runtime}`} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function CodeBlock({ code, label, testId }: { code: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the code stays selectable either way.
    }
  };
  return (
    <div className="relative">
      <pre data-testid={testId} className="overflow-x-auto rounded-md border bg-muted/40 p-4 pr-12 font-mono text-xs leading-relaxed">
        {code}
      </pre>
      <Button type="button" variant="outline" size="icon-sm" className="absolute right-2 top-2" onClick={copy} aria-label={copied ? 'Copied' : `Copy ${label}`}>
        {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      </Button>
    </div>
  );
}
