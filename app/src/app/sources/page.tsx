import { db } from "../../db/client.js";
import { listSinks, listSourceRuns } from "../../lib/queries.js";
import { pluginCatalog } from "../../lib/catalog.js";
import { formatStamp } from "../../lib/format.js";
import { summariseConfig } from "../../lib/config-display.js";
import { ActionForm } from "../../components/ActionForm.js";
import { PluginConfigurator } from "../../components/PluginConfigurator.js";
import { SchemaForm } from "../../components/SchemaForm.js";
import { EditDialog } from "../../components/EditDialog.js";
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
  updateSinkAction,
  updateSourceAction,
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
                <th>Query / config</th>
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
                  <td
                    className="mono muted"
                    title={summariseConfig(source.config, 400)}
                  >
                    {summariseConfig(source.config)}
                  </td>
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
                      <EditDialog
                        triggerLabel="Edit"
                        title={`Edit ${source.label}`}
                      >
                        {(() => {
                          const entry = sourceCatalog.find(
                            (p) => p.id === source.pluginId,
                          );
                          if (!entry) {
                            return (
                              <p className="err-msg">
                                Plugin &quot;{source.pluginId}&quot; is not
                                registered in this build, so its config cannot
                                be edited here.
                              </p>
                            );
                          }
                          return (
                            <ActionForm
                              action={updateSourceAction}
                              submitLabel="Save changes"
                            >
                              <input
                                type="hidden"
                                name="sourceId"
                                value={source.id}
                              />
                              <input
                                type="hidden"
                                name="pluginId"
                                value={source.pluginId}
                              />
                              <div className="field">
                                <label htmlFor={`label-${source.id}`}>
                                  Label
                                </label>
                                <input
                                  id={`label-${source.id}`}
                                  name="label"
                                  defaultValue={source.label}
                                />
                              </div>
                              <SchemaForm
                                fields={entry.fields}
                                values={
                                  (source.config ?? {}) as Record<
                                    string,
                                    unknown
                                  >
                                }
                                idPrefix={`edit-${source.id}`}
                              />
                            </ActionForm>
                          );
                        })()}
                      </EditDialog>
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
                <th>Config</th>
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
                  <td
                    className="mono muted"
                    title={summariseConfig(sink.config, 400)}
                  >
                    {summariseConfig(sink.config)}
                  </td>
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
                      <EditDialog
                        triggerLabel="Edit"
                        title={`Edit ${sink.label}`}
                      >
                        {(() => {
                          const entry = sinkCatalog.find(
                            (p) => p.id === sink.pluginId,
                          );
                          if (!entry) {
                            return (
                              <p className="err-msg">
                                Plugin &quot;{sink.pluginId}&quot; is not
                                registered in this build, so its config cannot
                                be edited here.
                              </p>
                            );
                          }
                          return (
                            <ActionForm
                              action={updateSinkAction}
                              submitLabel="Save changes"
                            >
                              <input
                                type="hidden"
                                name="sinkId"
                                value={sink.id}
                              />
                              <input
                                type="hidden"
                                name="pluginId"
                                value={sink.pluginId}
                              />
                              <div className="field">
                                <label htmlFor={`sink-label-${sink.id}`}>
                                  Label
                                </label>
                                <input
                                  id={`sink-label-${sink.id}`}
                                  name="label"
                                  defaultValue={sink.label}
                                />
                              </div>
                              <SchemaForm
                                fields={entry.fields}
                                values={
                                  (sink.config ?? {}) as Record<string, unknown>
                                }
                                idPrefix={`edit-sink-${sink.id}`}
                              />
                            </ActionForm>
                          );
                        })()}
                      </EditDialog>
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
