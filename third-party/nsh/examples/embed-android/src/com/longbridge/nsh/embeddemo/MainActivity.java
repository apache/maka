package com.longbridge.nsh.embeddemo;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;
import java.text.DateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.Map;

/**
 * An existing Android app that embeds a nsh app below its own native UI.
 * The nsh bundle (`nsh build ../embedded`) is packaged as APK
 * assets under `nsh/`; it uses a native component the app registers
 * (`embed.badge`) and talks to the app through the view's channel
 * (`nsh/host`): launch parameters, the "time" call it answers, the
 * "tapped" posts it hears and the "message" events "Send a message" sends.
 * (`embed.badge`). "Brand" puts the host's brand over the app's theme
 * (`setThemeOverrides`).
 */
public final class MainActivity extends Activity {
    private NshView nsh;
    private int loads;
    private boolean branded;

    /** The host's brand: the tokens it sets win over the app's, light and dark. */
    private static final String BRAND = "{ \"cssVars\": {"
            + " \"theme\": { \"radius\": \"1rem\" },"
            + " \"light\": { \"primary\": \"#e11d48\", \"primary-foreground\": \"#ffffff\" },"
            + " \"dark\": { \"primary\": \"#fb7185\", \"primary-foreground\": \"#1c1917\" } } }";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        float d = getResources().getDisplayMetrics().density;

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(Math.round(20 * d), Math.round(48 * d), Math.round(20 * d), Math.round(20 * d));
        column.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("Native host app");
        title.setTextSize(24);
        title.setTextColor(Color.BLACK);
        column.addView(title);

        TextView count = new TextView(this);
        Button reload = new Button(this);
        reload.setText("Reload nsh");
        reload.setOnClickListener(v -> {
            nsh.loadAssetBundle("nsh");
            count.setText("loaded " + (++loads) + "×");
        });
        // An event the app hears with `host.on("message", ...)`.
        Button message = new Button(this);
        message.setText("Send a message");
        message.setOnClickListener(v -> nsh.send("message",
                Collections.singletonMap("text", "Hello from Android at " + DateFormat.getTimeInstance().format(new Date()))));
        column.addView(reload);
        column.addView(message);
        Button brand = new Button(this);
        brand.setText("Brand");
        // null gives the app its own theme back.
        brand.setOnClickListener(v -> nsh.setThemeOverrides((branded = !branded) ? BRAND : null));
        column.addView(brand);
        column.addView(count);

        // The embedded nsh app, in a bordered frame.
        FrameLayout frame = new FrameLayout(this);
        GradientDrawable border = new GradientDrawable();
        border.setStroke(Math.round(2 * d), 0xff8250df);
        frame.setBackground(border);
        frame.setPadding(Math.round(2 * d), Math.round(2 * d), Math.round(2 * d), Math.round(2 * d));
        nsh = new NshView(this);
        nsh.setErrorListener(message -> Log.e("embed-demo", message));
        nsh.registerComponent("embed.badge", context -> new Badge(this, context));
        // The channel with the app (`nsh/host`): what it reads at start, the
        // call it makes and the posts it sends.
        nsh.setParams(Collections.singletonMap("user", "Ada"));
        nsh.handle("time", (data, reply) ->
                reply.resolve(Collections.singletonMap("time", DateFormat.getTimeInstance().format(new Date()))));
        nsh.handle("tapped", (data, reply) ->
                count.setText("the app posted tapped: " + ((Map<?, ?>) data).get("count")));
        frame.addView(nsh, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        column.addView(frame, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        setContentView(column);
        nsh.loadAssetBundle("nsh");
        count.setText("loaded " + (++loads) + "×");
    }

    @Override
    protected void onDestroy() {
        nsh.destroy();
        super.onDestroy();
    }

    /** {@code embed.badge}: a native label the nsh app lays out. Props {@code text}, {@code color}; emits {@code tap}; command {@code pulse}. */
    private static final class Badge implements NshComponent {
        private final TextView label;
        private final NshComponentContext context;
        private final float density;
        private int taps;

        Badge(android.content.Context app, NshComponentContext context) {
            this.context = context;
            density = app.getResources().getDisplayMetrics().density;
            label = new TextView(app);
            label.setTextColor(Color.WHITE);
            label.setTextSize(17);
            label.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            label.setGravity(android.view.Gravity.CENTER);
            label.setOnClickListener(v -> context.emit("tap", java.util.Collections.singletonMap("count", ++taps)));
        }

        @Override
        public android.view.View view() {
            return label;
        }

        @Override
        public void setProp(String name, Object value) {
            if (name.equals("text")) {
                label.setText(value instanceof String ? (String) value : "");
                // Sized to its text, with padding (dp).
                label.measure(0, 0);
                context.setSize(label.getMeasuredWidth() / density + 32, label.getMeasuredHeight() / density + 12);
            } else if (name.equals("color")) {
                label.setBackgroundColor(value instanceof String ? Color.parseColor((String) value) : 0xff8250df);
            }
        }

        @Override
        public void command(String name, Object args) {
            if (!name.equals("pulse")) return;
            label.setAlpha(0.3f);
            label.animate().alpha(1).setDuration(600).start();
        }
    }
}
