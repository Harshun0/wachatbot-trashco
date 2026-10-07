import Link from "next/link";

export default function Home() {
  const isDev = process.env.NODE_ENV !== "production";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center justify-center p-8 font-sans">
      {/* Header */}
      <div className="mb-12 text-center">
        <div className="text-5xl mb-4">📱</div>
        <h1 className="text-4xl font-bold tracking-tight mb-2">wacrm</h1>
        <p className="text-gray-400 text-lg">WhatsApp CRM for Scrap &amp; Recycling</p>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12 w-full max-w-2xl">
        <StatusCard
          label="Webhook"
          endpoint="POST /api/webhooks/whatsapp"
          description="Receives Meta events"
        />
        <StatusCard
          label="Send"
          endpoint="POST /api/messages/send"
          description="Enqueues outbound messages"
        />
        <StatusCard
          label="Worker"
          endpoint="npm run worker"
          description="BullMQ job processor"
        />
      </div>

      {/* Links */}
      <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
        {isDev && (
          <Link
            href="/dev/whatsapp"
            className="flex-1 flex items-center justify-center gap-2 bg-green-700 hover:bg-green-600 transition-colors rounded-xl px-6 py-4 font-semibold text-center"
          >
            <span>🧪</span> WhatsApp Simulator
          </Link>
        )}
        <a
          href="https://developers.facebook.com/apps"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-2 bg-blue-700 hover:bg-blue-600 transition-colors rounded-xl px-6 py-4 font-semibold text-center"
        >
          <span>⚙️</span> Meta Dashboard
        </a>
      </div>

      {/* Quick-reference */}
      <div className="mt-12 w-full max-w-2xl">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-4">
          Quick reference
        </h2>
        <div className="bg-gray-900 rounded-xl divide-y divide-gray-800 text-sm font-mono">
          <Row label="Webhook URL" value="/api/webhooks/whatsapp" />
          <Row label="Verify token" value="WA_VERIFY_TOKEN in .env" />
          <Row label="Provider" value={process.env.WA_PROVIDER ?? "not set"} highlight />
          <Row label="Phone number ID" value={process.env.WA_PHONE_NUMBER_ID ?? "not set"} />
          <Row label="Graph API" value={process.env.WA_GRAPH_VERSION ?? "v21.0"} />
        </div>
      </div>

      <p className="mt-10 text-xs text-gray-600">
        {isDev ? "Development mode" : "Production"} · Next.js App Router
      </p>
    </div>
  );
}

function StatusCard({
  label,
  endpoint,
  description,
}: {
  label: string;
  endpoint: string;
  description: string;
}) {
  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
        <span className="font-semibold text-sm">{label}</span>
      </div>
      <p className="text-xs font-mono text-gray-400 mb-1 break-all">{endpoint}</p>
      <p className="text-xs text-gray-600">{description}</p>
    </div>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 gap-4">
      <span className="text-gray-500 shrink-0">{label}</span>
      <span
        className={`truncate text-right ${
          highlight ? "text-green-400 font-semibold" : "text-gray-300"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
