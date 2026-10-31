package com.moneytrack.personal;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Set;
import java.util.UUID;

/**
 * Durable, process-safe queue of detected transactions.
 *
 * The NotificationListenerService and SMS BroadcastReceiver run even when the web UI is not
 * open, so they park detected items here. The WebView drains the queue when the app is opened
 * and acknowledges items only after they have been saved, so nothing is lost if the UI dies.
 */
final class NativeQueue {
    private static final String PREFS = "moneytrack_native";
    private static final String KEY = "tx_queue";
    private static final int MAX_ITEMS = 1000;
    private static final long DUP_WINDOW_MS = 10L * 60L * 1000L;
    private static final Object LOCK = new Object();

    private NativeQueue() {}

    /** Adds an item unless an identical message from the same source was queued recently. */
    static void add(Context context, String source, String origin, String title, String text,
                    TransactionParser.Result parsed, long postedAt) {
        synchronized (LOCK) {
            try {
                SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                JSONArray queue = read(prefs);

                String trimmed = text.length() > 500 ? text.substring(0, 500) : text;
                for (int i = 0; i < queue.length(); i++) {
                    JSONObject existing = queue.getJSONObject(i);
                    if (source.equals(existing.optString("source"))
                        && trimmed.equals(existing.optString("text"))
                        && Math.abs(existing.optLong("postedAt") - postedAt) < DUP_WINDOW_MS) {
                        return;
                    }
                }

                JSONObject item = new JSONObject();
                item.put("id", UUID.randomUUID().toString());
                item.put("source", source);
                item.put("origin", origin == null ? "" : origin);
                item.put("title", title == null ? "" : title);
                item.put("text", trimmed);
                item.put("amount", parsed.amount);
                item.put("direction", parsed.direction);
                item.put("reference", parsed.reference);
                item.put("counterparty", parsed.counterparty);
                item.put("postedAt", postedAt);
                queue.put(item);

                JSONArray bounded = new JSONArray();
                for (int i = Math.max(0, queue.length() - MAX_ITEMS); i < queue.length(); i++) {
                    bounded.put(queue.getJSONObject(i));
                }
                prefs.edit().putString(KEY, bounded.toString()).commit();
            } catch (JSONException ignored) {
                // Never let a malformed item crash a background component.
            }
        }
    }

    static JSONArray all(Context context) {
        synchronized (LOCK) {
            return read(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
        }
    }

    static int count(Context context) {
        return all(context).length();
    }

    static void remove(Context context, Set<String> ids) {
        if (ids == null || ids.isEmpty()) return;
        synchronized (LOCK) {
            try {
                SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                JSONArray queue = read(prefs);
                JSONArray kept = new JSONArray();
                for (int i = 0; i < queue.length(); i++) {
                    JSONObject item = queue.getJSONObject(i);
                    if (!ids.contains(item.optString("id"))) kept.put(item);
                }
                prefs.edit().putString(KEY, kept.toString()).commit();
            } catch (JSONException ignored) {
                // leave the queue untouched
            }
        }
    }

    private static JSONArray read(SharedPreferences prefs) {
        try {
            return new JSONArray(prefs.getString(KEY, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }
}
