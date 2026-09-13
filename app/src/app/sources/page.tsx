import { db } from "../../db/client.js";
import { listSinks, listSourceRuns } from "../../lib/queries.js";
import { pluginCatalog } from "../../lib/catalog.js";
import { formatStamp } from "../../lib/format.js";
import { ActionForm } from "../../components/ActionForm.js";
import { PluginConfigurator } from "../../components/PluginConfigurator.js";
import {
  createSinkAction,
  createSourceAction,
  deleteSinkAction,
  deleteSourceAction,
  pollSourceAction,
  setSinkEnabledAction,
  setSourceEnabledAction,
  testSinkAction,
  testSourceAction,
} from "../actions.js";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const database = db();
  const [sources, sinks, sourceCatalog, sinkCatalog] = await Promise.all([
    listSourceRuns(database),
    listSinks(database),
    pluginCatalog(database, "source"),
    pluginCatalog(database, "sink"),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Sources and sinks</h1>
          <p className="muted">
            A source is one configured feed, channel or query. A sink is where a
            finished digest lands.
          </p>
        </div>
      </div>

      <section className="card">
        <h2>Sources</h2>
        {sources.length === 0 ? (
          <p className="muted">No sources yet. Add one below.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Type</th>
                <th>Items</th>
                <th>Last polled</th>
                <th>Last error</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>
                    {source.label}
                    {source.enabled ? null : (
                      <span className="badge" style={{ marginLeft: 8 }}>
                        disabled
                      </span>
                    )}
                  </td>
                  <td className="mono">{source.pluginId}</td>
                  <td>{source.itemCount}</td>
                  <td className="muted">{formatStamp(source.lastPolledAt)}</td>
                  <td className={source.lastError ? "err-msg" : "muted"}>
                    {source.lastError ?? "-"}
                  </td>
                  <td>
                    <div className="row">
                      <form action={setSourceEnabledAction}>
                        <input type="hidden" name="sourceId" value={source.id} />
                        <input
                          type="hidden"
                          name="enabled"
                          value={source.enabled ? "0" : "1"}
                        />
                        <button type="submit" className="btn link">
                          {source.enabled ? "Disable" : "Enable"}
                        </button>
                      </form>
                      <ActionForm
                        action={pollSourceAction}
                        submitLabel="Poll now"
                        variant="plain"
                      >
                        <input type="hidden" name="sourceId" value={source.id} />
                      </ActionForm>
                      <form action={deleteSourceAction}>
                        <input type="hidden" name="sourceId" value={source.id} />
                        <button type="submit" className="btn link">
                          Delete
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>New source</h2>
        <p className="muted" style={{ marginTop: -8 }}>
          The form below is generated from the selected plugin own schema.
        </p>
        <PluginConfigurator
          catalog={sourceCatalog}
          createAction={createSourceAction}
          testAction={testSourceAction}
          createLabel="Create source"
          noun="source"
        />
      </section>

      <section className="card">
        <h2>Sinks</h2>
        {sinks.length === 0 ? (
          <p className="muted">No sinks yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Type</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sinks.map((sink) => (
                <tr key={sink.id}>
                  <td>
                    {sink.label}
                    {sink.enabled ? null : (
                      <span className="badge" style={{ marginLeft: 8 }}>
                        disabled
                      </span>
                    )}
                  </td>
                  <td className="mono">{sink.pluginId}</td>
                  <td>
                    <div className="row">
                      <form action={setSinkEnabledAction}>
                        <input type="hidden" name="sinkId" value={sink.id} />
                        <input
                          type="hidden"
                          name="enabled"
                          value={sink.enabled ? "0" : "1"}
                        />
                        <button type="submit" className="btn link">
                          {sink.enabled ? "Disable" : "Enable"}
                        </button>
                      </form>
                      <form action={deleteSinkAction}>
                        <input type="hidden" name="sinkId" value={sink.id} />
                        <button type="submit" className="btn link">
                          Delete
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>New sink</h2>
        <PluginConfigurator
          catalog={sinkCatalog}
          createAction={createSinkAction}
          testAction={testSinkAction}
          createLabel="Create sink"
          noun="sink"
        />
      </section>
    </>
  );
}
