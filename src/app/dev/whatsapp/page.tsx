"use client";

/**
 * /dev/whatsapp — WhatsApp simulator UI (development only)
 *
 * Lets you act as trader or recycler:
 *  - Send a text message (inbound)
 *  - Press reply buttons / list selections
 *  - "Upload" an image (simulates image inbound)
 *  - Trigger status updates (delivered/read/failed)
 *  - Toggle provider outage
 *  - Open/close the 24-hour service window
 *  - Reset the fake store
 */

import { useState, useCallback, useEffect } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SentMessage {
  id: string;
  to: string;
  type: string;
  content: unknown;
  sentAt: string;
}

interface StatusEvent {
  messageId: string;
  to: string;
  status: string;
  timestamp: string;
}

interface InboundEvent {
  id: string;
  from: string;
  type: string;
  content: unknown;
  timestamp: string;
}

interface StoreState {
  sentMessages: SentMessage[];
  statusEvents: StatusEvent[];
  inboundQueue: InboundEvent[];
  conversationWindows: Record<string, string>;
  outageMode: boolean;
}

const TRADER_PHONE = "+919900000001";
const RECYCLER_PHONE = "+919900000002";

// ─── Component ────────────────────────────────────────────────────────────────

export default function DevWhatsAppPage() {
  const [role, setRole] = useState<"trader" | "recycler">("trader");
  const [text, setText] = useState("");
  const [statusMsgId, setStatusMsgId] = useState("");
  const [statusType, setStatusType] = useState<"delivered" | "read" | "failed">("delivered");
  const [store, setStore] = useState<StoreState | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const phone = role === "trader" ? TRADER_PHONE : RECYCLER_PHONE;

  const addLog = (msg: string) => setLog((l) => [`[${new Date().toISOString()}] ${msg}`, ...l.slice(0, 49)]);

  const refreshStore = useCallback(async () => {
    try {
      const res = await fetch("/api/dev/whatsapp");
      if (res.ok) setStore(await res.json());
    } catch (e) {
      addLog(`Error fetching state: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    refreshStore();
    const interval = setInterval(refreshStore, 2000);
    return () => clearInterval(interval);
  }, [refreshStore]);

  async function call(body: object) {
    setLoading(true);
    try {
      const res = await fetch("/api/dev/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      addLog(`${JSON.stringify(body)} → ${JSON.stringify(data)}`);
      await refreshStore();
    } catch (e) {
      addLog(`Error: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  const sendText = () => {
    if (!text.trim()) return;
    call({ action: "send_inbound", from: phone, type: "text", text: text.trim() });
    setText("");
  };

  const sendImage = () => call({ action: "send_inbound", from: phone, type: "image", imageCaption: "Test image upload" });

  const sendButtonReply = () =>
    call({ action: "send_inbound", from: phone, type: "button_reply", buttonId: "btn_yes", buttonTitle: "Yes, proceed" });

  const sendListReply = () =>
    call({ action: "send_inbound", from: phone, type: "list_reply", listRowId: "row_1", listRowTitle: "Option A" });

  const triggerStatus = () => {
    if (!statusMsgId.trim()) return;
    call({ action: "send_status", messageId: statusMsgId.trim(), recipientPhone: phone, status: statusType });
  };

  const openWindow = () => call({ action: "set_service_window", phone, timestamp: new Date().toISOString() });

  const closeWindow = () => call({ action: "set_service_window", phone, timestamp: null });

  const toggleOutage = () => call({ action: "set_outage", active: !store?.outageMode });

  const setDuplicateNext = () => call({ action: "set_duplicate_next" });

  const reset = () => call({ action: "reset" });

  const windowOpen = store ? !!store.conversationWindows[phone] : false;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6 font-mono text-sm">
      <h1 className="text-2xl font-bold mb-1">📱 WhatsApp Dev Simulator</h1>
      <p className="text-gray-400 mb-6">Development only — uses FakeProvider</p>

      {/* Role selector */}
      <div className="mb-6 flex gap-3 items-center">
        <span className="text-gray-400">Acting as:</span>
        <button
          onClick={() => setRole("trader")}
          className={`px-4 py-2 rounded ${role === "trader" ? "bg-green-600" : "bg-gray-700 hover:bg-gray-600"}`}
        >
          🏭 Trader ({TRADER_PHONE})
        </button>
        <button
          onClick={() => setRole("recycler")}
          className={`px-4 py-2 rounded ${role === "recycler" ? "bg-blue-600" : "bg-gray-700 hover:bg-gray-600"}`}
        >
          ♻️ Recycler ({RECYCLER_PHONE})
        </button>
        <span className={`ml-4 px-2 py-1 rounded text-xs ${windowOpen ? "bg-green-800 text-green-200" : "bg-red-900 text-red-200"}`}>
          24h window: {windowOpen ? "OPEN" : "CLOSED"}
        </span>
        {store?.outageMode && (
          <span className="px-2 py-1 rounded text-xs bg-yellow-800 text-yellow-200">⚠️ OUTAGE MODE</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Send actions */}
        <div className="space-y-4">
          {/* Send text */}
          <div className="bg-gray-900 rounded-lg p-4">
            <h2 className="font-semibold mb-3">Send Inbound Message</h2>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendText()}
                placeholder="Type a message..."
                className="flex-1 bg-gray-800 rounded px-3 py-2 outline-none focus:ring-1 focus:ring-green-500"
              />
              <button
                onClick={sendText}
                disabled={loading}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded disabled:opacity-50"
              >
                Send
              </button>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button onClick={sendImage} disabled={loading} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50">
                📷 Image
              </button>
              <button onClick={sendButtonReply} disabled={loading} className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 rounded disabled:opacity-50">
                🔘 Button Reply
              </button>
              <button onClick={sendListReply} disabled={loading} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded disabled:opacity-50">
                📋 List Reply
              </button>
            </div>
          </div>

          {/* Status updates */}
          <div className="bg-gray-900 rounded-lg p-4">
            <h2 className="font-semibold mb-3">Trigger Status Update</h2>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={statusMsgId}
                onChange={(e) => setStatusMsgId(e.target.value)}
                placeholder="wamid.fake..."
                className="flex-1 bg-gray-800 rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
              />
              <select
                value={statusType}
                onChange={(e) => setStatusType(e.target.value as typeof statusType)}
                className="bg-gray-800 rounded px-3 py-2"
              >
                <option value="delivered">Delivered</option>
                <option value="read">Read</option>
                <option value="failed">Failed</option>
              </select>
              <button onClick={triggerStatus} disabled={loading} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50">
                Trigger
              </button>
            </div>
            {store?.sentMessages.length ? (
              <p className="text-xs text-gray-500">Last sent id: {store.sentMessages.at(-1)?.id}</p>
            ) : null}
          </div>

          {/* Controls */}
          <div className="bg-gray-900 rounded-lg p-4">
            <h2 className="font-semibold mb-3">Controls</h2>
            <div className="flex gap-2 flex-wrap">
              <button onClick={openWindow} disabled={loading} className="px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded disabled:opacity-50">
                Open 24h Window
              </button>
              <button onClick={closeWindow} disabled={loading} className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded disabled:opacity-50">
                Close Window
              </button>
              <button onClick={toggleOutage} disabled={loading} className={`px-3 py-1.5 rounded disabled:opacity-50 ${store?.outageMode ? "bg-yellow-600 hover:bg-yellow-500" : "bg-gray-600 hover:bg-gray-500"}`}>
                {store?.outageMode ? "Disable Outage" : "Simulate Outage"}
              </button>
              <button onClick={setDuplicateNext} disabled={loading} className="px-3 py-1.5 bg-orange-700 hover:bg-orange-600 rounded disabled:opacity-50">
                Duplicate Next Event
              </button>
              <button onClick={reset} disabled={loading} className="px-3 py-1.5 bg-red-900 hover:bg-red-800 rounded disabled:opacity-50">
                Reset Store
              </button>
            </div>
          </div>
        </div>

        {/* Right: State + log */}
        <div className="space-y-4">
          {/* Sent messages */}
          <div className="bg-gray-900 rounded-lg p-4">
            <h2 className="font-semibold mb-2">Outbound Messages ({store?.sentMessages.length ?? 0})</h2>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {store?.sentMessages.slice().reverse().map((m) => (
                <div key={m.id} className="text-xs bg-gray-800 rounded px-2 py-1">
                  <span className="text-green-400">{m.id}</span> → {m.to} [{m.type}]
                </div>
              ))}
              {!store?.sentMessages.length && <p className="text-gray-600 text-xs">No outbound messages yet</p>}
            </div>
          </div>

          {/* Inbound messages */}
          <div className="bg-gray-900 rounded-lg p-4">
            <h2 className="font-semibold mb-2">Inbound Events ({store?.inboundQueue.length ?? 0})</h2>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {store?.inboundQueue.slice().reverse().map((m, i) => (
                <div key={`${m.id}-${i}`} className="text-xs bg-gray-800 rounded px-2 py-1">
                  <span className="text-blue-400">{m.from}</span> [{m.type}] {new Date(m.timestamp).toLocaleTimeString()}
                </div>
              ))}
              {!store?.inboundQueue.length && <p className="text-gray-600 text-xs">No inbound events yet</p>}
            </div>
          </div>

          {/* Activity log */}
          <div className="bg-gray-900 rounded-lg p-4">
            <h2 className="font-semibold mb-2">Activity Log</h2>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {log.map((entry, i) => (
                <div key={i} className="text-xs text-gray-400 break-all">{entry}</div>
              ))}
              {!log.length && <p className="text-gray-600 text-xs">No activity yet</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
