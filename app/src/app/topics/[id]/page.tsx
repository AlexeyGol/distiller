import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "../../../db/client.js";
import {
  getTopic,
  listKeywords,
  listSinks,
  listSourceRuns,
  listTopicSinkIds,
  listTopicSourceIds,
} from "../../../lib/queries.js";
import { pluginCatalog } from "../../../lib/catalog.js";
import { loadSettings } from "../../../lib/mutations.js";
import { formatStamp } from "../../../lib/format.js";
import { ActionForm } from "../../../components/ActionForm.js";
import { RendererPicker } from "../../../components/RendererPicker.js";
import {
  addKeywordAction,
  attachSinkAction,
  attachSourceAction,
  buildDraftAction,
  deleteTopicAction,
  detachSinkAction,
  detachSourceAction,
  removeKeywordAction,
  setTopicRendererAction,
  updateTopicAction,
} from "../../actions.js";

export const dynamic = "force-dynamic";

export default async function TopicDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const database = db();

  const topic = await getTopic(database, id);
  if (!topic) notFound();

  const [
    attachedSourceIds,
    attachedSinkIds,
    allSources,
    allSinks,
    keywords,
    renderers,
    settings,
  ] = await Promise.all([
    listTopicSourceIds(database, id),
    listTopicSinkIds(database, id),
    listSourceRuns(database),
    listSinks(database),
    listKeywords(database, id),
    pluginCatalog(database, "renderer"),
    loadSettings(database),
  ]);

  const attachedSources = allSources.filter((s) =>
    attachedSourceIds.includes(s.id),
  );
  const availableSources = allSources.filter(
    (s) => !attachedSourceIds.includes(s.id),
  );
  const attachedSinks = allSinks.filter((s) => attachedSinkIds.includes(s.id));
  const availableSinks = allSinks.filter((s) => !attachedSinkIds.includes(s.id));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{topic.name}</h1>
          <p className="muted mono">{topic.slug}</p>
        </div>
        <ActionForm
          action={buildDraftAction}
          submitLabel="Build draft now"
          className="stack"
        >
          <input type="hidden" name="topicId" value={topic.id} />
        </ActionForm>
      </div>

      <section className="card">
        <h2>Settings</h2>
        <ActionForm
          action={updateTopicAction}
          submitLabel="Save topic"
          className="stack"
        >
          <input type="hidden" name="topicId" value={topic.id} />
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              name="name"
              type="text"
              defaultValue={topic.name}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="description">Description</label>
            <input
              id="description"
              name="description"
              type="text"
              defaultValue={topic.description ?? ""}
            />
          </div>
          <div className="field">
            <label htmlFor="schedule">Schedule (cron)</label>
            <input
              id="schedule"
              name="schedule"
              type="text"
              defaultValue={topic.schedule ?? ""}
              placeholder={`${settings.defaultSchedule} (default when blank)`}
            />
          </div>
          <div className="field">
            <label htmlFor="curationMode">Curation mode</label>
            <select
              id="curationMode"
              name="curationMode"
              defaultValue={topic.curationMode}
            >
              <option value="manual">manual - approve before rendering</option>
              <option value="auto">auto - render without approval</option>
            </select>
            <p className="hint">
              Rendering is quota-limited. Manual is the gate that stops junk
              from spending it.
            </p>
          </div>
          <div className="row">
            <input
              id="enabled"
              name="enabled"
              type="checkbox"
              defaultChecked={topic.enabled}
            />
            <label htmlFor="enabled">Enabled</label>
          </div>
        </ActionForm>
      </section>

      <section className="card">
        <h2>Renderer</h2>
        <ActionForm
          action={setTopicRendererAction}
          submitLabel="Save renderer"
          className="stack"
        >
          <input type="hidden" name="topicId" value={topic.id} />
          <RendererPicker
            catalog={renderers}
            selectedId={topic.rendererId}
            values={(topic.rendererConfig ?? {}) as Record<string, unknown>}
          />
        </ActionForm>
      </section>

      <section className="card">
        <h2>Sources</h2>
        {attachedSources.length === 0 ? (
          <p className="muted">
            No sources attached. A topic with no sources produces nothing.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Type</th>
                <th>Last polled</th>
                <th>Last error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {attachedSources.map((source) => (
                <tr key={source.id}>
                  <td>{source.label}</td>
                  <td className="mono">{source.pluginId}</td>
                  <td className="muted">{formatStamp(source.lastPolledAt)}</td>
                  <td className={source.lastError ? "err-msg" : "muted"}>
                    {source.lastError ?? "-"}
                  </td>
                  <td>
                    <form action={detachSourceAction}>
                      <input type="hidden" name="topicId" value={topic.id} />
                      <input type="hidden" name="sourceId" value={source.id} />
                      <button type="submit" className="btn link">
                        Detach
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {availableSources.length > 0 ? (
          <form action={attachSourceAction} className="inline-form" style={{ marginTop: 12 }}>
            <input type="hidden" name="topicId" value={topic.id} />
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="sourceId">Attach a source</label>
              <select id="sourceId" name="sourceId">
                {availableSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label} ({source.pluginId})
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn">
              Attach
            </button>
          </form>
        ) : (
          <p className="muted" style={{ marginTop: 12 }}>
            Every source is attached. <Link href="/sources">Add another</Link>.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Keywords</h2>
        <p className="muted" style={{ marginTop: -8 }}>
          Include rules decide what qualifies; exclude rules veto. With no
          include rules, everything qualifies.
        </p>
        {keywords.length === 0 ? (
          <p className="muted">No rules: every item from these sources matches.</p>
        ) : (
          <ul className="items">
            {keywords.map((keyword) => (
              <li key={keyword.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span>
                    <span className="badge">{keyword.mode}</span>{" "}
                    {keyword.term}
                  </span>
                  <form action={removeKeywordAction}>
                    <input type="hidden" name="topicId" value={topic.id} />
                    <input type="hidden" name="keywordId" value={keyword.id} />
                    <button type="submit" className="btn link">
                      Remove
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div style={{ marginTop: 12 }}>
          <ActionForm
            action={addKeywordAction}
            submitLabel="Add keyword"
            className="inline-form"
          >
            <input type="hidden" name="topicId" value={topic.id} />
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="term">Term</label>
              <input id="term" name="term" type="text" required />
            </div>
            <div className="field">
              <label htmlFor="mode">Mode</label>
              <select id="mode" name="mode" defaultValue="include">
                <option value="include">include</option>
                <option value="exclude">exclude</option>
              </select>
            </div>
          </ActionForm>
        </div>
      </section>

      <section className="card">
        <h2>Sinks</h2>
        {attachedSinks.length === 0 ? (
          <p className="muted">
            No sinks attached. Digests will still render, they just will not be
            delivered anywhere.
          </p>
        ) : (
          <ul className="items">
            {attachedSinks.map((sink) => (
              <li key={sink.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span>
                    {sink.label} <span className="mono muted">{sink.pluginId}</span>
                    {sink.enabled ? null : (
                      <span className="badge" style={{ marginLeft: 8 }}>
                        disabled
                      </span>
                    )}
                  </span>
                  <form action={detachSinkAction}>
                    <input type="hidden" name="topicId" value={topic.id} />
                    <input type="hidden" name="sinkId" value={sink.id} />
                    <button type="submit" className="btn link">
                      Detach
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}

        {availableSinks.length > 0 ? (
          <form action={attachSinkAction} className="inline-form" style={{ marginTop: 12 }}>
            <input type="hidden" name="topicId" value={topic.id} />
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="sinkId">Attach a sink</label>
              <select id="sinkId" name="sinkId">
                {availableSinks.map((sink) => (
                  <option key={sink.id} value={sink.id}>
                    {sink.label} ({sink.pluginId})
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn">
              Attach
            </button>
          </form>
        ) : (
          <p className="muted" style={{ marginTop: 12 }}>
            No unattached sinks. <Link href="/sources">Add one</Link>.
          </p>
        )}
      </section>

      <section className="card">
        <h3>Danger zone</h3>
        <form action={deleteTopicAction}>
          <input type="hidden" name="topicId" value={topic.id} />
          <button type="submit" className="btn danger">
            Delete topic and its digests
          </button>
        </form>
      </section>
    </>
  );
}
