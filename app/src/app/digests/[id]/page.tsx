import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "../../../db/client.js";
import { getDigestDetail } from "../../../lib/queries.js";
import { excerpt, formatBytes, formatStamp } from "../../../lib/format.js";
import { ActionForm } from "../../../components/ActionForm.js";
import { CurationList } from "../../../components/CurationList.js";
import { PlayButton } from "../../../components/Player.js";
import {
  approveDigestAction,
  deliverDigestAction,
  renderDigestAction,
  saveSelectionAction,
} from "../../actions.js";

export const dynamic = "force-dynamic";

export default async function DigestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getDigestDetail(db(), id);
  if (!detail) notFound();

  const { digest, topicName, items, artifacts, deliveries } = detail;
  const audio = artifacts.filter((a) => a.kind === "audio");
  const texts = artifacts.filter((a) => a.kind !== "audio");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{topicName}</h1>
          <p className="muted">
            <span className={`badge ${digest.status}`}>{digest.status}</span>{" "}
            created {formatStamp(digest.createdAt)}
            {digest.renderedAt
              ? ` - rendered ${formatStamp(digest.renderedAt)}`
              : ""}
          </p>
          <p className="muted mono">{digest.jobKey}</p>
        </div>
        <Link href={`/topics/${digest.topicId}`} className="btn plain">
          Topic settings
        </Link>
      </div>

      {digest.error ? (
        <section className="card">
          <h3>Error</h3>
          <p className="err-msg">{digest.error}</p>
        </section>
      ) : null}

      <section className="card">
        <h2>Curation</h2>
        <CurationList
          digestId={digest.id}
          editable={digest.status === "draft"}
          saveAction={saveSelectionAction}
          approveAction={approveDigestAction}
          items={items.map((item) => ({
            id: item.id,
            title: item.title,
            url: item.url,
            published: formatStamp(item.publishedAt),
            sourceLabel: item.sourceLabel,
            included: item.included,
            excerpt: excerpt(item.body),
          }))}
        />
      </section>

      <section className="card">
        <h2>Render and deliver</h2>
        <div className="row" style={{ alignItems: "flex-start", gap: 24 }}>
          <ActionForm
            action={renderDigestAction}
            submitLabel="Render"
            variant={digest.status === "approved" ? "primary" : "plain"}
          >
            <input type="hidden" name="digestId" value={digest.id} />
          </ActionForm>
          <ActionForm
            action={deliverDigestAction}
            submitLabel="Deliver"
            variant={digest.status === "ready" ? "primary" : "plain"}
          >
            <input type="hidden" name="digestId" value={digest.id} />
          </ActionForm>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Render needs status &quot;approved&quot;; deliver needs
          &quot;ready&quot;. Both report what the pipeline decided rather than
          guessing here.
        </p>
      </section>

      {digest.summary ? (
        <section className="card">
          <h2>Summary</h2>
          <pre className="summary">{digest.summary}</pre>
        </section>
      ) : null}

      {artifacts.length > 0 ? (
        <section className="card">
          <h2>Artifacts</h2>
          {audio.length > 0 ? (
            <ul className="items">
              {audio.map((artifact) => (
                <li key={artifact.id}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span>
                      <strong>audio</strong>{" "}
                      <span className="mono muted">{artifact.mime}</span>{" "}
                      <span className="muted">{formatBytes(artifact.bytes)}</span>
                    </span>
                    <PlayButton
                      track={{
                        id: artifact.id,
                        title: topicName,
                        subtitle: formatStamp(digest.createdAt),
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {texts.map((artifact) => (
            <div key={artifact.id} style={{ marginTop: 12 }}>
              <h3>
                {artifact.kind} <span className="mono">{artifact.mime}</span>
              </h3>
              {artifact.text ? (
                <pre className="summary">{artifact.text}</pre>
              ) : (
                <a href={`/api/artifacts/${artifact.id}`}>Download</a>
              )}
            </div>
          ))}
        </section>
      ) : null}

      {deliveries.length > 0 ? (
        <section className="card">
          <h2>Deliveries</h2>
          <table>
            <thead>
              <tr>
                <th>Sink</th>
                <th>Status</th>
                <th>Reference</th>
                <th>Attempted</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>{delivery.sinkLabel}</td>
                  <td>
                    <span className="badge">{delivery.status}</span>
                  </td>
                  <td className="mono">
                    {delivery.externalRef ?? delivery.error ?? "-"}
                  </td>
                  <td className="muted">{formatStamp(delivery.attemptedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
