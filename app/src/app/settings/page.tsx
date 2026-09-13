import { db } from "../../db/client.js";
import { loadPluginToggles, loadSettings } from "../../lib/mutations.js";
import { pluginCatalog, type PluginKind } from "../../lib/catalog.js";
import { ActionForm } from "../../components/ActionForm.js";
import { saveSettingsAction, setPluginEnabledAction,
  importConfigAction,
} from "../actions.js";

export const dynamic = "force-dynamic";

const KINDS: Array<{ kind: PluginKind; title: string; blurb: string }> = [
  {
    kind: "source",
    title: "Sources",
    blurb: "Disabling a type hides it from the catalog and pauses its instances.",
  },
  {
    kind: "renderer",
    title: "Renderers",
    blurb: "A disabled renderer cannot be picked for a topic.",
  },
  { kind: "sink", title: "Sinks", blurb: "Where finished digests land." },
];

export default async function SettingsPage() {
  const database = db();
  const [settings, toggles, source, renderer, sink] = await Promise.all([
    loadSettings(database),
    loadPluginToggles(database),
    pluginCatalog(database, "source", { includeDisabled: true }),
    pluginCatalog(database, "renderer", { includeDisabled: true }),
    pluginCatalog(database, "sink", { includeDisabled: true }),
  ]);

  const byKind: Record<PluginKind, typeof source> = { source, renderer, sink };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Defaults for new topics, and plugin toggles.</p>
        </div>
      </div>

      <section className="card">
        <h2>Defaults</h2>
        <ActionForm
          action={saveSettingsAction}
          submitLabel="Save settings"
          className="stack"
        >
          <div className="field">
            <label htmlFor="defaultSchedule">Default schedule (cron)</label>
            <input
              id="defaultSchedule"
              name="defaultSchedule"
              type="text"
              defaultValue={settings.defaultSchedule}
              required
            />
            <p className="hint">Used by any topic that does not set its own.</p>
          </div>
          <div className="field">
            <label htmlFor="defaultCurationMode">Default curation mode</label>
            <select
              id="defaultCurationMode"
              name="defaultCurationMode"
              defaultValue={settings.defaultCurationMode}
            >
              <option value="manual">manual</option>
              <option value="auto">auto</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="retentionDays">Retention (days)</label>
            <input
              id="retentionDays"
              name="retentionDays"
              type="number"
              min={1}
              defaultValue={settings.retentionDays}
              required
            />
          </div>
        </ActionForm>
      </section>

      <section className="card">
        <h2>Backup and transfer</h2>
        <p className="muted" style={{ marginTop: -8 }}>
          Topics, sources, sinks, keywords and settings as one JSON file. It
          contains no database ids, so it imports onto a different install -
          useful for moving to a server, or for keeping your setup in git.
          Rendered audio and past digests are not included; those are what
          <code> pg_dump </code> is for.
        </p>

        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <a className="btn" href="/api/config/export" download>
            Download config
          </a>
          <a
            className="btn"
            href="/api/config/export?secrets=1"
            download
            title="Includes API keys and bot tokens in plain text"
          >
            Download with secrets
          </a>
        </div>

        <p className="muted" style={{ marginTop: 12 }}>
          <strong>Download config</strong> redacts every API key and bot token,
          so it is safe to commit or share. <strong>With secrets</strong> is the
          restorable backup - treat that file like a password.
        </p>

        <div style={{ marginTop: 20 }}>
          <ActionForm action={importConfigAction} submitLabel="Import">
            <div className="field">
              <label htmlFor="bundle">Import a config file</label>
              <input
                id="bundle"
                name="bundle"
                type="file"
                accept="application/json,.json"
                required
              />
            </div>
          </ActionForm>
          <p className="muted" style={{ marginTop: 8 }}>
            Importing adds and updates; it never deletes anything the file does
            not mention. Redacted fields keep whatever value is already stored,
            so a shared config will not wipe your keys.
          </p>
        </div>
      </section>

      {KINDS.map(({ kind, title, blurb }) => (
        <section className="card" key={kind}>
          <h2>{title}</h2>
          <p className="muted" style={{ marginTop: -8 }}>
            {blurb}
          </p>
          <table>
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Id</th>
                <th>Description</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {byKind[kind].map((plugin) => {
                const enabled = toggles.get(`${kind}:${plugin.id}`) !== false;
                return (
                  <tr key={plugin.id}>
                    <td>{plugin.label}</td>
                    <td className="mono">{plugin.id}</td>
                    <td className="muted">{plugin.description}</td>
                    <td>
                      <form action={setPluginEnabledAction} className="row">
                        <input type="hidden" name="pluginId" value={plugin.id} />
                        <input type="hidden" name="kind" value={kind} />
                        <input
                          type="hidden"
                          name="enabled"
                          value={enabled ? "0" : "1"}
                        />
                        <span className="badge">
                          {enabled ? "enabled" : "disabled"}
                        </span>
                        <button type="submit" className="btn link">
                          {enabled ? "Disable" : "Enable"}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
