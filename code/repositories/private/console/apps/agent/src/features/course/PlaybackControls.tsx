export interface PlaybackState {
  step: number;
  isPlaying: boolean;
  replay: () => void;
  next: () => void;
}

/** 实验的播放控制条：流程 N/M、重新播放、下一步 */
export function PlaybackControls({ labels, playback }: { labels: string[]; playback: PlaybackState }) {
  const atEnd = playback.step === labels.length - 1;
  return (
    <div className="playback-controls">
      <div className="flow-status">
        <span className={playback.isPlaying ? "is-running" : ""} />
        <b>
          流程 {playback.step + 1}/{labels.length}
        </b>
        <em>{labels[playback.step]}</em>
      </div>
      <div>
        <button className="replay-button" onClick={playback.replay}>
          {playback.isPlaying ? "重新播放" : "播放流程"}
        </button>
        <button className="next-step" onClick={atEnd ? playback.replay : playback.next}>
          {atEnd ? "从头再看 ↺" : "下一步 →"}
        </button>
      </div>
    </div>
  );
}
