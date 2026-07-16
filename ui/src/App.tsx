import { useEffect, useMemo, useState } from "react";
import type { Service } from "@scout/types";
import { DetailDrawer } from "./DetailDrawer.js";
import { useScan } from "./useScan.js";
import {
  countChip,
  hostOf,
  kindBadge,
  originKey,
  type Registry,
  type RegistryEntry,
  relativeTime,
} from "./util.js";

const KIND_ORDER: Record<string, number> = { mcp: 0, "llm-api": 1, openapi: 2 };

export function App() {
  const [version, setVersion] = useState("");
  const [registry, setRegistry] = useState<Registry>({ version: 1, entries: [] });
  const [host, setHost] = useState("127.0.0.1");
  const [ports, setPorts] = useState("");
  const [openapi, setOpenapi] = useState(false);
  const [selected, setSelected] = useState<Service | null>(null);

  const { services, scanning, caption, scan } = useScan();

  // Load version + registry, then kick off a default scan once on mount.
  useEffect(() => {
    fetch("/api/version")
      .then((r) => r.json())
      .then((d: { version: string }) => setVersion(d.version))
      .catch(() => {});
    fetch("/api/registry")
      .then((r) => r.json())
      .then((d: Registry) => setRegistry(d))
      .catch(() => {});
    scan({ host: "127.0.0.1", ports: "", openapi: false });
  }, [scan]);

  const liveKeys = useMemo(
    () => new Set(services.map((s) => originKey(s))),
    [services],
  );

  // Group live services + registry ghosts by host.
  const byHost = useMemo(() => {
    const map = new Map<string, { live: Service[]; ghosts: RegistryEntry[] }>();
    const bucket = (h: string) => {
      if (!map.has(h)) map.set(h, { live: [], ghosts: [] });
      return map.get(h) as { live: Service[]; ghosts: RegistryEntry[] };
    };
    for (const s of services) bucket(hostOf(s)).live.push(s);
    for (const e of registry.entries) {
      if (liveKeys.has(e.id)) continue; // shown live already
      const h = e.transport === "stdio" ? "local (stdio)" : hostForEntry(e.url);
      bucket(h).ghosts.push(e);
    }
    for (const v of map.values()) {
      v.live.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [services, registry, liveKeys]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          scout <span className="muted small">v{version}</span>
        </div>
        <div className="controls">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="host / CIDR"
            aria-label="host"
          />
          <input
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
            placeholder="default ports"
            aria-label="ports"
          />
          <label className="check">
            <input
              type="checkbox"
              checked={openapi}
              onChange={(e) => setOpenapi(e.target.checked)}
            />
            OpenAPI
          </label>
          <button
            type="button"
            disabled={scanning}
            onClick={() => scan({ host, ports, openapi })}
          >
            {scanning ? "Scanning…" : "Scan"}
          </button>
        </div>
        <div className="caption muted">{caption}</div>
      </header>

      <main className="grid">
        {byHost.length === 0 && !scanning && (
          <p className="muted">No services found.</p>
        )}
        {byHost.map(([h, { live, ghosts }]) => (
          <section key={h} className="host-card">
            <h2 className="host-name">{h}</h2>
            {live.map((s) => (
              <button
                type="button"
                key={originKey(s)}
                className="service-row"
                onClick={() => setSelected(s)}
              >
                <span className={`badge badge-${s.kind}`}>{kindBadge(s)}</span>
                <span className="service-name">{s.name}</span>
                <span className={`dot dot-${s.status}`} title={s.status} />
                <span className="chip">{countChip(s)}</span>
                {s.status === "available" && (
                  <span className="muted small">{s.latencyMs}ms</span>
                )}
              </button>
            ))}
            {ghosts.map((e) => (
              <div key={e.id} className="service-row ghost" title="from registry">
                <span className="badge badge-ghost">{e.kind === "mcp" ? "MCP" : "LLM"}</span>
                <span className="service-name">{e.name}</span>
                <span className="muted small">last seen {relativeTime(e.lastSeenAt)}</span>
              </div>
            ))}
          </section>
        ))}
      </main>

      {selected && (
        <DetailDrawer service={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function hostForEntry(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
