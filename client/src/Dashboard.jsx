import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import { api } from "./api.js";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: "#0070e0",
  fontFamily: "inherit",
  fontSize: 13,
  headerBackgroundColor: "#f5f7fb",
  headerFontWeight: 700,
  borderRadius: 10,
  wrapperBorderRadius: 12,
  rowHoverColor: "#f2f7ff",
  spacing: 6,
});

const usd = (v) => (v == null || v === "" ? "" : `$${Number(v).toFixed(2)}`);
const when = (v) => (v ? new Date(v).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

const Chip = ({ value }) => (value ? <span className={`chip chip-${String(value).toLowerCase()}`}>{String(value).replace(/_/g, " ")}</span> : null);
const TYPE_ICON = { purchase: "🛍️", refund: "↩️", blocked: "⛔", watch: "👀", rules: "📏", connect: "🔗", revoke: "🔒", error: "⚠️" };

function Kpi({ label, value, sub, tone }) {
  return (
    <div className={`kpi ${tone || ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export default function Dashboard({ demoPrices, onError }) {
  const [data, setData] = useState(null);
  const [limits, setLimits] = useState({ per: "", month: "" });
  const [search, setSearch] = useState("");
  const ordersRef = useRef(null);
  const activityRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api.dashboard();
      setData(d);
      setLimits((l) => (l.per === "" ? { per: d.kpis.perOrderLimit, month: d.kpis.monthlyLimit } : l));
    } catch (e) {
      onError(e.message);
    }
  }, [onError]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const act = useCallback(
    async (fn) => {
      try {
        await fn();
        await load();
      } catch (e) {
        onError(e.message);
      }
    },
    [load, onError]
  );

  // ---------- Column definitions ----------
  const watchCols = useMemo(
    () => [
      { field: "title", headerName: "Product", flex: 2, minWidth: 200 },
      { field: "qty", headerName: "Qty", width: 80, type: "numericColumn" },
      { field: "targetPrice", headerName: "Target ≤", width: 110, valueFormatter: (p) => usd(p.value), type: "numericColumn" },
      { field: "lastPrice", headerName: "Current", width: 110, valueFormatter: (p) => usd(p.value), type: "numericColumn" },
      {
        headerName: "Gap to target",
        width: 140,
        valueGetter: (p) => (p.data.lastPrice ? ((p.data.lastPrice - p.data.targetPrice) / p.data.lastPrice) * 100 : null),
        valueFormatter: (p) => (p.value == null ? "" : p.value <= 0 ? "✅ hit" : `${p.value.toFixed(1)}% above`),
        cellClass: (p) => (p.value != null && p.value <= 0 ? "cell-ok" : ""),
        type: "numericColumn",
      },
      { field: "status", width: 120, cellRenderer: Chip, filter: "agTextColumnFilter" },
      { field: "note", headerName: "Note", flex: 1, minWidth: 140, tooltipField: "note" },
      {
        headerName: "",
        width: 230,
        sortable: false,
        filter: false,
        cellRenderer: (p) =>
          p.data.status === "watching" ? (
            <div className="cell-actions">
              {demoPrices && (
                <button className="small ghost" onClick={() => act(() => api.demoPrice(p.data.productId, Math.max(0.5, p.data.targetPrice - 1)))}>
                  🧪 Simulate drop
                </button>
              )}
              <button className="small ghost" onClick={() => act(() => api.cancelWatch(p.data.id))}>
                Stop
              </button>
            </div>
          ) : null,
      },
    ],
    [act, demoPrices]
  );

  const orderCols = useMemo(
    () => [
      { field: "createdAt", headerName: "Date", width: 150, valueFormatter: (p) => when(p.value), sort: "desc" },
      { field: "orderId", headerName: "PayPal order", width: 190, cellClass: "mono" },
      {
        field: "source",
        width: 130,
        valueFormatter: (p) => (p.value === "autopilot" ? "🤖 Autopilot" : "💬 Chat"),
        filter: "agTextColumnFilter",
      },
      { field: "items", flex: 2, minWidth: 220, tooltipField: "items" },
      { field: "total", width: 110, valueFormatter: (p) => usd(p.value), type: "numericColumn" },
      { field: "refunded", width: 110, valueFormatter: (p) => (p.value ? usd(p.value) : "—"), type: "numericColumn" },
      { field: "status", width: 170, cellRenderer: Chip },
    ],
    []
  );

  const activityCols = useMemo(
    () => [
      { field: "at", headerName: "Time", width: 150, valueFormatter: (p) => when(p.value), sort: "desc" },
      {
        field: "type",
        width: 130,
        valueFormatter: (p) => `${TYPE_ICON[p.value] || "•"} ${p.value}`,
        filter: "agTextColumnFilter",
      },
      { field: "text", headerName: "Event", flex: 3, minWidth: 260, tooltipField: "text" },
      { field: "amount", width: 110, valueFormatter: (p) => usd(p.value), type: "numericColumn" },
      { field: "orderId", headerName: "Order", width: 180, cellClass: "mono" },
      {
        headerName: "",
        width: 100,
        sortable: false,
        filter: false,
        cellRenderer: (p) =>
          p.data.type === "purchase" ? (
            p.data.undone ? (
              <span className="muted">undone</span>
            ) : (
              <button className="small ghost" onClick={() => act(() => api.undo(p.data.id))}>
                Undo
              </button>
            )
          ) : null,
      },
    ],
    [act]
  );

  const defaultColDef = useMemo(() => ({ sortable: true, filter: true, resizable: true, floatingFilter: false }), []);

  if (!data) return <div className="dash"><p className="muted">Loading dashboard…</p></div>;
  const k = data.kpis;
  const pct = k.monthlyLimit ? Math.min(100, (k.spentThisMonth / k.monthlyLimit) * 100) : 0;

  return (
    <div className="dash">
      <div className="kpis">
        <Kpi
          label="Autopilot spend · this month"
          value={`${usd(k.spentThisMonth)} / ${usd(k.monthlyLimit)}`}
          sub={<div className="meter"><div style={{ width: `${pct}%`, background: pct > 85 ? "#b3261e" : undefined }} /></div>}
        />
        <Kpi label="Autopilot" value={k.connected ? "🟢 ON" : "⚪ OFF"} sub={`${k.activeWatches} active watch${k.activeWatches === 1 ? "" : "es"}`} />
        <Kpi label="Paid orders" value={k.paidOrders} sub={`${usd(k.grossPaid)} gross`} />
        <Kpi label="Autonomous buys" value={k.autopilotBuys} sub={`${k.blocked} blocked by rules`} tone={k.blocked ? "warn" : ""} />
        <Kpi label="Refunded" value={usd(k.refunded)} sub="via Undo / agent" />
      </div>

      <section className="panel rules-editor">
        <h3>📏 Spending rules</h3>
        <p className="muted">Enforced in server code before every Autopilot charge. The agent cannot exceed them.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(() => api.setLimits(Number(limits.per), Number(limits.month)));
          }}
        >
          <label>
            Per order ($)
            <input type="number" min="1" step="1" value={limits.per} onChange={(e) => setLimits({ ...limits, per: e.target.value })} />
          </label>
          <label>
            Per month ($)
            <input type="number" min="1" step="1" value={limits.month} onChange={(e) => setLimits({ ...limits, month: e.target.value })} />
          </label>
          <button>Save rules</button>
          {k.connected && (
            <button type="button" className="ghost" onClick={() => act(api.revoke)}>
              🔒 Revoke PayPal
            </button>
          )}
        </form>
      </section>

      <section className="panel">
        <div className="grid-head">
          <h3>👀 Price watches</h3>
        </div>
        <div className="grid-wrap">
          <AgGridReact
            theme={theme}
            domLayout="autoHeight"
            rowData={data.autopilot.watches}
            columnDefs={watchCols}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.id}
            overlayNoRowsTemplate="No watches yet. Ask the agent: “buy this when it drops under $X”."
            tooltipShowDelay={300}
          />
        </div>
      </section>

      <section className="panel">
        <div className="grid-head">
          <h3>🧾 Orders</h3>
          <input className="search" placeholder="Search orders & activity…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="small ghost" onClick={() => ordersRef.current?.api.exportDataAsCsv({ fileName: "cartpilot-orders.csv" })}>
            Export CSV
          </button>
        </div>
        <div className="grid-wrap">
          <AgGridReact
            ref={ordersRef}
            theme={theme}
            domLayout="autoHeight"
            rowData={data.orders}
            columnDefs={orderCols}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.orderId}
            quickFilterText={search}
            pagination
            paginationPageSize={10}
            paginationPageSizeSelector={[10, 25, 50]}
            overlayNoRowsTemplate="No orders yet."
            tooltipShowDelay={300}
          />
        </div>
      </section>

      <section className="panel">
        <div className="grid-head">
          <h3>🤖 Autopilot activity log</h3>
          <button className="small ghost" onClick={() => activityRef.current?.api.exportDataAsCsv({ fileName: "cartpilot-activity.csv" })}>
            Export CSV
          </button>
        </div>
        <div className="grid-wrap">
          <AgGridReact
            ref={activityRef}
            theme={theme}
            domLayout="autoHeight"
            rowData={data.autopilot.activity}
            columnDefs={activityCols}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.id}
            quickFilterText={search}
            rowClassRules={{ "row-undone": (p) => !!p.data?.undone, "row-blocked": (p) => p.data?.type === "blocked" }}
            pagination
            paginationPageSize={10}
            paginationPageSizeSelector={[10, 25, 50]}
            overlayNoRowsTemplate="No activity yet."
            tooltipShowDelay={300}
          />
        </div>
      </section>
    </div>
  );
}
