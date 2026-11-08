package com.longbridge.nsh;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaPlayer;
import android.media.PlaybackParams;
import android.media.SoundPool;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.SparseArray;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;

/**
 * {@code Sound} and {@code AudioPlayer} of {@code nsh} ({@code docs/dev/audio-design.md}), one {@code Audio} per
 * engine ({@link Mounter}), on the UI thread, released with the app.
 *
 * <p>Sounds are a {@link SoundPool} (up to 32 streams: the oldest goes past them), loaded once from a temporary
 * file of their bytes; {@code SoundPool} reports no duration, so {@link MediaExtractor} reads it first. Sound longer
 * than the core allows is reported {@code truncated} and not loaded ({@code SoundPool} cannot stop short of the
 * end). Players are {@link MediaPlayer}s, made at their first preload or resume, with audio focus handled as
 * {@code VideoBox} does.
 *
 * <p>Reports are {@code Native.AUDIO} events on the root: {@code id}, {@code kind} and that kind's fields
 * ({@code host.rs}'s {@code audio_payload}). Commands are written by {@code encode.rs}'s {@code audio_command}.
 */
final class Audio {
    private static final String TAG = "nsh";
    /** Voices at once ({@code nsh_core::audio::MAX_VOICES}). */
    private static final int MAX_VOICES = 32;
    /** How often a player playing reports its position ({@code PROGRESS_INTERVAL}). */
    private static final long PROGRESS_MS = 250;

    private final Mounter mounter;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SoundPool pool;
    private final SparseArray<Sound> sounds = new SparseArray<>();
    /** Sounds by their {@code SoundPool} id, while they load and after. */
    private final SparseArray<Sound> byPool = new SparseArray<>();
    private final SparseArray<Player> players = new SparseArray<>();

    Audio(Mounter mounter) {
        this.mounter = mounter;
    }

    /** A command, as {@code encode.rs} wrote it. */
    void command(ByteBuffer b, Object[] objects) {
        int op = b.getInt();
        switch (op) {
            case 0: {
                int id = b.getInt();
                byte[] bytes = (byte[]) objects[b.getInt()];
                String hint = (String) objects[b.getInt()];
                int maxMs = b.getInt();
                load(id, bytes, hint, maxMs);
                return;
            }
            case 1: {
                int id = b.getInt();
                // The core reads the bytes here: URLs are the web's.
                failed(id, "not-supported", "sounds are loaded from their bytes here");
                return;
            }
            case 2: {
                int id = b.getInt();
                float volume = b.getFloat();
                float rate = b.getFloat();
                play(id, volume, rate);
                return;
            }
            case 3:
                stop(b.getInt());
                return;
            case 4:
                unload(b.getInt());
                return;
            case 5: {
                int id = b.getInt();
                String src = (String) objects[b.getInt()];
                float volume = b.getFloat();
                float rate = b.getFloat();
                boolean looped = b.getInt() != 0;
                Player old = players.get(id);
                if (old != null) old.close();
                players.put(id, new Player(id, src, volume, rate, looped));
                return;
            }
            case 6: {
                Player p = players.get(b.getInt());
                if (p != null) p.preload();
                return;
            }
            case 7: {
                Player p = players.get(b.getInt());
                if (p != null) p.resume();
                return;
            }
            case 8: {
                Player p = players.get(b.getInt());
                if (p != null) p.pause();
                return;
            }
            case 9: {
                int id = b.getInt();
                int ms = b.getInt();
                Player p = players.get(id);
                if (p != null) p.seek(ms);
                return;
            }
            case 10: {
                int id = b.getInt();
                float volume = b.getFloat();
                float rate = b.getFloat();
                boolean looped = b.getInt() != 0;
                Player p = players.get(id);
                if (p != null) p.set(volume, rate, looped);
                return;
            }
            case 11: {
                int id = b.getInt();
                Player p = players.get(id);
                if (p != null) {
                    players.remove(id);
                    p.close();
                }
                return;
            }
            default:
        }
    }

    /** The app stopped: everything stops and is freed, nothing is reported. */
    void release() {
        for (int i = 0; i < players.size(); i++) players.valueAt(i).close();
        players.clear();
        for (int i = 0; i < byPool.size(); i++) deleteFile(byPool.valueAt(i));
        sounds.clear();
        byPool.clear();
        if (pool != null) {
            pool.release();
            pool = null;
        }
    }

    // --- Reports ---------------------------------------------------------------

    private void report(int id, String kind, Object... fields) {
        String[] keys = new String[2 + fields.length / 2];
        Object[] values = new Object[keys.length];
        keys[0] = "id";
        values[0] = (double) id;
        keys[1] = "kind";
        values[1] = kind;
        for (int i = 0; i < fields.length; i += 2) {
            keys[2 + i / 2] = (String) fields[i];
            Object v = fields[i + 1];
            values[2 + i / 2] = v instanceof Number ? (Object) ((Number) v).doubleValue() : v;
        }
        mounter.eventMap(1, Native.AUDIO, keys, values);
    }

    private void failed(int id, String error, String message) {
        report(id, "failed", "error", error, "message", message == null ? "" : message);
    }

    // --- Sounds ----------------------------------------------------------------

    private static final class Sound {
        final int id;
        int poolId;
        File file;
        long durationMs;
        long bytes;
        boolean loaded;
        /** Streams started, oldest first (stopped ones stay until trimmed). */
        final ArrayList<Integer> streams = new ArrayList<>();

        Sound(int id) {
            this.id = id;
        }
    }

    private SoundPool pool() {
        if (pool == null) {
            AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            pool = new SoundPool.Builder().setMaxStreams(MAX_VOICES).setAudioAttributes(attributes).build();
            pool.setOnLoadCompleteListener(this::loaded);
        }
        return pool;
    }

    private static void deleteFile(Sound s) {
        if (s.file != null) {
            //noinspection ResultOfMethodCallIgnored
            s.file.delete();
            s.file = null;
        }
    }

    private void load(int id, byte[] bytes, String hint, int maxMs) {
        unload(id);
        File dir = new File(mounter.context.getCacheDir(), "nsh-audio");
        File file = null;
        try {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            file = File.createTempFile("sound", ".bin", dir);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            long durationUs = 0;
            int sampleRate = 44100;
            int channels = 2;
            boolean audio = false;
            MediaExtractor extractor = new MediaExtractor();
            try {
                extractor.setDataSource(file.getPath());
                for (int i = 0; i < extractor.getTrackCount(); i++) {
                    MediaFormat format = extractor.getTrackFormat(i);
                    String mime = format.getString(MediaFormat.KEY_MIME);
                    if (mime == null || !mime.startsWith("audio/")) continue;
                    audio = true;
                    if (format.containsKey(MediaFormat.KEY_DURATION)) durationUs = format.getLong(MediaFormat.KEY_DURATION);
                    if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    break;
                }
            } finally {
                extractor.release();
            }
            if (!audio) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                failed(id, "decode", "not audio the platform decodes: " + hint);
                return;
            }
            long durationMs = durationUs / 1000;
            boolean truncated = durationMs > maxMs;
            long keptMs = Math.min(durationMs, maxMs);
            Sound sound = new Sound(id);
            sound.durationMs = keptMs;
            // Decoded PCM, 16 bits a sample.
            sound.bytes = keptMs * sampleRate / 1000 * channels * 2;
            if (truncated) {
                // SoundPool cannot stop short: a minutes-long clip would fill memory. Reported, not loaded.
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                sounds.put(id, sound);
                report(id, "loaded", "durationMs", sound.durationMs, "bytes", sound.bytes, "truncated", true);
                return;
            }
            sound.file = file;
            sound.poolId = pool().load(file.getPath(), 1);
            if (sound.poolId == 0) {
                deleteFile(sound);
                failed(id, "decode", "the sound did not load");
                return;
            }
            sounds.put(id, sound);
            byPool.put(sound.poolId, sound);
        } catch (IOException | RuntimeException e) {
            if (file != null) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
            Log.w(TAG, "sound " + id + " did not load", e);
            failed(id, "decode", e.getMessage());
        }
    }

    /** {@code SoundPool}'s answer to a load. */
    private void loaded(SoundPool soundPool, int poolId, int status) {
        Sound sound = byPool.get(poolId);
        // Unloaded meanwhile: nothing is reported of it.
        if (sound == null) return;
        deleteFile(sound);
        if (status != 0) {
            byPool.remove(poolId);
            sounds.remove(sound.id);
            soundPool.unload(poolId);
            failed(sound.id, "decode", "the sound did not decode (" + status + ")");
            return;
        }
        sound.loaded = true;
        report(sound.id, "loaded", "durationMs", sound.durationMs, "bytes", sound.bytes, "truncated", false);
    }

    private void play(int id, float volume, float rate) {
        Sound sound = sounds.get(id);
        if (sound == null || !sound.loaded || pool == null) return;
        float v = Math.max(0f, Math.min(1f, volume));
        float r = Math.max(0.5f, Math.min(2f, rate));
        int stream = pool.play(sound.poolId, v, v, 1, 0, r);
        if (stream == 0) return;
        sound.streams.add(stream);
        // SoundPool recycles the oldest of its 32 streams itself: the list only needs to stay short.
        while (sound.streams.size() > MAX_VOICES) sound.streams.remove(0);
    }

    private void stop(int id) {
        Sound sound = sounds.get(id);
        if (sound == null || pool == null) return;
        for (int stream : sound.streams) pool.stop(stream);
        sound.streams.clear();
    }

    private void unload(int id) {
        Sound sound = sounds.get(id);
        if (sound == null) return;
        stop(id);
        sounds.remove(id);
        deleteFile(sound);
        if (sound.poolId != 0) {
            byPool.remove(sound.poolId);
            if (pool != null) pool.unload(sound.poolId);
        }
    }

    // --- Players ---------------------------------------------------------------

    private final class Player {
        final int id;
        final String src;
        float volume;
        float rate;
        boolean looped;
        MediaPlayer mp;
        boolean prepared;
        boolean playing;
        /** Resume was asked and the player has not started yet. */
        boolean wantsPlay;
        boolean failed;
        boolean atEnd;
        boolean closed;
        /** A seek asked before the player was prepared (-1: none). */
        int pendingSeek = -1;
        float appliedRate = 1f;
        /** A pause audio focus asked for, to undo when focus comes back. */
        boolean pausedByFocus;
        AudioFocusRequest focusRequest;
        boolean hasFocus;

        final Runnable ticker = new Runnable() {
            @Override
            public void run() {
                if (closed || !playing || mp == null) return;
                progress();
                handler.postDelayed(this, PROGRESS_MS);
            }
        };

        Player(int id, String src, float volume, float rate, boolean looped) {
            this.id = id;
            this.src = src;
            this.volume = volume;
            this.rate = rate;
            this.looped = looped;
        }

        boolean http() {
            return src.startsWith("http://") || src.startsWith("https://");
        }

        /** The duration, or -1 for a live stream. */
        int duration() {
            try {
                return mp != null && prepared ? mp.getDuration() : -1;
            } catch (IllegalStateException e) {
                return -1;
            }
        }

        void progress() {
            int position;
            try {
                position = mp.getCurrentPosition();
            } catch (IllegalStateException e) {
                return;
            }
            int duration = duration();
            if (duration >= 0) {
                report(id, "progress", "positionMs", position, "durationMs", duration);
            } else {
                report(id, "progress", "positionMs", position);
            }
        }

        void fail(String message) {
            if (failed || closed) return;
            failed = true;
            wantsPlay = false;
            playing = false;
            handler.removeCallbacks(ticker);
            releasePlayer();
            abandonFocus();
            Audio.this.failed(id, http() ? "network" : "decode", message);
        }

        void releasePlayer() {
            prepared = false;
            if (mp != null) {
                MediaPlayer p = mp;
                mp = null;
                try {
                    p.setOnPreparedListener(null);
                    p.setOnCompletionListener(null);
                    p.setOnErrorListener(null);
                    p.setOnInfoListener(null);
                    p.setOnSeekCompleteListener(null);
                    p.release();
                } catch (RuntimeException e) {
                    Log.w(TAG, "player " + id + " did not release", e);
                }
            }
        }

        /** Makes the {@code MediaPlayer} and starts its load, once. */
        void ensure() {
            if (mp != null || failed || closed) return;
            MediaPlayer p = new MediaPlayer();
            mp = p;
            atEnd = false;
            p.setAudioAttributes(attributes());
            p.setOnPreparedListener(m -> {
                if (m != mp) return;
                prepared = true;
                apply();
                int duration = duration();
                if (duration >= 0) {
                    report(id, "load", "durationMs", duration);
                } else {
                    report(id, "load");
                }
                if (pendingSeek >= 0) {
                    int to = pendingSeek;
                    pendingSeek = -1;
                    seek(to);
                }
                if (wantsPlay) start();
            });
            p.setOnCompletionListener(m -> {
                if (m != mp || looped) return;
                playing = false;
                atEnd = true;
                handler.removeCallbacks(ticker);
                int duration = duration();
                if (duration >= 0) report(id, "progress", "positionMs", duration, "durationMs", duration);
                report(id, "ended");
                abandonFocus();
            });
            p.setOnSeekCompleteListener(m -> {
                if (m == mp && prepared) progress();
            });
            p.setOnInfoListener((m, what, extra) -> {
                if (m == mp
                        && (what == MediaPlayer.MEDIA_INFO_BUFFERING_START || what == MediaPlayer.MEDIA_INFO_BUFFERING_END)) {
                    report(id, "buffer", "buffering", what == MediaPlayer.MEDIA_INFO_BUFFERING_START);
                }
                return false;
            });
            p.setOnErrorListener((m, what, extra) -> {
                if (m == mp) fail("media error " + what + " (" + extra + ")");
                return true;
            });
            try {
                mounter.host.setMediaSource(p, src);
                p.prepareAsync();
            } catch (IOException | RuntimeException e) {
                fail(String.valueOf(e.getMessage()));
            }
        }

        /** Volume and loop, which can change at any time once prepared. */
        void apply() {
            if (mp == null || !prepared) return;
            try {
                mp.setVolume(volume, volume);
                mp.setLooping(looped);
            } catch (IllegalStateException e) {
                Log.w(TAG, "player " + id + " did not take its settings", e);
            }
        }

        /** The rate, only while playing: on older systems setting it on a paused player starts it. */
        void applyRate() {
            if (mp == null || !prepared || !playing) return;
            if (rate == 1f && appliedRate == 1f) return;
            try {
                mp.setPlaybackParams(new PlaybackParams().setSpeed(rate));
                appliedRate = rate;
            } catch (IllegalArgumentException | IllegalStateException e) {
                Log.w(TAG, "player " + id + " did not take its rate", e);
            }
        }

        void start() {
            if (mp == null || !prepared || closed) return;
            try {
                if (atEnd) {
                    mp.seekTo(0);
                    atEnd = false;
                }
                wantsPlay = false;
                requestFocus();
                mp.start();
                playing = true;
            } catch (IllegalStateException e) {
                fail(String.valueOf(e.getMessage()));
                return;
            }
            applyRate();
            report(id, "playing");
            handler.removeCallbacks(ticker);
            handler.postDelayed(ticker, PROGRESS_MS);
        }

        void preload() {
            ensure();
        }

        void resume() {
            if (closed) return;
            if (failed) {
                // Again from scratch.
                failed = false;
                releasePlayer();
            }
            pausedByFocus = false;
            if (playing) return;
            wantsPlay = true;
            ensure();
            if (prepared) start();
        }

        void pause() {
            pausedByFocus = false;
            pause(false);
        }

        /** Pauses; {@code keepFocus}: another app took the focus for a while, and it comes back. */
        void pause(boolean keepFocus) {
            boolean was = playing || wantsPlay;
            wantsPlay = false;
            if (playing && mp != null) {
                try {
                    mp.pause();
                } catch (IllegalStateException e) {
                    Log.w(TAG, "player " + id + " did not pause", e);
                }
            }
            playing = false;
            handler.removeCallbacks(ticker);
            if (!keepFocus) abandonFocus();
            if (was) report(id, "paused");
        }

        void seek(int ms) {
            if (mp == null || !prepared) {
                pendingSeek = Math.max(0, ms);
                return;
            }
            int duration = duration();
            int to = Math.max(0, duration >= 0 ? Math.min(ms, duration) : ms);
            try {
                mp.seekTo(to, MediaPlayer.SEEK_CLOSEST);
                // A player that ended and is sought is not at its end.
                atEnd = false;
            } catch (IllegalStateException e) {
                Log.w(TAG, "player " + id + " did not seek", e);
            }
        }

        void set(float volume, float rate, boolean looped) {
            this.volume = volume;
            this.rate = rate;
            this.looped = looped;
            apply();
            applyRate();
        }

        void close() {
            if (closed) return;
            closed = true;
            wantsPlay = false;
            playing = false;
            handler.removeCallbacks(ticker);
            releasePlayer();
            abandonFocus();
        }

        // --- Audio focus, as VideoBox's --------------------------------------------

        AudioAttributes attributes() {
            return new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
        }

        /** Holds audio focus while the player plays: other apps pause, and resume once it pauses, ends or goes. */
        void requestFocus() {
            if (hasFocus) return;
            AudioManager manager = (AudioManager) mounter.context.getSystemService(Context.AUDIO_SERVICE);
            if (manager == null) return;
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(attributes())
                        .setWillPauseWhenDucked(true)
                        .setOnAudioFocusChangeListener(this::focusChanged)
                        .build();
            }
            hasFocus = manager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        }

        void abandonFocus() {
            if (focusRequest == null) return;
            hasFocus = false;
            AudioManager manager = (AudioManager) mounter.context.getSystemService(Context.AUDIO_SERVICE);
            if (manager != null) manager.abandonAudioFocusRequest(focusRequest);
        }

        void focusChanged(int change) {
            if (closed) return;
            if (change == AudioManager.AUDIOFOCUS_GAIN) {
                hasFocus = true;
                if (pausedByFocus) {
                    pausedByFocus = false;
                    start();
                }
            } else if (change == AudioManager.AUDIOFOCUS_LOSS) {
                // Gone for good: the app plays it again.
                hasFocus = false;
                pausedByFocus = false;
                if (playing) pause();
            } else if (playing) {
                // Lost for a while (a call, a navigation prompt): back on GAIN.
                pause(true);
                pausedByFocus = true;
            }
        }
    }
}
