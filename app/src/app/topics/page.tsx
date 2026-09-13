import Link from "next/link";
import { db } from "../../db/client.js";
import { listTopics } from "../../lib/queries.js";
import { pluginCatalog } from "../../lib/catalog.js";
import { loadSettings } from "../../lib/mutations.js";
import { ActionForm } from "../../components/ActionForm.js";
import { RendererPicker } from "../../components/RendererPicker.js";
import { createTopicAction } from "../actions.js";

export const dynamic = "force-dynamic";

export default async function TopicsPage() {
  const database = db();
  const [topics, renderers, settings] = await Promise.all([
    listTopics(database),
    pluginCatalog(database, "renderer"),
    loadSettings(database),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Topics</h1>
          <p className="muted">
            A topic groups sources and owns the keyword rules. One topic is one
            digest feed.
          </p>
        </div>
      </div>

      <section className="card">
        <h2>All topics</h2>
        {topics.length === 0 ? (
          <p className="muted">No topics yet. Create one below.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Sources</th>
                <th>Digests</th>
                <th>Schedule</th>
                <th>Curation</th>
                <th>Renderer</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {topics.map((topic) => (
                <tr key={topic.id}>
                  <td>
                    {topic.name}
                    {topic.enabled ? null : (
                      <span className="badge" style={{ marginLeft: 8 }}>
                        disabled
                      </span>
                    )}
                  </td>
                  <td className="mono">{topic.slug}</td>
                  <td>{topic.sourceCount}</td>
                  <td>{topic.digestCount}</td>
                  <td className="mono">
                    {topic.schedule ?? `${settings.defaultSchedule} (default)`}
                  </td>
                  <td>{topic.curationMode}</td>
                  <td className="mono">{topic.rendererId}</td>
                  <td>
                    <Link href={`/topics/${topic.id}`}>Manage</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>New topic</h2>
        <ActionForm
          action={createTopicAction}
          submitLabel="Create topic"
          className="stack"
        >
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" type="text" required />
          </div>
          <div className="field">
            <label htmlFor="slug">Slug</label>
            <input
              id="slug"
              name="slug"
              type="text"
              placeholder="derived from the name"
            />
          </div>
          <div className="field">
            <label htmlFor="description">Description</label>
            <input
              id="description"
              name="description"
              type="text"
              placeholder="Steers the renderer prompt"
            />
          </div>
          <div className="field">
            <label htmlFor="schedule">Schedule (cron)</label>
            <input
              id="schedule"
              name="schedule"
              type="text"
              placeholder={`${settings.defaultSchedule} (default when blank)`}
            />
          </div>
          <div className="field">
            <label htmlFor="curationMode">Curation mode</label>
            <select
              id="curationMode"
              name="curationMode"
              defaultValue={settings.defaultCurationMode}
            >
              <option value="manual">manual - approve before rendering</option>
              <option value="auto">auto - render without approval</option>
            </select>
          </div>
          <div className="row">
            <input id="enabled" name="enabled" type="checkbox" defaultChecked />
            <label htmlFor="enabled">Enabled</label>
          </div>

          <RendererPicker catalog={renderers} />
        </ActionForm>
      </section>
    </>
  );
}
