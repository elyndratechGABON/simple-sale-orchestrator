import { useCallback, useEffect, useState } from "react";
import { AuthError, clearToken, getToken, getScope, getProjectName, login as apiLogin, fetchPublicProjects, subscribeStatus, type RequestCreatedEvent, type LiveEvent } from "./api";
import { Layout, type Page } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Clients } from "./pages/Clients";
import { ClientDetail } from "./pages/ClientDetail";
import { Boutiques } from "./pages/Boutiques";
import { BoutiqueDetail } from "./pages/BoutiqueDetail";
import { Abonnements } from "./pages/Abonnements";
import { Paiements } from "./pages/Paiements";
import { Appareils } from "./pages/Appareils";
import { Synchronisation } from "./pages/Synchronisation";
import { Activite } from "./pages/Activite";
import { Audit } from "./pages/Audit";
import { StoreIcon } from "./icons";

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [project, setProject] = useState("");
  const [known, setKnown] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchPublicProjects().then((r) => setKnown(r.projects)).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await apiLogin(password, project.trim() || undefined);
      onLogin();
    } catch (err) {
      setError(err instanceof AuthError ? "Connexion requise." : "Projet ou mot de passe incorrect.");
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <span className="logo">
            <StoreIcon size={18} />
          </span>
          <h1>ELYNDRA CONTROL CENTER</h1>
        </div>
        <p className="lead">Console marchand \u2014 abonnements, comptes et \u00e9crans de caisse.</p>
        <label htmlFor="login-project">Projet (vide = administrateur)</label>
        <input
          id="login-project"
          list="known-projects"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          placeholder="Caisse, resto-yaounde\u2026"
          autoFocus
          autoComplete="off"
        />
        <datalist id="known-projects">
          {known.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </datalist>
        <label htmlFor="login-password">Mot de passe</label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
        />
        <button className="btn btn-primary" type="submit" disabled={!password}>
          Se connecter
        </button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}

function App() {
  const [token, setToken] = useState<string | null>(() => getToken() || null);
  const [page, setPage] = useState<Page>("dashboard");
  const [selectedId, setSelectedId] = useState<string | number | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem("orch_dark") === "1");
  const [requestAlert, setRequestAlert] = useState<RequestCreatedEvent | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  const scope = getScope();
  const projectName = getProjectName();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "auto");
    localStorage.setItem("orch_dark", dark ? "1" : "0");
  }, [dark]);

  useEffect(() => {
    if (!token) return;
    let timer = 0;
    const unsub = subscribeStatus((evt: LiveEvent) => {
      if (evt.type === "request_created") {
        setRequestAlert(evt);
        setPendingCount((n) => n + 1);
        clearTimeout(timer);
        timer = window.setTimeout(() => setRequestAlert(null), 15_000);
      }
    });
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [token]);

  useEffect(() => {
    const onExpired = () => setToken(null);
    window.addEventListener("orch:session-expired", onExpired);
    return () => window.removeEventListener("orch:session-expired", onExpired);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setToken(null);
  }, []);

  if (!token) return <Login onLogin={() => setToken(getToken())} />;

  const navigateToDetail = (id: number, detailPage: Page) => {
    setSelectedId(id);
    setPage(detailPage);
  };

  const handleBack = (listPage: Page) => {
    setSelectedId(null);
    setPage(listPage);
  };

  return (
    <Layout
      page={page}
      scope={scope}
      projectName={projectName}
      pendingCount={pendingCount}
      dark={dark}
      onNavigate={(p) => {
        if (p !== "client" && p !== "boutique") setSelectedId(null);
        setPage(p);
      }}
      onLogout={logout}
      onToggleDark={() => setDark((d) => !d)}
    >
      {requestAlert && (
        <div className="alert-banner new-account">
          <span>
            Nouvelle demande d'abonnement : <strong>{requestAlert.store_name}</strong> \u2014{" "}
            {requestAlert.plan_price.toLocaleString("fr-FR")} F ({requestAlert.plan_devices} appareils)
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { setPage("abonnements"); setRequestAlert(null); }}
            style={{ marginLeft: "auto" }}
          >
            Voir
          </button>
        </div>
      )}

      {page === "dashboard" && <Dashboard />}
      {page === "clients" && <Clients onSelect={(id) => navigateToDetail(id, "client")} />}
      {page === "client" && selectedId != null && (
        <ClientDetail id={selectedId as number} onBack={() => handleBack("clients")} />
      )}
      {page === "boutiques" && <Boutiques onSelect={(deviceId) => { setSelectedId(deviceId); setPage("boutique"); }} />}
      {page === "boutique" && selectedId != null && (
        <BoutiqueDetail deviceId={selectedId as string} onBack={() => handleBack("boutiques")} />
      )}
      {page === "abonnements" && <Abonnements />}
      {page === "paiements" && <Paiements />}
      {page === "appareils" && <Appareils />}
      {page === "sync" && <Synchronisation />}
      {page === "activite" && <Activite />}
      {page === "audit" && scope === "master" && <Audit />}
    </Layout>
  );
}

export default App;
