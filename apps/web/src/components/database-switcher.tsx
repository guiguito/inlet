import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ChevronsUpDownIcon, FolderIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * FR-188: the header's project and feedback database context, as a switcher rather
 * than a breadcrumb.
 *
 * A breadcrumb only walks back up, so moving between two feedback databases in the
 * same project meant going home and back down. This shows where you are and moves
 * sideways in one click, which is the traffic an operator actually has.
 */
export function DatabaseSwitcher({
  projectId,
  projectName,
  databaseId,
  databaseName,
}: {
  projectId: string;
  projectName: string;
  databaseId: string;
  databaseName: string;
}) {
  // Only fetched once the menu is opened: the header renders on every page and the
  // list is only needed by someone who is actually switching.
  const [open, setOpen] = useState(false);
  const siblings = useQuery({
    queryKey: ['databases', projectId],
    queryFn: () => api.listDatabases(projectId),
    enabled: open,
  });

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-8 min-w-0 gap-2 px-2 font-normal"
          data-testid="database-switcher"
        >
          <span className="truncate text-muted-foreground">{projectName}</span>
          <span aria-hidden="true" className="text-border">
            /
          </span>
          <span className="truncate font-medium">{databaseName}</span>
          <ChevronsUpDownIcon className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel className="truncate">{projectName}</DropdownMenuLabel>
        {siblings.data?.map((sibling) => (
          <DropdownMenuItem key={sibling.id} asChild>
            <Link to={`/databases/${sibling.id}`}>
              {sibling.id === databaseId ? (
                <CheckIcon />
              ) : (
                <span aria-hidden="true" className="size-4" />
              )}
              <span className="truncate">{sibling.name}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        {siblings.isLoading ? (
          <DropdownMenuItem disabled>Loading</DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={`/projects/${projectId}`}>
            <FolderIcon />
            All of this project
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/">Every project</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
