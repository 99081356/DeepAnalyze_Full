import { createHashRouter, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Spinner } from "./components/ui/Spinner";

// Named exports — use .then(m => ({ default: m.X })) pattern
const ChatWindow = lazy(() => import("./components/ChatWindow").then(m => ({ default: m.ChatWindow })));
const KnowledgePanel = lazy(() => import("./components/knowledge/KnowledgePanel").then(m => ({ default: m.KnowledgePanel })));
const ReportPanel = lazy(() => import("./components/reports/ReportPanel").then(m => ({ default: m.ReportPanel })));
const TaskPanel = lazy(() => import("./components/tasks/TaskPanel").then(m => ({ default: m.TaskPanel })));

function LoadingFallback() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
      <Spinner size="md" />
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withSuspense(Component: React.LazyExoticComponent<React.ComponentType<any>>) {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <Component />
    </Suspense>
  );
}

export const router = createHashRouter([
  { path: "/chat", element: withSuspense(ChatWindow) },
  { path: "/knowledge/:kbId", element: withSuspense(KnowledgePanel) },
  { path: "/knowledge/:kbId/search", element: withSuspense(KnowledgePanel) },
  { path: "/knowledge", element: <Navigate to="/chat" replace /> },
  { path: "/reports", element: withSuspense(ReportPanel) },
  { path: "/reports/:reportId", element: withSuspense(ReportPanel) },
  { path: "/tasks", element: withSuspense(TaskPanel) },
  { path: "/sessions/:sessionId", element: withSuspense(ChatWindow) },
  { path: "/", element: <Navigate to="/chat" replace /> },
  { path: "*", element: <Navigate to="/chat" replace /> },
]);
