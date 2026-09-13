import Link from "next/link";
import { db } from "../../db/client.js";
import { listDigests } from "../../lib/queries.js";
import { excerpt, formatStamp } from "../../lib/format.js";

export const dynamic = "force-dynamic";

export default async function DigestsPage() {
  const digests = await listDigests(db());

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Digests</h1>
          <p className="muted">
            draft -&gt; approved -&gt; rendering -&gt; ready. Approval is the
            gate that protects the render quota.
          </p>
        </div>
      </div>

      <section className="card">
        {digests.length === 0 ? (
          <p className="muted">
            Nothing yet. Open a <Link href="/topics">topic</Link> and build a
            draft.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Topic</th>
                <th>Status</th>
                <th>Items</th>
                <th>Summary</th>
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
                  <td className="muted">
                    {digest.status === "failed"
                      ? digest.error
                      : (excerpt(digest.summary, 90) ?? "-")}
                  </td>
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
    </>
  );
}
