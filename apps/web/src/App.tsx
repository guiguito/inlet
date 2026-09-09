import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type CurrentUser } from '@/lib/api';
import { Logo } from '@/components/logo';
import { SignInPage } from '@/pages/sign-in';
import { ProjectsPage } from '@/pages/projects';
import { ProjectPage } from '@/pages/project';
import { DatabasePage } from '@/pages/database';
import { SubmissionPage } from '@/pages/submission';
import { BuilderPage } from '@/pages/builder';
import { InvitationPage } from '@/pages/invitation';
import { NotFoundPage } from '@/pages/not-found';
import { RendererPage } from '@/renderer/renderer-page';
import { HostedFormPage } from '@/hosted/hosted-page';

/**
 * FR-004: nothing in the management interface renders before the session is known.
 *
 * The reference renderer is the one route outside the session, because it stands in
 * for a client application and authenticates with a project key instead.
 */
export function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInGate />} />
      <Route path="/render/:databaseId" element={<RendererPage />} />
      {/* FR-130: the shared address. Outside the session, like the renderer, and
          outside the management shell, because it belongs to the operator's brand. */}
      <Route path="/f/:slug" element={<HostedFormPage />} />
      {/* Journey 7.4: reachable without an account, since for most invitees this is
          the first Inlet page they see. */}
      <Route path="/invitations/:token" element={<InvitationPage />} />
      <Route path="/*" element={<AuthenticatedRoutes />} />
    </Routes>
  );
}

function useSession() {
  return useQuery<CurrentUser | null>({
    queryKey: ['session'],
    queryFn: async ({ signal }) => {
      try {
        return await api.me(signal);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return null;
        }
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

function SignInGate() {
  const session = useSession();
  if (session.isLoading) return <Splash />;
  if (session.data) return <Navigate to="/" replace />;
  return <SignInPage />;
}

function AuthenticatedRoutes() {
  const session = useSession();
  const location = useLocation();

  if (session.isLoading) return <Splash />;
  if (!session.data) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  const user = session.data;

  return (
    <Routes>
      <Route path="/" element={<ProjectsPage user={user} />} />
      <Route path="/projects/:projectId" element={<ProjectPage user={user} />} />
      <Route path="/databases/:databaseId" element={<DatabasePage user={user} />} />
      <Route path="/databases/:databaseId/builder" element={<BuilderPage user={user} />} />
      <Route
        path="/databases/:databaseId/submissions/:submissionId"
        element={<SubmissionPage user={user} />}
      />
      <Route path="*" element={<NotFoundPage user={user} />} />
    </Routes>
  );
}

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <Logo className="size-7 animate-pulse text-primary" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
