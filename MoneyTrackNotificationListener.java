package com.moneytrack.personal;

import android.app.Notification;
import android.content.ComponentName;
import android.os.Build;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.ArrayList;
import java.util.List;

/**
 * Reads bank / UPI alert notifications once the user has granted Notification Access in
 * Android Settings. Only messages that parse as a money movement are stored; everything
 * else is discarded immediately and never persisted.
 */
public class MoneyTrackNotificationListener extends NotificationListenerService {

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            if (sbn == null || getPackageName().equals(sbn.getPackageName())) return;
            Notification notification = sbn.getNotification();
            if (notification == null || notification.extras == null) return;
            if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;

            Bundle extras = notification.extras;
            String title = str(extras.getCharSequence(Notification.EXTRA_TITLE));
            String text = str(extras.getCharSequence(Notification.EXTRA_TEXT));
            String big = str(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));

            // Each candidate message is parsed on its own so grouped notifications
            // (inbox style / messaging style) do not merge two different amounts.
            List<String> candidates = new ArrayList<>();
            String main = big.isEmpty() ? text : big;
            candidates.add((title + " " + main).trim());

            CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            if (lines != null) {
                for (CharSequence line : lines) candidates.add(str(line));
            }
            Parcelable[] messages = extras.getParcelableArray("android.messages");
            if (messages != null) {
                for (Parcelable p : messages) {
                    if (p instanceof Bundle) candidates.add(str(((Bundle) p).getCharSequence("text")));
                }
            }

            for (String candidate : candidates) {
                if (candidate == null || candidate.trim().isEmpty()) continue;
                TransactionParser.Result parsed = TransactionParser.parse(candidate);
                if (parsed == null) continue;
                NativeQueue.add(this, "notification", sbn.getPackageName(), title, candidate,
                    parsed, sbn.getPostTime());
            }
        } catch (RuntimeException ignored) {
            // A malformed third-party notification must never crash the listener.
        }
    }

    @Override
    public void onListenerDisconnected() {
        // Ask the system to reconnect us if it unbound the listener (e.g. under memory pressure).
        if (Build.VERSION.SDK_INT >= 24) {
            try {
                NotificationListenerService.requestRebind(
                    new ComponentName(this, MoneyTrackNotificationListener.class));
            } catch (RuntimeException ignored) {
                // Rebind is best effort.
            }
        }
    }

    private static String str(CharSequence value) {
        return value == null ? "" : value.toString();
    }
}
