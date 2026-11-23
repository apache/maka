package com.longbridge.nsh;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Coverage for which intents are presses of notifications NSH did not show, and their extras as JSON. Plain JDK, no
 * Android APIs, so it runs on a developer machine or in CI without a device:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/ForeignIntents.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/ForeignIntentsTest.java
 * java -cp target/java-tests com.longbridge.nsh.ForeignIntentsTest
 * </pre>
 */
public final class ForeignIntentsTest {
    private static final List<String> PAYLOAD = Arrays.asList("chat", "message_id");

    public static void main(String[] args) {
        check("the launch intent with a payload is a press",
                ForeignIntents.isPress(ForeignIntents.ACTION_MAIN, 0, PAYLOAD));
        check("an intent naming the activity with a payload is a press",
                ForeignIntents.isPress(null, 0, PAYLOAD));
        check("an SDK's own action with a payload is a press",
                ForeignIntents.isPress("com.example.push.OPEN", 0, PAYLOAD));
        check("a plain launch is not a press",
                !ForeignIntents.isPress(ForeignIntents.ACTION_MAIN, 0, Collections.emptyList()));
        check("an intent without extras is not a press", !ForeignIntents.isPress(null, 0, null));
        check("a link opened is not a press",
                !ForeignIntents.isPress("android.intent.action.VIEW", 0, PAYLOAD));
        check("a share is not a press",
                !ForeignIntents.isPress("android.intent.action.SEND", 0, PAYLOAD));
        check("Recents opening the task again is not a press",
                !ForeignIntents.isPress(ForeignIntents.ACTION_MAIN,
                        ForeignIntents.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY, PAYLOAD));
        check("NSH's own extras are no payload",
                !ForeignIntents.isPress(ForeignIntents.ACTION_MAIN, 0,
                        Arrays.asList("nsh.env.API_URL", "com.longbridge.nsh.NOTIFICATION")));
        check("a payload beside NSH's own extras is a press",
                ForeignIntents.isPress(ForeignIntents.ACTION_MAIN, 0, Arrays.asList("nsh.env.API_URL", "chat")));

        Map<String, Object> message = new LinkedHashMap<>();
        message.put("title", "Hi \"Ada\"\n\u0001");
        Map<Object, Object> numbers = new LinkedHashMap<>();
        numbers.put(1, "not a string key");
        List<Object> list = new ArrayList<>();
        list.add("a");
        list.add(null);
        Map<String, Object> extras = new LinkedHashMap<>();
        extras.put("message", message);
        extras.put("chat", "42");
        extras.put("badge", 3);
        extras.put("id", Long.MAX_VALUE);
        extras.put("ratio", 0.1f);
        extras.put("half", 0.5);
        extras.put("nan", Double.NaN);
        extras.put("unread", true);
        extras.put("initial", 'A');
        extras.put("ids", new long[] {1, -7});
        extras.put("tags", new String[] {"x", "y"});
        extras.put("list", list);
        extras.put("bytes", new byte[] {1, 2});
        extras.put("chars", new char[] {'o', 'k'});
        extras.put("sent", new Object());
        extras.put("numbers", numbers);
        String json = ForeignIntents.json(extras);
        String expected = "{\"message\":{\"title\":\"Hi \\\"Ada\\\"\\n\\u0001\"},\"chat\":\"42\",\"badge\":3,"
                + "\"id\":9223372036854775807,\"ratio\":0.1,\"half\":0.5,\"nan\":null,\"unread\":true,"
                + "\"initial\":\"A\",\"ids\":[1,-7],\"tags\":[\"x\",\"y\"],\"list\":[\"a\",null],\"bytes\":null,"
                + "\"chars\":\"ok\",\"sent\":null,\"numbers\":{}}";
        check("extras keep their values as JSON: " + json, json.equals(expected));
        check("no extras are null", ForeignIntents.json(null).equals("null"));
        System.out.println("ForeignIntentsTest: ok");
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
