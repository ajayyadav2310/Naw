package com.moneytrack.personal;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Receives incoming SMS in the background (works while the app UI is closed) once the user
 * has granted the SMS permission. Only messages that parse as a money movement are stored.
 */
public class MoneyTrackSmsReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            if (intent == null || !Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
            SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
            if (messages == null || messages.length == 0) return;

            // Multi-part SMS arrive as several segments from the same sender; join them.
            Map<String, StringBuilder> bySender = new LinkedHashMap<>();
            long timestamp = 0L;
            for (SmsMessage message : messages) {
                if (message == null) continue;
                String sender = message.getOriginatingAddress() == null ? "" : message.getOriginatingAddress();
                String body = message.getMessageBody() == null ? "" : message.getMessageBody();
                StringBuilder builder = bySender.get(sender);
                if (builder == null) {
                    builder = new StringBuilder();
                    bySender.put(sender, builder);
                }
                builder.append(body);
                if (timestamp == 0L) timestamp = message.getTimestampMillis();
            }
            if (timestamp <= 0L) timestamp = System.currentTimeMillis();

            for (Map.Entry<String, StringBuilder> entry : bySender.entrySet()) {
                String body = entry.getValue().toString();
                TransactionParser.Result parsed = TransactionParser.parse(body);
                if (parsed == null) continue;
                NativeQueue.add(context, "sms", entry.getKey(), entry.getKey(), body, parsed, timestamp);
            }
        } catch (RuntimeException ignored) {
            // Never crash on a malformed message.
        }
    }
}
