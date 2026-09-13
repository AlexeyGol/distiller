import Link from "next/link";
import { db } from "../db/client.js";
import {
  dashboardStats,
  listDigests,
  listSourceRuns,
} from "../lib/queries.js";
import { formatStamp } from "../lib/format.js";

// Every page here reads the database per request; prerendering at build time
// would need a live Postgres during `next build`, which is not a thing.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const database = db();
  const [stats, digests, runs] = await Promise.all([
    dashboardStats(database),
    listDigests(database, 8),
    listSourceRuns(database),
  ]);

  const failing = runs.filter((run) => run.lastError);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Everything Distiller is currently watching.</p>
        </div>
        <Link href="/topics" className="btn primary">
          New topic
        </Link>
      </div>

      <div className="grid">
        <Stat n={stats.topics} k="Topics" href="/topics" />
        <Stat n={stats.sources} k="Sources" href="/sources" />
        <Stat n={stats.items} k="Items ingested" />
        <Stat n={stats.digests} k="Digests" href="/digests" />
      </div>

      <section className="card" style={{ marginTop: 18 }}>
        <h2>Recent digests</h2>
        {digests.length === 0 ? (
          <p className="muted">
            No digests yet. Open a topic and press &quot;Build draft now&quot;.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Topic</th>
                <th>Status</th>
                <th>Items</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {digests.map((digest) => (
                <tr key={digest.id}>
                  <td>{digest.topicName}</td>
                  <td>
                    <span className={`badge ${digest.status}`}>
                      {digest.status}
                    </span>
                  </td>
                  <td>{digest.itemCount}</td>
                  <td className="muted">{formatStamp(digest.createdAt)}</td>
                  <td>
                    <Link href={`/digests/${digest.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Runs</h2>
        <p className="muted" style={{ marginTop: -8 }}>
          Why nothing showed up this morning: last poll and last error per
          source.
          {failing.length > 0 ? ` ${failing.length} source(s) failing.` : ""}
        </p>
        {runs.length === 0 ? (
          <p className="muted">
            No sources yet. <Link href="/sources">Add one</Link>.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Type</th>
                <th>Items</th>
                <th>Last polled</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    {run.label}
                    {run.enabled ? null : (
                      <span className="badge" style={{ marginLeft: 8 }}>
                        disabled
                      </span>
                    )}
                  </td>
                  <td className="mono">{run.pluginId}</td>
                  <td>{run.itemCount}</td>
                  <td className="muted">{formatStamp(run.lastPolledAt)}</td>
                  <td className={run.lastError ? "err-msg" : "muted"}>
                    {run.lastError ?? "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Stat({ n, k, href }: { n: number; k: string; href?: string }) {
  const body = (
    <div className="stat">
      <div className="n">{n}</div>
      <div className="k">{k}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}
