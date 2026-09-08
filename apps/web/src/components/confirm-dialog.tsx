import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Destructive confirmation (PRD section 20.6): it states what is lost.
 *
 * When `confirmText` is set the operator has to type it, which is reserved for
 * deletions that cascade to collected feedback.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = 'Delete',
  confirmText,
  onConfirm,
  pending = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  confirmText?: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const ready = confirmText === undefined || typed.trim() === confirmText;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('');
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </DialogDescription>
        </DialogHeader>

        {children}

        {confirmText ? (
          <div className="space-y-1.5">
            <Label htmlFor="confirm-text">
              Type <span className="font-mono text-foreground">{confirmText}</span> to confirm
            </Label>
            <Input
              id="confirm-text"
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={!ready || pending}>
            {pending ? 'Deleting' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
