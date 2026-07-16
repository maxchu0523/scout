import type { Service } from "@scout/types";

/** Slide-in panel showing everything Scout verified about one service. */
export function DetailDrawer({
  service,
  onClose,
}: {
  service: Service;
  onClose: () => void;
}) {
  return (
    <>
      {/** biome-ignore lint/a11y/noStaticElementInteractions: click-away scrim */}
      {/** biome-ignore lint/a11y/useKeyWithClickEvents: click-away scrim */}
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <button type="button" className="drawer-close" onClick={onClose}>
          ✕
        </button>
        <h2>{service.name}</h2>
        <div className="mono muted">{service.url}</div>
        <div className="badges">
          <span className={`status status-${service.status}`}>
            {service.status}
          </span>
          {service.kind === "mcp" && <span className="chip">{service.transport}</span>}
          {service.kind === "llm-api" && <span className="chip">{service.api}</span>}
        </div>

        {service.kind === "mcp" && (
          <>
            {service.serverInfo && (
              <p className="muted">
                {service.serverInfo.name} v{service.serverInfo.version}
                {service.protocolVersion ? ` · MCP ${service.protocolVersion}` : ""}
              </p>
            )}
            <h3>Tools ({service.tools.length})</h3>
            <ul className="detail-list">
              {service.tools.map((t) => (
                <li key={t.name}>
                  <span className="mono">{t.name}</span>
                  {t.annotations?.readOnlyHint && (
                    <span className="tag tag-ro">read-only</span>
                  )}
                  {t.annotations?.destructiveHint && (
                    <span className="tag tag-danger">destructive</span>
                  )}
                  {t.description && <div className="muted small">{t.description}</div>}
                </li>
              ))}
            </ul>
          </>
        )}

        {service.kind === "llm-api" && (
          <>
            <h3>Models ({service.models.length})</h3>
            <ul className="detail-list">
              {service.models.map((m) => {
                const info = service.modelInfo?.find((i) => i.id === m);
                return (
                  <li key={m}>
                    <span className="mono">{m}</span>
                    {info?.state === "loaded" && (
                      <span className="tag tag-ro">loaded</span>
                    )}
                    {info && (
                      <div className="muted small">
                        {[
                          info.family,
                          info.parameterSize,
                          info.quantization,
                          info.contextLength ? `${info.contextLength} ctx` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {service.kind === "openapi" && (
          <>
            {service.description && <p className="muted">{service.description}</p>}
            <h3>Operations ({service.operationCount})</h3>
            <ul className="detail-list">
              {service.operations.map((op) => (
                <li key={op} className="mono small">
                  {op}
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </>
  );
}
