import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, Redirect } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import AppLayout from "./components/AppLayout";
import AdminLayout from "./components/AdminLayout";
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
import Cortex from "./pages/Cortex";
import Logs from "./pages/admin/Logs";
import Data from "./pages/admin/Data";
import Costs from "./pages/admin/Costs";
import Performance from "./pages/admin/Performance";
import GraphAdmin from "./pages/admin/Graph";
import MemoryAdmin from "./pages/admin/Memory";
import Health from "./pages/admin/Health";
import Runs from "./pages/admin/Runs";
import RunTrace from "./pages/admin/RunTrace";
import BridgesAdvanced from "./pages/admin/BridgesAdvanced";

function Router() {
  return (
    <Switch>
      {/* Admin routes */}
      <Route path="/admin"><AdminLayout><Cortex /></AdminLayout></Route>
      <Route path="/admin/costs"><AdminLayout><Costs /></AdminLayout></Route>
      <Route path="/admin/performance"><AdminLayout><Performance /></AdminLayout></Route>
      <Route path="/admin/logs"><AdminLayout><Logs /></AdminLayout></Route>
      <Route path="/admin/graph"><AdminLayout><GraphAdmin /></AdminLayout></Route>
      <Route path="/admin/memory"><AdminLayout><MemoryAdmin /></AdminLayout></Route>
      <Route path="/admin/data"><AdminLayout><Data /></AdminLayout></Route>
      <Route path="/admin/health"><AdminLayout><Health /></AdminLayout></Route>
      <Route path="/admin/runs"><AdminLayout><Runs /></AdminLayout></Route>
      <Route path="/admin/runs/:runId"><AdminLayout><RunTrace /></AdminLayout></Route>
      <Route path="/admin/bridges-advanced"><AdminLayout><BridgesAdvanced /></AdminLayout></Route>

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
            <Route path="/memory" component={MemoryUser} />
            <Route path="/workspace" component={Workspace} />
            <Route path="/workspace/:id" component={Workspace} />
            <Route path="/graph/:id" component={NodeDetail} />
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
