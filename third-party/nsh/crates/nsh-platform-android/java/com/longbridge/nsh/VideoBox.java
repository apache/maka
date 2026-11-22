package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.TextureView;
import android.widget.MediaController;
import java.util.Objects;

/**
 * `<video>`: a {@code MediaPlayer} drawing into a {@code TextureView} (which,
 * unlike a SurfaceView, transforms, clips and animates like any view).
 * `controls` attaches the platform's {@code MediaController}.
 */
@SuppressLint("ViewConstructor")
final class VideoBox extends WidgetBox implements TextureView.SurfaceTextureListener,
        MediaController.MediaPlayerControl {
    private final TextureView texture;
    private final NshView host;
    private MediaPlayer player;
    private Surface surface;
    private String source;
    private boolean prepared;
    private boolean paused, muted, repeat;
    private float volume = 1, rate = 1;
    /** 0 cover, 1 contain, 2 stretch. */
    private int resizeMode = 1;
    private float progressInterval = 250;
    /** 0 default, 1 playback, 2 mix with others. */
    private int audioSession;
    /** Audio focus while a `playback` video plays (`updateFocus`). */
    private AudioFocusRequest focusRequest;
    private boolean hasFocus;
    private int videoWidth, videoHeight;
    private MediaController controller;
    private final Runnable progress = this::progress;

    VideoBox(Context context, Mounter mounter, NshView host, int id) {
        super(context, mounter, id, new TextureView(context));
        this.host = host;
        texture = (TextureView) widget;
        texture.setSurfaceTextureListener(this);
    }

    void configure(String source, boolean paused, boolean muted, float volume, float rate, boolean repeat,
            int resizeMode, boolean controls, float progressInterval, int audioSession) {
        this.paused = paused;
        this.muted = muted;
        this.volume = volume;
        this.rate = rate;
        this.repeat = repeat;
        this.progressInterval = progressInterval;
        // A player takes its audio attributes before it prepares: another
        // session opens the source again.
        boolean reopen = audioSession != this.audioSession && player != null;
        if (audioSession != this.audioSession) {
            this.audioSession = audioSession;
            if (focusRequest != null) {
                abandonFocus();
                focusRequest = null;
            }
        }
        if (resizeMode != this.resizeMode) {
            this.resizeMode = resizeMode;
            fit();
        }
        if (controls && controller == null) {
            controller = new MediaController(getContext());
            controller.setMediaPlayer(this);
            controller.setAnchorView(this);
        } else if (!controls && controller != null) {
            controller.hide();
            controller = null;
        }
        if (!Objects.equals(source, this.source) || reopen) {
            this.source = source;
            open();
        } else {
            apply();
        }
    }

    private void open() {
        release();
        if (source == null) return;
        MediaPlayer p = new MediaPlayer();
        player = p;
        p.setOnPreparedListener(mp -> {
            if (mp != player) return;
            prepared = true;
            // A paused player draws nothing until it seeks: show the first frame.
            if (paused) mp.seekTo(0);
            mounter.eventMap(id, Native.LOAD, new String[] {"duration", "width", "height"},
                    new Object[] {mp.getDuration() / 1000.0, (double) mp.getVideoWidth(), (double) mp.getVideoHeight()});
            apply();
        });
        p.setOnVideoSizeChangedListener((mp, w, h) -> {
            videoWidth = w;
            videoHeight = h;
            fit();
        });
        p.setOnCompletionListener(mp -> {
            if (mp != player) return;
            mounter.event(id, Native.END);
            if (repeat) {
                mp.seekTo(0);
                mp.start();
            } else {
                // It stopped: the other apps' audio may play again.
                updateFocus();
            }
        });
        p.setOnInfoListener((mp, what, extra) -> {
            if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START || what == MediaPlayer.MEDIA_INFO_BUFFERING_END) {
                if (mounter.wants(id, Native.BUFFER)) {
                    mounter.eventMap(id, Native.BUFFER, new String[] {"isBuffering"},
                            new Object[] {what == MediaPlayer.MEDIA_INFO_BUFFERING_START});
                }
            }
            return false;
        });
        p.setOnErrorListener((mp, what, extra) -> {
            if (mp == player) {
                mounter.eventMap(id, Native.ERROR, new String[] {"message"},
                        new Object[] {"media error " + what + " (" + extra + ")"});
            }
            return true;
        });
        if (surface != null) p.setSurface(surface);
        AudioAttributes attributes = audioAttributes();
        if (attributes != null) p.setAudioAttributes(attributes);
        if (mounter.wants(id, Native.LOAD_START)) mounter.event(id, Native.LOAD_START);
        try {
            host.setMediaSource(p, source);
            p.prepareAsync();
        } catch (Exception e) {
            mounter.eventMap(id, Native.ERROR, new String[] {"message"}, new Object[] {String.valueOf(e.getMessage())});
        }
    }

    /** Applies the playback properties to a prepared player. */
    private void apply() {
        MediaPlayer p = player;
        if (p == null || !prepared) return;
        float v = muted ? 0 : Math.max(0, Math.min(1, volume));
        p.setVolume(v, v);
        if (paused) {
            if (p.isPlaying()) p.pause();
        } else {
            // Setting a speed starts playback, so only while playing.
            if (!p.isPlaying()) p.start();
            if (rate > 0 && p.getPlaybackParams().getSpeed() != rate) {
                p.setPlaybackParams(p.getPlaybackParams().setSpeed(rate));
            }
        }
        removeCallbacks(progress);
        if (!paused) postDelayed(progress, (long) progressInterval);
        updateFocus();
    }

    private void progress() {
        MediaPlayer p = player;
        if (p == null || !prepared || paused) return;
        if (mounter.wants(id, Native.PROGRESS)) {
            mounter.eventMap(id, Native.PROGRESS, new String[] {"currentTime", "duration"},
                    new Object[] {p.getCurrentPosition() / 1000.0, p.getDuration() / 1000.0});
        }
        postDelayed(progress, (long) Math.max(16, progressInterval));
    }

    void seek(float seconds) {
        if (player != null && prepared) player.seekTo((long) (seconds * 1000), MediaPlayer.SEEK_CLOSEST);
    }

    /** Scales the picture inside the view by `resizeMode`. */
    private void fit() {
        int w = texture.getWidth(), h = texture.getHeight();
        if (w == 0 || h == 0 || videoWidth == 0 || videoHeight == 0) return;
        Matrix m = new Matrix();
        if (resizeMode != 2) {
            // The texture stretches the picture to the view: undo, then fit.
            float sx = (float) videoWidth / w, sy = (float) videoHeight / h;
            float s = resizeMode == 0
                    ? Math.max((float) w / videoWidth, (float) h / videoHeight)
                    : Math.min((float) w / videoWidth, (float) h / videoHeight);
            m.setScale(sx * s, sy * s, w / 2f, h / 2f);
        }
        texture.setTransform(m);
        texture.invalidate();
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        fit();
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (controller != null && e.getActionMasked() == MotionEvent.ACTION_UP) {
            if (controller.isShowing()) controller.hide(); else controller.show();
            return true;
        }
        return super.onTouchEvent(e) || (controller != null && e.getActionMasked() == MotionEvent.ACTION_DOWN);
    }

    private void release() {
        removeCallbacks(progress);
        prepared = false;
        if (player != null) {
            player.release();
            player = null;
        }
        updateFocus();
    }

    /**
     * The attributes of `audioSession`'s sound: speech, for `playback` and
     * `mixWithOthers`; none (the player's own) for `default`.
     */
    private AudioAttributes audioAttributes() {
        if (audioSession == 0) return null;
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
    }

    /**
     * Holds audio focus while a `playback` video plays, and only then: other
     * apps pause while it plays and resume once it pauses, ends or goes
     * (`AUDIOFOCUS_GAIN_TRANSIENT`). Speech pauses rather than ducks when
     * another app takes the focus, and plays on when it comes back.
     */
    private void updateFocus() {
        MediaPlayer p = player;
        boolean wanted = audioSession == 1 && p != null && prepared && p.isPlaying();
        if (wanted == hasFocus) return;
        AudioManager manager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (manager == null) return;
        if (!wanted) {
            abandonFocus();
            return;
        }
        if (focusRequest == null) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(audioAttributes())
                    .setWillPauseWhenDucked(true)
                    .setOnAudioFocusChangeListener(this::focusChanged)
                    .build();
        }
        hasFocus = manager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void focusChanged(int change) {
        MediaPlayer p = player;
        if (change == AudioManager.AUDIOFOCUS_GAIN) {
            hasFocus = true;
            if (p != null && prepared && !paused && !p.isPlaying()) p.start();
        } else if (change == AudioManager.AUDIOFOCUS_LOSS) {
            // Gone for good: the app plays it again by its props.
            hasFocus = false;
            if (p != null && prepared && p.isPlaying()) p.pause();
        } else if (p != null && prepared && p.isPlaying()) {
            // Lost for a while (a call, a navigation prompt): back on GAIN.
            p.pause();
        }
    }

    private void abandonFocus() {
        if (focusRequest == null) return;
        hasFocus = false;
        AudioManager manager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (manager != null) manager.abandonAudioFocusRequest(focusRequest);
    }

    void destroy() {
        if (controller != null) controller.hide();
        release();
        abandonFocus();
        if (surface != null) {
            surface.release();
            surface = null;
        }
    }

    // --- TextureView.SurfaceTextureListener ------------------------------------

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture st, int width, int height) {
        surface = new Surface(st);
        if (player != null) player.setSurface(surface);
        fit();
    }

    @Override
    public void onSurfaceTextureSizeChanged(SurfaceTexture st, int width, int height) {
        fit();
    }

    @Override
    public boolean onSurfaceTextureDestroyed(SurfaceTexture st) {
        if (player != null) player.setSurface(null);
        if (surface != null) {
            surface.release();
            surface = null;
        }
        return true;
    }

    @Override
    public void onSurfaceTextureUpdated(SurfaceTexture st) {}

    // --- MediaController.MediaPlayerControl ------------------------------------
    // The controller plays and pauses the player directly; JS learns about it
    // only through progress (like the native controls on Apple).

    @Override
    public void start() {
        if (player != null && prepared) {
            player.start();
            paused = false;
            removeCallbacks(progress);
            post(progress);
            updateFocus();
        }
    }

    @Override
    public void pause() {
        if (player != null && prepared) player.pause();
        paused = true;
        updateFocus();
    }

    @Override
    public int getDuration() {
        return player != null && prepared ? player.getDuration() : 0;
    }

    @Override
    public int getCurrentPosition() {
        return player != null && prepared ? player.getCurrentPosition() : 0;
    }

    @Override
    public void seekTo(int pos) {
        if (player != null && prepared) player.seekTo(pos);
    }

    @Override
    public boolean isPlaying() {
        return player != null && prepared && player.isPlaying();
    }

    @Override
    public int getBufferPercentage() {
        return 0;
    }

    @Override
    public boolean canPause() {
        return true;
    }

    @Override
    public boolean canSeekBackward() {
        return true;
    }

    @Override
    public boolean canSeekForward() {
        return true;
    }

    @Override
    public int getAudioSessionId() {
        return player != null ? player.getAudioSessionId() : 0;
    }
}
