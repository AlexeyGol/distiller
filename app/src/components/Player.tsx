"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * The persistent audio player.
 *
 * It lives in the root layout, so the <audio> element survives navigation and
 * an episode keeps playing while you browse to another digest. This is the app
 * reading its own artifact store: it has no config and no alternative
 * implementation, so it is deliberately NOT a plugin.
 */

export interface Track {
  /** Artifact id; also the route segment it streams from. */
  id: string;
  title: string;
  subtitle?: string;
}

interface PlayerApi {
  current: Track | null;
  play(track: Track): void;
  stop(): void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

export function usePlayer(): PlayerApi {
  const api = useContext(PlayerContext);
  if (!api) throw new Error("usePlayer used outside PlayerProvider");
  return api;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Track | null>(null);

  const play = useCallback((track: Track) => setCurrent(track), []);
  const stop = useCallback(() => setCurrent(null), []);
  const api = useMemo<PlayerApi>(
    () => ({ current, play, stop }),
    [current, play, stop],
  );

  return (
    <PlayerContext.Provider value={api}>
      {children}
      <PlayerBar />
    </PlayerContext.Provider>
  );
}

function PlayerBar() {
  const { current, stop } = usePlayer();
  if (!current) return null;

  return (
    <div className="player" role="region" aria-label="Audio player">
      <div className="player-meta">
        <strong>{current.title}</strong>
        {current.subtitle ? <span className="muted"> {current.subtitle}</span> : null}
      </div>
      <audio
        // Keyed by artifact id so switching episodes reloads the element
        // rather than seeking inside the previous one.
        key={current.id}
        src={`/api/artifacts/${current.id}`}
        controls
        autoPlay
        preload="none"
      />
      <button type="button" className="btn plain" onClick={stop}>
        Close
      </button>
    </div>
  );
}

export function PlayButton({
  track,
  label = "Play",
}: {
  track: Track;
  label?: string;
}) {
  const { play, current } = usePlayer();
  const active = current?.id === track.id;

  return (
    <button
      type="button"
      className={`btn ${active ? "primary" : "plain"}`}
      onClick={() => play(track)}
    >
      {active ? "Playing" : label}
    </button>
  );
}
