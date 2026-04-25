import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, Redirect } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import AppLayout from "./components/AppLayout";
import CommandPalette from "./components/CommandPalette";
import { useWebSocket } from "./hooks/useWebSocket";
import Onboarding from "./pages/Onboarding";
import NodeDetail from "./pages/NodeDetail";
import Dashboard from "./pages/Dashboard";
import Advisor from "./pages/Advisor";
import TwinAgent from "./pages/TwinAgent";
import MemoryUser from "./pages/Memory";
import Workspace from "./pages/Workspace";
import Settings from "./pages/Settings";
import Agents from "./pages/Agents";
import AgentInspector from "./pages/AgentInspector";
import PortraitCeremony from "./pages/PortraitCeremony";
import Scan from "./pages/Scan";
import Approvals from "./pages/Approvals";
import Sessions from "./pages/Sessions";
import SessionDetail from "./pages/SessionDetail";

function Router() {
  return (
    <Switch>
      {/* Onboarding — skip if already completed */}
      <Route path="/">
        {localStorage.getItem("anchor_onboarded") ? <Redirect to="/dashboard" /> : <Onboarding />}
      </Route>

      {/* User app */}
      <Route>
        <AppLayout>
          <Switch>
            <Route path="/dashboard" component={Dashboard} />
            <Route path="/advisor" component={Advisor} />
            <Route path="/twin" component={TwinAgent} />
            <Route path="/agents" component={Agents} />
            <Route path="/agents/:id/inspect" component={AgentInspector} />
            <Route path="/portrait" component={PortraitCeremony} />
            <Route path="/scan" component={Scan} />
            <Route path="/memory" component={MemoryUser} />
            <Route path="/workspace" component={Workspace} />
            <Route path="/workspace/:id" component={Workspace} />
            <Route path="/graph/:id" component={NodeDetail} />
            <Route path="/approvals" component={Approvals} />
            <Route path="/sessions" component={Sessions} />
            <Route path="/sessions/:id" component={SessionDetail} />
            <Route path="/settings" component={Settings} />
            <Route path="/404" component={NotFound} />
            <Route component={NotFound} />
          </Switch>
        </AppLayout>
      </Route>
    </Switch>
  );
}

function AppInner() {
  useWebSocket(); // Connect to server WebSocket for real-time events
  return (
    <>
      <Toaster />
      <CommandPalette />
      <Router />
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <AppInner />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
