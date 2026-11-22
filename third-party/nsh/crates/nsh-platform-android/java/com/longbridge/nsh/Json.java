package com.longbridge.nsh;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** JSON of native components as plain Java objects (maps, lists, numbers). */
final class Json {
    private Json() {}

    static Object parse(String json) {
        if (json == null) return null;
        try {
            return plain(new JSONTokener(json).nextValue());
        } catch (JSONException e) {
            android.util.Log.e("nsh", "invalid component JSON: " + e);
            return null;
        }
    }

    private static Object plain(Object v) throws JSONException {
        if (v == JSONObject.NULL) return null;
        if (v instanceof JSONObject) {
            JSONObject o = (JSONObject) v;
            Map<String, Object> map = new LinkedHashMap<>();
            for (Iterator<String> keys = o.keys(); keys.hasNext(); ) {
                String key = keys.next();
                map.put(key, plain(o.get(key)));
            }
            return map;
        }
        if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            List<Object> list = new ArrayList<>(a.length());
            for (int i = 0; i < a.length(); i++) list.add(plain(a.get(i)));
            return list;
        }
        return v;
    }

    static String stringify(Object v) {
        Object wrapped = JSONObject.wrap(v);
        if (wrapped == null) return "null";
        if (wrapped instanceof String) return JSONObject.quote((String) wrapped);
        return wrapped.toString();
    }
}
