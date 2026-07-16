import { useCallback, useRef, useState } from "react";
import type { ScanEvent, ScanResult, Service } from "@scout/types";

export interface ScanState {
  services: Service[];
  scanning: boolean;
  caption: string;
  error: string | null;
}

export interface ScanParams {
  host: string;
  ports: string;
  openapi: boolean;
}

/**
 * Drives a scan over the server's SSE endpoint. `verified` events stream cards
 * in live; `done` replaces state with the canonical ScanResult. Closes the
 * EventSource on completion so the browser does not auto-reconnect (which would
 * restart the scan).
 */
export function useScan(): ScanState & { scan: (p: ScanParams) => void } {
  const [state, setState] = useState<ScanState>({
    services: [],
    scanning: false,
    caption: "idle",
    error: null,
  });
  const esRef = useRef<EventSource | null>(null);

  const scan = useCallback((p: ScanParams) => {
    esRef.current?.close();
    setState({ services: [], scanning: true, caption: "starting…", error: null });

    const qs = new URLSearchParams({
      host: p.host || "127.0.0.1",
      openapi: p.openapi ? "1" : "0",
    });
    if (p.ports.trim()) qs.set("ports", p.ports.trim());

    const es = new EventSource(`/api/scan?${qs.toString()}`);
    esRef.current = es;

    const on = (type: string, fn: (e: ScanEvent) => void) =>
      es.addEventListener(type, (ev) =>
        fn(JSON.parse((ev as MessageEvent).data) as ScanEvent),
      );

    on("phase", (e) => {
      if (e.type === "phase") {
        setState((s) => ({ ...s, caption: e.message }));
      }
    });
    on("port-open", (e) => {
      if (e.type === "port-open") {
        setState((s) => ({
          ...s,
          caption: `${e.host}:${e.port} open · ${e.openCount} found`,
        }));
      }
    });
    on("verified", (e) => {
      if (e.type === "verified") {
        setState((s) => ({ ...s, services: [...s.services, e.service] }));
      }
    });
    on("done", (e) => {
      if (e.type === "done") {
        const result = e.result as ScanResult;
        setState({
          services: result.services,
          scanning: false,
          caption: `${result.services.length} services · ${result.scanned.openPorts} open ports`,
          error: null,
        });
      }
      es.close();
    });
    es.addEventListener("error", () => {
      // Either a 409 (scan in progress) or a network drop. Stop cleanly.
      setState((s) => ({
        ...s,
        scanning: false,
        caption: s.scanning ? "scan interrupted" : s.caption,
      }));
      es.close();
    });
  }, []);

  return { ...state, scan };
}
