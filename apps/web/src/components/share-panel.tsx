import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, ImageIcon, RotateCcwIcon, TrashIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  BRANDING_LIMITS,
  COLOR_SCHEMES,
  CORNER_RADII,
  EMBEDDING_MODES,
  TYPEFACES,
  contrastRatio,
  readableForeground,
} from '@inlet/shared';
import { api, ApiError, type HostedForm, type HostedFormPatch } from '@/lib/api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyField } from '@/components/copy-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/**
 * The Share tab (FR-152).
 *
 * Everything an operator needs to turn a feedback database into a link: the address,
 * the branding, the copy a respondent reads, how it may be embedded, and a live
 * preview of the result. The preview is the real page in an iframe rather than a
 * re-implementation, so what is shown is what a respondent gets.
 *
 * The API is the second collection path, not a replacement: the Integrate tab is
 * unchanged and both work at once on the same feedback database.
 */
export function SharePanel({ databaseId }: { databaseId: string }) {
  const queryClient = useQueryClient();
  const hosted = useQuery({
    queryKey: ['hosted-form', databaseId],
    queryFn: () => api.getHostedForm(databaseId),
  });

  const [draft, setDraft] = useState<HostedForm | null>(null);
  const [rotating, setRotating] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    setDraft((current) => current ?? hosted.data ?? null);
  }, [hosted.data]);

  /**
   * Adopts the server's answer without discarding unsaved edits.
   *
   * The server normalises what it stores, so the editor takes its values rather than
   * keeping what was typed. But the enable switch and the logo save on their own,
   * and an operator halfway through typing a new address must not lose it because
   * they uploaded a logo, so a field they have changed and not yet saved is kept.
   */
  const settle = (row: HostedForm) => {
    const previous = queryClient.getQueryData<HostedForm>(['hosted-form', databaseId]);
    queryClient.setQueryData(['hosted-form', databaseId], row);
    setDraft((current) => {
      if (!current || !previous) return row;
      const merged: HostedForm = { ...row };
      for (const field of DIRTY_FIELDS) {
        if (!same(current[field], previous[field])) {
          (merged[field] as HostedForm[typeof field]) = current[field];
        }
      }
      return merged;
    });
    setPreviewKey((key) => key + 1);
  };

  const failed = (error: unknown, fallback: string) =>
    toast.error(error instanceof ApiError ? error.message : fallback);

  const save = useMutation({
    mutationFn: (patch: HostedFormPatch) => api.updateHostedForm(databaseId, patch),
    onSuccess: (row) => {
      settle(row);
      toast.success('The hosted form has been updated.');
    },
    onError: (error) => failed(error, 'Those settings could not be saved.'),
  });

  const rotate = useMutation({
    mutationFn: () => api.rotateHostedSlug(databaseId),
    onSuccess: (row) => {
      settle(row);
      setRotating(false);
      toast.success('The address has been changed. The previous link no longer works.');
    },
    onError: (error) => failed(error, 'The address could not be changed.'),
  });

  const uploadLogo = useMutation({
    mutationFn: ({ file, alt }: { file: File; alt: string }) =>
      api.uploadHostedLogo(databaseId, file, alt),
    onSuccess: (row) => {
      settle(row);
      toast.success('The logo has been updated.');
    },
    onError: (error) => failed(error, 'That logo could not be uploaded.'),
  });

  const removeLogo = useMutation({
    mutationFn: () => api.removeHostedLogo(databaseId),
    onSuccess: (row) => {
      settle(row);
      toast.success('The logo has been removed.');
    },
    onError: (error) => failed(error, 'The logo could not be removed.'),
  });

  if (hosted.isLoading || !draft) return <Skeleton className="h-96" />;
  if (hosted.error) {
    return (
      <p className="text-sm text-muted-foreground">
        {hosted.error instanceof ApiError
          ? hosted.error.message
          : 'The hosted form could not be loaded.'}
      </p>
    );
  }

  const saved = hosted.data as HostedForm;
  const set = <K extends keyof HostedForm>(key: K, value: HostedForm[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const dirty = DIRTY_FIELDS.filter((field) => !same(draft[field], saved[field]));
  const patch = Object.fromEntries(dirty.map((field) => [field, draft[field]])) as HostedFormPatch;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Address</CardTitle>
          <CardDescription>
            Share this link, or embed it. It needs no API key and no account, so anyone with
            the link can respond.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-3">
            <Switch
              checked={draft.enabled}
              onCheckedChange={(next) => save.mutate({ enabled: next })}
              disabled={save.isPending}
              aria-label="Collect responses through this link"
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">
                {draft.enabled ? 'Collecting responses' : 'Not collecting'}
              </span>
              <span className="block text-xs text-muted-foreground">
                {draft.enabled
                  ? 'Anyone with the link can respond, as long as a version is published.'
                  : 'The link shows your closed message. Nothing else changes.'}
              </span>
            </span>
          </label>

          <CopyField label="Link to share" value={saved.url} />

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label htmlFor="hosted-slug">Custom address</Label>
              <Input
                id="hosted-slug"
                value={draft.slug}
                minLength={BRANDING_LIMITS.slugMinLength}
                maxLength={BRANDING_LIMITS.slugMaxLength}
                spellCheck={false}
                onChange={(event) => set('slug', event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, digits and hyphens. Changing it breaks the previous link.
              </p>
            </div>
            <Button variant="outline" asChild>
              <a href={saved.url} target="_blank" rel="noreferrer">
                <ExternalLinkIcon />
                Open
              </a>
            </Button>
            <Button variant="outline" onClick={() => setRotating(true)}>
              <RotateCcwIcon />
              New address
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Branding</CardTitle>
              <CardDescription>
                Presentation only. Branding never changes what is asked or what is stored.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="hosted-accent">Accent colour</Label>
                <div className="flex items-center gap-2">
                  <input
                    id="hosted-accent"
                    type="color"
                    value={normalizeHex(draft.accentColor)}
                    onChange={(event) => set('accentColor', event.target.value.toUpperCase())}
                    className="size-9 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1"
                  />
                  <Input
                    value={draft.accentColor}
                    aria-label="Accent colour hex value"
                    spellCheck={false}
                    className="font-mono"
                    onChange={(event) => set('accentColor', event.target.value)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Text on the accent is{' '}
                  {readableForeground(normalizeHex(draft.accentColor)) === '#FFFFFF'
                    ? 'white'
                    : 'black'}
                  , chosen for contrast at{' '}
                  {contrastRatio(
                    normalizeHex(draft.accentColor),
                    readableForeground(normalizeHex(draft.accentColor)),
                  ).toFixed(1)}
                  :1.
                </p>
              </div>

              <Choice
                id="hosted-scheme"
                label="Colour scheme"
                value={draft.colorScheme}
                options={COLOR_SCHEMES}
                onChange={(value) => set('colorScheme', value)}
              />
              <Choice
                id="hosted-radius"
                label="Corners"
                value={draft.cornerRadius}
                options={CORNER_RADII}
                onChange={(value) => set('cornerRadius', value)}
              />
              <Choice
                id="hosted-typeface"
                label="Typeface"
                value={draft.typeface}
                options={TYPEFACES}
                onChange={(value) => set('typeface', value)}
              />

              <LogoField
                logoUrl={saved.logoUrl}
                alt={draft.logoAlt ?? ''}
                pending={uploadLogo.isPending || removeLogo.isPending}
                onAlt={(value) => set('logoAlt', value === '' ? null : value)}
                onUpload={(file) => uploadLogo.mutate({ file, alt: draft.logoAlt ?? '' })}
                onRemove={() => removeLogo.mutate()}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Wording</CardTitle>
              <CardDescription>What a respondent reads on the page.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field id="hosted-submit" label="Submit button">
                <Input
                  id="hosted-submit"
                  value={draft.submitLabel}
                  maxLength={BRANDING_LIMITS.submitLabelMaxLength}
                  onChange={(event) => set('submitLabel', event.target.value)}
                />
              </Field>
              <Field id="hosted-thanks-title" label="Thank-you title">
                <Input
                  id="hosted-thanks-title"
                  value={draft.thankYouTitle}
                  maxLength={BRANDING_LIMITS.thankYouTitleMaxLength}
                  onChange={(event) => set('thankYouTitle', event.target.value)}
                />
              </Field>
              <Field id="hosted-thanks-body" label="Thank-you message">
                <Textarea
                  id="hosted-thanks-body"
                  value={draft.thankYouBody}
                  maxLength={BRANDING_LIMITS.thankYouBodyMaxLength}
                  onChange={(event) => set('thankYouBody', event.target.value)}
                />
              </Field>
              <Field
                id="hosted-closed"
                label="Message when closed"
                hint="Shown when the link is off, or when no version is published."
              >
                <Textarea
                  id="hosted-closed"
                  value={draft.closedMessage}
                  maxLength={BRANDING_LIMITS.closedMessageMaxLength}
                  onChange={(event) => set('closedMessage', event.target.value)}
                />
              </Field>
              <Field
                id="hosted-redirect"
                label="Redirect after submitting"
                hint="Optional. Leave empty to show the thank-you message instead."
              >
                <Input
                  id="hosted-redirect"
                  type="url"
                  placeholder="https://example.com/thanks"
                  value={draft.redirectUrl ?? ''}
                  onChange={(event) =>
                    set('redirectUrl', event.target.value.trim() === '' ? null : event.target.value)
                  }
                />
              </Field>
              <label className="flex items-center gap-3">
                <Switch
                  checked={draft.showProgress}
                  onCheckedChange={(next) => set('showProgress', next)}
                  aria-label="Show progress across pages"
                />
                <span className="text-sm">Show progress across pages</span>
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Embedding</CardTitle>
              <CardDescription>
                Where this form may be shown inside a frame. Enforced by the browser through
                the page's own headers.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Choice
                id="hosted-embedding"
                label="Allowed in a frame"
                value={draft.embedding}
                options={EMBEDDING_MODES}
                onChange={(value) => set('embedding', value)}
              />
              {draft.embedding === 'listed' ? (
                <Field
                  id="hosted-origins"
                  label="Allowed origins"
                  hint="One per line, scheme and host only, for example https://app.example.com."
                >
                  <Textarea
                    id="hosted-origins"
                    value={draft.allowedOrigins.join('\n')}
                    spellCheck={false}
                    className="font-mono text-xs"
                    onChange={(event) =>
                      set(
                        'allowedOrigins',
                        event.target.value
                          .split('\n')
                          .map((line) => line.trim())
                          .filter((line) => line !== ''),
                      )
                    }
                  />
                </Field>
              ) : null}
              {draft.embedding === 'nowhere' ? null : (
                <div className="space-y-1.5">
                  <Label htmlFor="hosted-snippet">Embed snippet</Label>
                  <CopyField value={embedSnippet(saved.url)} />
                  <p className="text-xs text-muted-foreground">
                    The frame sizes itself to the form, so the embedding page never has to
                    guess a height.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex items-center gap-3">
            <Button
              disabled={dirty.length === 0 || save.isPending}
              onClick={() => save.mutate(patch)}
            >
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

        <Card className="lg:sticky lg:top-4 lg:self-start">
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>
              The page itself, as a respondent sees it. Saved changes appear here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <iframe
              key={previewKey}
              title="Hosted form preview"
              src={`/f/${saved.slug}?embed=1`}
              className="h-[32rem] w-full rounded-md border bg-white"
            />
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        title="Change the address"
        description="The current link stops working immediately. Anyone using it, including embedded frames, will need the new one."
        confirmLabel="Change the address"
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
      />
    </div>
  );
}

/** The fields the Save button sends. The enable switch and the logo save on their own. */
const DIRTY_FIELDS = [
  'slug',
  'accentColor',
  'colorScheme',
  'cornerRadius',
  'typeface',
  'logoAlt',
  'submitLabel',
  'thankYouTitle',
  'thankYouBody',
  'closedMessage',
  'redirectUrl',
  'showProgress',
  'embedding',
  'allowedOrigins',
] as const satisfies readonly (keyof HostedFormPatch)[];

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return a === b;
}

/** The colour input needs six digits; the text field may hold anything mid-typing. */
function normalizeHex(value: string): string {
  const bare = value.trim().replace(/^#/, '');
  const full =
    bare.length === 3
      ? bare
          .split('')
          .map((char) => char + char)
          .join('')
      : bare;
  return /^[0-9a-fA-F]{6}$/.test(full) ? `#${full.toUpperCase()}` : '#18181B';
}

/**
 * FR-153: the snippet an operator pastes.
 *
 * The frame reports its own height, and this listens for it. The check against
 * `contentWindow` matters: without it any frame on the embedding page could resize
 * this one by posting the same message.
 */
export function embedSnippet(url: string): string {
  return `<iframe id="inlet-form" src="${url}?embed=1" title="Feedback" width="100%" height="520" style="border:0" loading="lazy"></iframe>
<script>
  window.addEventListener('message', function (event) {
    var frame = document.getElementById('inlet-form');
    if (!frame || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.source !== 'inlet' || data.type !== 'height') return;
    frame.style.height = data.height + 'px';
  });
</script>`;
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** One of a closed set of values. The labels are the values, which read fine here. */
function Choice<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option.charAt(0).toUpperCase() + option.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function LogoField({
  logoUrl,
  alt,
  pending,
  onAlt,
  onUpload,
  onRemove,
}: {
  logoUrl: string | null;
  alt: string;
  pending: boolean;
  onAlt: (value: string) => void;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const accepted = useMemo(() => 'image/png,image/jpeg,image/webp', []);

  return (
    <div className="space-y-2">
      <Label>Logo</Label>
      <div className="flex items-center gap-3">
        <div className="grid size-14 shrink-0 place-items-center rounded-md border bg-muted/40">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="max-h-12 max-w-12 object-contain" />
          ) : (
            <ImageIcon className="size-5 text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={pending} onClick={() => input.current?.click()}>
            {logoUrl ? 'Replace' : 'Upload'}
          </Button>
          {logoUrl ? (
            <Button variant="ghost" size="sm" disabled={pending} onClick={onRemove}>
              <TrashIcon />
              Remove
            </Button>
          ) : null}
        </div>
        <input
          ref={input}
          type="file"
          accept={accepted}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onUpload(file);
          }}
        />
      </div>
      <Input
        value={alt}
        placeholder="Describes the logo for screen readers"
        aria-label="Logo description"
        maxLength={BRANDING_LIMITS.logoAltMaxLength}
        onChange={(event) => onAlt(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        PNG, JPEG or WebP, up to {BRANDING_LIMITS.logoMaxSourceBytes / (1024 * 1024)} MB. Stored
        as WebP.
      </p>
    </div>
  );
}
