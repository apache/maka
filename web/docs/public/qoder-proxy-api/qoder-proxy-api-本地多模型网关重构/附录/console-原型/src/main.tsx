import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";
import "./styles.css";
import { App } from "./App";
import { AgentPage } from "./pages/AgentPage";
import { RoutingPage } from "./pages/RoutingPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { UsagePage } from "./pages/UsagePage";
import { SettingsPage } from "./pages/SettingsPage";

// Hash 路由：网关把 /ui 当静态目录托管时不需要服务端回退规则。
const router = createHashRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <AgentPage /> },
      { path: "agents", element: <AgentPage /> },
      { path: "providers", element: <ProvidersPage /> },
      { path: "routing", element: <RoutingPage /> },
      { path: "usage", element: <UsagePage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
