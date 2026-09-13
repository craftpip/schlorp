import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueueProvider } from "./store/QueueContext.jsx";
import { PlaylistsProvider } from "./store/PlaylistsContext.jsx";
import App from "./App.jsx";
import Dashboard from "./views/Dashboard.jsx";
import Media from "./views/Media.jsx";
import Profiles from "./views/Profiles.jsx";
import Saved from "./views/Saved.jsx";
import Settings from "./views/Settings.jsx";
import "./styles.css";

if (typeof window !== "undefined" && "scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <QueueProvider>
        <PlaylistsProvider>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="media" element={<Media />} />
            <Route path="collections" element={<Saved />} />
            <Route path="profiles" element={<Profiles />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Dashboard />} />
          </Route>
        </Routes>
        </PlaylistsProvider>
      </QueueProvider>
    </BrowserRouter>
  </StrictMode>
);
