import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import { StepUpProvider } from "./components/stepup";
import { ToastProvider } from "./components/toasts";
import { Spinner } from "./components/ui";
import { AlertsProvider } from "./lib/alerts";
import { AuthProvider, useAuth } from "./lib/auth";
import { RealtimeProvider } from "./lib/realtime";
import Login from "./pages/Login";
import Onboarding from "./pages/Onboarding";
import type { Role } from "./lib/types";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const VideoWall = lazy(() => import("./pages/VideoWall"));
const Recordings = lazy(() => import("./pages/Recordings"));
const Events = lazy(() => import("./pages/Events"));
const Assistant = lazy(() => import("./pages/Assistant"));
const Connectivity = lazy(() => import("./pages/Connectivity"));
const Vault = lazy(() => import("./pages/Vault"));
const Admin = lazy(() => import("./pages/Admin"));
const Profile = lazy(() => import("./pages/Profile"));

function Loading() {
  return (
    <div className="h-full min-h-[50vh] grid place-items-center">
      <Spinner size={28} />
    </div>
  );
}

function RequireRole({ role, children }: { role: Role; children: React.ReactNode }) {
  const { can } = useAuth();
  return can(role) ? <>{children}</> : <Navigate to="/" replace />;
}

function Gate() {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  if (!me) return <Login />;
  if (me.restrictions.mustChangePassword || me.restrictions.mustEnrollTotp) return <Onboarding />;
  return (
    <RealtimeProvider>
      <AlertsProvider>
        <StepUpProvider>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Dashboard />} />
                <Route path="video" element={<VideoWall />} />
                <Route path="grabaciones" element={<Recordings />} />
                <Route path="eventos" element={<Events />} />
                <Route
                  path="ia"
                  element={
                    <RequireRole role="operator">
                      <Assistant />
                    </RequireRole>
                  }
                />
                <Route path="conectividad" element={<Connectivity />} />
                <Route
                  path="boveda"
                  element={
                    <RequireRole role="tester">
                      <Vault />
                    </RequireRole>
                  }
                />
                <Route
                  path="admin"
                  element={
                    <RequireRole role="tester">
                      <Admin />
                    </RequireRole>
                  }
                />
                <Route path="perfil" element={<Profile />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </StepUpProvider>
      </AlertsProvider>
    </RealtimeProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
