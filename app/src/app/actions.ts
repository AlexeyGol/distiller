"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "../db/client.js";
import { registry } from "../plugins.js";
import {
  approveDigest,
  buildDraft,
  deliverDigest,
  renderDigest,
  setItemIncluded,
} from "../pipeline/digest.js";
import { ingestSource } from "../pipeline/ingest.js";
import { getSource } from "../lib/queries.js";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  appPassword,
  signSession,
} from "../lib/auth.js";
import { describeSchema, valuesFromFormData } from "../lib/schema-form.js";
import { importConfig, type ConfigBundle } from "../lib/config-transfer.js";
import type { ActionState } from "../lib/action-state.js";
import {
  addKeyword,
  attachSink,
  attachSource,
  createSink,
  createSource,
  updateSourceConfig,
  updateSinkConfig,
  createTopic,
  deleteSink,
  deleteSource,
  deleteTopic,
  describe as describeError,
  detachSink,
  detachSource,
  removeKeyword,
  saveSettings,
  setPluginEnabled,
  setSinkEnabled,
  setSourceEnabled,
  setTopicRenderer,
  testSinkConfig,
  testSourceConfig,
  updateTopic,
  type CurationMode,
} from "../lib/mutations.js";

/**
 * Server Actions.
 *
 * Every one of these is a thin wrapper: parse the form, call the tested write
 * in src/lib/mutations.ts or the pipeline, revalidate. The logic lives there so
 * it can be tested against a real database without booting Next, and so this
 * RPC surface never takes a Database argument a browser could supply.
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function checked(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
}

function curation(form: FormData, name: string): CurationMode {
  return text(form, name) === "auto" ? "auto" : "manual";
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function loginAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const password = appPassword();
  if (!password) redirect("/");

  if (text(form, "password") !== password) {
    // Deliberately vague: there is one account, so "wrong password" is all
    // there is to say, and saying more only helps someone guessing.
    return { ok: false, message: "Incorrect password." };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, await signSession(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });

  const next = text(form, "next");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/login");
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export async function createTopicAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  let id: string;
  try {
    const rendererId = text(form, "rendererId") || "llm-text";
    const plugin = registry().getRenderer(rendererId);
    const rendererConfig = plugin
      ? valuesFromFormData(describeSchema(plugin.configSchema), form, "renderer.")
      : {};

    const topic = await createTopic(db(), {
      name: text(form, "name"),
      slug: text(form, "slug"),
      description: text(form, "description"),
      enabled: checked(form, "enabled"),
      schedule: text(form, "schedule"),
      curationMode: curation(form, "curationMode"),
      rendererId,
      rendererConfig,
    });
    id = topic.id;
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }

  revalidatePath("/topics");
  revalidatePath("/");
  redirect(`/topics/${id}`);
}

export async function updateTopicAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const topicId = text(form, "topicId");
  try {
    await updateTopic(db(), topicId, {
      name: text(form, "name"),
      description: text(form, "description"),
      enabled: checked(form, "enabled"),
      schedule: text(form, "schedule"),
      curationMode: curation(form, "curationMode"),
    });
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
  revalidatePath(`/topics/${topicId}`);
  revalidatePath("/topics");
  return { ok: true, message: "Topic saved." };
}

export async function setTopicRendererAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const topicId = text(form, "topicId");
  const rendererId = text(form, "rendererId");
  try {
    const plugin = registry().getRenderer(rendererId);
    if (!plugin) throw new Error(`Unknown renderer plugin: "${rendererId}"`);
    const config = valuesFromFormData(
      describeSchema(plugin.configSchema),
      form,
      "renderer.",
    );
    await setTopicRenderer(db(), topicId, rendererId, config);
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
  revalidatePath(`/topics/${topicId}`);
  return { ok: true, message: "Renderer saved." };
}

export async function deleteTopicAction(form: FormData): Promise<void> {
  await deleteTopic(db(), text(form, "topicId"));
  revalidatePath("/topics");
  revalidatePath("/");
  redirect("/topics");
}

export async function attachSourceAction(form: FormData): Promise<void> {
  const topicId = text(form, "topicId");
  await attachSource(db(), topicId, text(form, "sourceId"));
  revalidatePath(`/topics/${topicId}`);
}

export async function detachSourceAction(form: FormData): Promise<void> {
  const topicId = text(form, "topicId");
  await detachSource(db(), topicId, text(form, "sourceId"));
  revalidatePath(`/topics/${topicId}`);
}

export async function attachSinkAction(form: FormData): Promise<void> {
  const topicId = text(form, "topicId");
  await attachSink(db(), topicId, text(form, "sinkId"));
  revalidatePath(`/topics/${topicId}`);
}

export async function detachSinkAction(form: FormData): Promise<void> {
  const topicId = text(form, "topicId");
  await detachSink(db(), topicId, text(form, "sinkId"));
  revalidatePath(`/topics/${topicId}`);
}

export async function addKeywordAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const topicId = text(form, "topicId");
  try {
    await addKeyword(db(), topicId, text(form, "term"), text(form, "mode"));
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
  revalidatePath(`/topics/${topicId}`);
  return { ok: true, message: "" };
}

export async function removeKeywordAction(form: FormData): Promise<void> {
  await removeKeyword(db(), text(form, "keywordId"));
  revalidatePath(`/topics/${text(form, "topicId")}`);
}

/** "Build draft now": collect everything new for this topic into a draft. */
export async function buildDraftAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const topicId = text(form, "topicId");
  let digestId: string | null = null;
  try {
    const result = await buildDraft({ db: db(), registry: registry() }, topicId);
    if (!result.digestId) {
      return {
        ok: false,
        message:
          result.reason === "no-items"
            ? "No unused items for this topic. Poll its sources first."
            : `${result.candidates} candidates, none matched the keyword rules.`,
      };
    }
    digestId = result.digestId;
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }

  revalidatePath("/digests");
  revalidatePath(`/topics/${topicId}`);
  redirect(`/digests/${digestId}`);
}

// ---------------------------------------------------------------------------
// Sources and sinks
// ---------------------------------------------------------------------------

function configFrom(form: FormData, schema: unknown): Record<string, unknown> {
  return valuesFromFormData(describeSchema(schema), form, "config.");
}

export async function createSourceAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const pluginId = text(form, "pluginId");
  try {
    const plugin = registry().getSource(pluginId);
    if (!plugin) throw new Error(`Unknown source plugin: "${pluginId}"`);
    await createSource(db(), {
      pluginId,
      label: text(form, "label"),
      config: configFrom(form, plugin.configSchema),
    });
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
  revalidatePath("/sources");
  revalidatePath("/");
  return { ok: true, message: "Source created." };
}

/**
 * Edit an existing source: its label and its whole plugin config.
 *
 * Without this the only way to fix a typo in a feed URL, or to change a
 * YouTube search query, was to delete the source and recreate it - which also
 * deletes every item it ever ingested, because items cascade from sources.
 * Editing in place keeps the history.
 */
export async function updateSourceAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const sourceId = text(form, "sourceId");
  const pluginId = text(form, "pluginId");
  try {
    const plugin = registry().getSource(pluginId);
    if (!plugin) throw new Error(`Unknown source plugin: "${pluginId}"`);
    await updateSourceConfig(
      db(),
      sourceId,
      text(form, "label"),
      configFrom(form, plugin.configSchema),
    );
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
  revalidatePath("/sources");
  revalidatePath("/");
  return { ok: true, message: "Source updated." };
}

/** The "Test" button. Runs the plugin validate(); never writes anything. */
export async function testSourceAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const pluginId = text(form, "pluginId");
  const plugin = registry().getSource(pluginId);
  if (!plugin) return { ok: false, message: `Unknown plugin: "${pluginId}"` };
  return testSourceConfig(pluginId, configFrom(form, plugin.configSchema));
}

export async function setSourceEnabledAction(form: FormData): Promise<void> {
  await setSourceEnabled(db(), text(form, "sourceId"), checked(form, "enabled"));
  revalidatePath("/sources");
  revalidatePath("/");
}

export async function deleteSourceAction(form: FormData): Promise<void> {
  await deleteSource(db(), text(form, "sourceId"));
  revalidatePath("/sources");
  revalidatePath("/");
}

/** Poll one source now, so "why is this feed silent" is answerable in place. */
export async function pollSourceAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const sourceId = text(form, "sourceId");
  const source = await getSource(db(), sourceId);
  if (!source) return { ok: false, message: "Source not found." };

  const result = await ingestSource(
    { db: db(), registry: registry() },
    source,
  );
  revalidatePath("/sources");
  revalidatePath("/");

  if (result.error) return { ok: false, message: result.error };
  return {
    ok: true,
    message: `Fetched ${result.fetched}, ${result.inserted} new.`,
  };
}

export async function createSinkAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const pluginId = text(form, "pluginId");
  try {
    const plugin = registry().getSink(pluginId);
    if (!plugin) throw new Error(`Unknown sink plugin: "${pluginId}"`);
    await createSink(db(), {
      pluginId,
      label: text(form, "label"),
      config: configFrom(form, plugin.configSchema),
    });
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
  revalidatePath("/sinks");
  revalidatePath("/sources");
  return { ok: true, message: "Sink created." };
}

export async function testSinkAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const pluginId = text(form, "pluginId");
  const plugin = registry().getSink(pluginId);
  if (!plugin) return { ok: false, message: `Unknown plugin: "${pluginId}"` };
  return testSinkConfig(pluginId, configFrom(form, plugin.configSchema));
}

/** Edit an existing sink: label plus its whole plugin config. */
export async function updateSinkAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const sinkId = text(form, "sinkId");
  const pluginId = text(form, "pluginId");
  try {
    const plugin = registry().getSink(pluginId);
    if (!plugin) throw new Error(`Unknown sink plugin: "${pluginId}"`);
    await updateSinkConfig(
      db(),
      sinkId,
      text(form, "label"),
      configFrom(form, plugin.configSchema),
    );
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
  revalidatePath("/sources");
  return { ok: true, message: "Sink updated." };
}

export async function setSinkEnabledAction(form: FormData): Promise<void> {
  await setSinkEnabled(db(), text(form, "sinkId"), checked(form, "enabled"));
  revalidatePath("/sources");
}

export async function deleteSinkAction(form: FormData): Promise<void> {
  await deleteSink(db(), text(form, "sinkId"));
  revalidatePath("/sources");
}

// ---------------------------------------------------------------------------
// Digests: the curation gate
// ---------------------------------------------------------------------------

/**
 * Persist the checkbox state for a whole draft. The form posts one
 * `include:<itemId>` entry per ticked box, plus an `item:<itemId>` marker for
 * every row, so an unticked box is distinguishable from an absent row.
 */
async function persistSelection(
  digestId: string,
  form: FormData,
): Promise<number> {
  const database = db();
  let included = 0;
  for (const [key, value] of form.entries()) {
    if (key !== "item") continue;
    const itemId = String(value);
    const isIncluded = form.getAll("include").includes(itemId);
    if (isIncluded) included += 1;
    await setItemIncluded(database, digestId, itemId, isIncluded);
  }
  return included;
}

export async function saveSelectionAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const digestId = text(form, "digestId");
  try {
    const included = await persistSelection(digestId, form);
    revalidatePath(`/digests/${digestId}`);
    return { ok: true, message: `Saved: ${included} item(s) included.` };
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
}

export async function approveDigestAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const digestId = text(form, "digestId");
  try {
    await persistSelection(digestId, form);
    await approveDigest(db(), digestId);
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
  revalidatePath(`/digests/${digestId}`);
  revalidatePath("/digests");
  return { ok: true, message: "Approved. Ready to render." };
}

export async function renderDigestAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const digestId = text(form, "digestId");
  try {
    const result = await renderDigest(
      { db: db(), registry: registry() },
      digestId,
    );
    revalidatePath(`/digests/${digestId}`);
    revalidatePath("/digests");
    if (result.status === "ready") return { ok: true, message: "Rendered." };
    return { ok: false, message: `${result.status}: ${result.reason ?? ""}` };
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
}

export async function deliverDigestAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const digestId = text(form, "digestId");
  try {
    const outcomes = await deliverDigest(
      { db: db(), registry: registry() },
      digestId,
    );
    revalidatePath(`/digests/${digestId}`);
    if (outcomes.length === 0) {
      return { ok: false, message: "No enabled sinks attached to this topic." };
    }
    const failed = outcomes.filter((o) => o.status === "failed");
    if (failed.length === 0) {
      return { ok: true, message: `Delivered to ${outcomes.length} sink(s).` };
    }
    return {
      ok: false,
      message: failed.map((f) => f.error ?? "failed").join("; "),
    };
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveSettingsAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    await saveSettings(db(), {
      defaultSchedule: text(form, "defaultSchedule"),
      defaultCurationMode: curation(form, "defaultCurationMode"),
      retentionDays: Number(text(form, "retentionDays")),
    });
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
  revalidatePath("/settings");
  return { ok: true, message: "Settings saved." };
}

export async function setPluginEnabledAction(form: FormData): Promise<void> {
  await setPluginEnabled(
    db(),
    text(form, "pluginId"),
    text(form, "kind"),
    checked(form, "enabled"),
  );
  revalidatePath("/settings");
  revalidatePath("/sources");
}

/**
 * Import a configuration bundle uploaded through the UI.
 *
 * Warnings are surfaced rather than swallowed: a skipped source or a credential
 * that still needs filling in is the actionable part of an import, and an
 * "imported successfully" that hid three skipped sources would be a lie.
 */
export async function importConfigAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const file = form.get("bundle");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a config JSON file first." };
  }

  try {
    const bundle = JSON.parse(await file.text()) as ConfigBundle;
    const result = await importConfig(db(), bundle);

    const summary =
      `Sources +${result.sources.created}/~${result.sources.updated}, ` +
      `sinks +${result.sinks.created}/~${result.sinks.updated}, ` +
      `topics +${result.topics.created}/~${result.topics.updated}.`;

    if (result.warnings.length > 0) {
      return {
        ok: true,
        message: `${summary} ${result.warnings.length} warning(s): ${result.warnings.join("; ")}`,
      };
    }
    return { ok: true, message: summary };
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  } finally {
    revalidatePath("/settings");
    revalidatePath("/sources");
    revalidatePath("/topics");
    revalidatePath("/");
  }
}
