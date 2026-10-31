package com.moneytrack.personal;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.provider.Telephony;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

@CapacitorPlugin(
    name = "MoneyTrackBridge",
    permissions = {
        @Permission(alias = "sms", strings = { Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS })
    }
)
public class MoneyTrackBridgePlugin extends Plugin {

    // ---------------------------------------------------------------- status & settings

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatus());
    }

    private JSObject buildStatus() {
        JSObject status = new JSObject();
        status.put("notificationAccess", hasNotificationAccess());
        status.put("smsPermission", getPermissionState("sms") == PermissionState.GRANTED);
        status.put("batteryUnrestricted", isIgnoringBatteryOptimizations());
        status.put("pendingCount", NativeQueue.count(getContext()));
        status.put("sdk", Build.VERSION.SDK_INT);
        return status;
    }

    private boolean hasNotificationAccess() {
        try {
            return NotificationManagerCompat.getEnabledListenerPackages(getContext())
                .contains(getContext().getPackageName());
        } catch (RuntimeException e) {
            return false;
        }
    }

    private boolean isIgnoringBatteryOptimizations() {
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        } catch (RuntimeException e) {
            return false;
        }
    }

    @PluginMethod
    public void openNotificationAccessSettings(PluginCall call) {
        launch(call, new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS),
            "Could not open Notification Access settings.");
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        launch(call, new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            "Could not open battery settings.");
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + getContext().getPackageName()));
        launch(call, intent, "Could not open app settings.");
    }

    private void launch(PluginCall call, Intent intent, String error) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject(error, e);
        }
    }

    // ---------------------------------------------------------------- SMS permission

    @PluginMethod
    public void requestSmsPermission(PluginCall call) {
        if (getPermissionState("sms") == PermissionState.GRANTED) {
            call.resolve(buildStatus());
            return;
        }
        requestPermissionForAlias("sms", call, "smsPermissionCallback");
    }

    @PermissionCallback
    private void smsPermissionCallback(PluginCall call) {
        // Resolve with the current status either way; the UI shows whether it was granted.
        call.resolve(buildStatus());
    }

    // ---------------------------------------------------------------- SMS inbox import

    @PluginMethod
    public void importRecentSms(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            call.reject("SMS permission is not granted.", "SMS_PERMISSION_DENIED");
            return;
        }
        Integer requested = call.getInt("days", 30);
        int days = requested == null ? 30 : Math.max(1, Math.min(requested, 365));
        long since = System.currentTimeMillis() - days * 24L * 60L * 60L * 1000L;

        JSArray output = new JSArray();
        try (Cursor cursor = getContext().getContentResolver().query(
            Telephony.Sms.Inbox.CONTENT_URI,
            new String[] { "_id", "address", "body", "date" },
            "date >= ?",
            new String[] { String.valueOf(since) },
            "date DESC LIMIT 1000")) {

            if (cursor != null) {
                int addressCol = cursor.getColumnIndexOrThrow("address");
                int bodyCol = cursor.getColumnIndexOrThrow("body");
                int dateCol = cursor.getColumnIndexOrThrow("date");
                while (cursor.moveToNext()) {
                    String body = cursor.getString(bodyCol);
                    if (body == null) continue;
                    TransactionParser.Result parsed = TransactionParser.parse(body);
                    if (parsed == null) continue;
                    String sender = cursor.getString(addressCol);

                    JSObject item = new JSObject();
                    item.put("id", "import-" + cursor.getLong(dateCol) + "-" + Integer.toHexString(body.hashCode()));
                    item.put("source", "sms");
                    item.put("origin", sender == null ? "" : sender);
                    item.put("title", sender == null ? "" : sender);
                    item.put("text", body.length() > 500 ? body.substring(0, 500) : body);
                    item.put("amount", parsed.amount);
                    item.put("direction", parsed.direction);
                    item.put("reference", parsed.reference);
                    item.put("counterparty", parsed.counterparty);
                    item.put("postedAt", cursor.getLong(dateCol));
                    output.put(item);
                }
            }
            JSObject result = new JSObject();
            result.put("items", output);
            call.resolve(result);
        } catch (SecurityException e) {
            call.reject("SMS permission is unavailable.", e);
        } catch (RuntimeException e) {
            call.reject("Could not import SMS messages.", e);
        }
    }

    // ---------------------------------------------------------------- background queue

    @PluginMethod
    public void getPendingTransactions(PluginCall call) {
        try {
            JSArray items = new JSArray();
            JSONArray queue = NativeQueue.all(getContext());
            for (int i = 0; i < queue.length(); i++) items.put(queue.getJSONObject(i));
            JSObject result = new JSObject();
            result.put("items", items);
            call.resolve(result);
        } catch (JSONException e) {
            call.reject("Could not read pending transactions.", e);
        }
    }

    /** Removes items from the queue; the UI calls this only after it has saved them. */
    @PluginMethod
    public void ackPendingTransactions(PluginCall call) {
        try {
            JSArray ids = call.getArray("ids");
            Set<String> set = new HashSet<>();
            if (ids != null) {
                for (int i = 0; i < ids.length(); i++) set.add(ids.getString(i));
            }
            NativeQueue.remove(getContext(), set);
            call.resolve();
        } catch (JSONException e) {
            call.reject("Invalid ids.", e);
        }
    }

    // ---------------------------------------------------------------- file export

    /**
     * Saves a text file (CSV / JSON backup). WebView blob downloads do not work inside a
     * Capacitor app, so exports go through here: Downloads/MoneyTrack on Android 10+,
     * the app's own external files folder on older versions (no storage permission needed).
     */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("filename", "moneytrack-export.txt");
        String mime = call.getString("mimeType", "text/plain");
        String data = call.getString("data", "");
        if (name == null) name = "moneytrack-export.txt";
        name = name.replaceAll("[^A-Za-z0-9._\\-]", "_");
        if (data == null) data = "";
        byte[] bytes = data.getBytes(StandardCharsets.UTF_8);

        try {
            String location;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/MoneyTrack");
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IOException("Could not create file in Downloads.");
                try (OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) throw new IOException("Could not open file for writing.");
                    out.write(bytes);
                }
                location = "Downloads/MoneyTrack/" + name;
            } else {
                File dir = new File(getContext().getExternalFilesDir(null), "exports");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("Could not create export folder.");
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                location = file.getAbsolutePath();
            }
            JSObject result = new JSObject();
            result.put("location", location);
            call.resolve(result);
        } catch (IOException | RuntimeException e) {
            call.reject("Could not save the file.", e);
        }
    }
}
